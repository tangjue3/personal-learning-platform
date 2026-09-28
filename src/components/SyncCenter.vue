<script setup>
import { computed, onMounted, ref } from 'vue'
import Icon from './Icon.vue'
import { createLocalBackup as createDeviceSnapshot, getLocalRecords, importLocalEvents, listLocalBackups, localDataState, refreshLocalDataState, restoreLocalBackup as restoreDeviceSnapshot, synchronizeCourses } from '../services/localDataStore.js'

const isOpen = ref(false)
const busy = ref(false)
const errorMessage = ref('')
const notice = ref('')
const backupInput = ref(null)
const backupBusy = ref(false)
const backupError = ref('')
const backupNotice = ref('')
const backupPreview = ref(null)
const localBackups = ref([])
const backupListBusy = ref(false)
const snapshotError = ref('')
const snapshotNotice = ref('')
const snapshotRestorePreview = ref(null)
const recordKinds = ['calendar', 'task', 'note', 'review', 'reader', 'preference']
const localRecordCount = computed(() => ['calendar', 'task', 'note', 'review', 'reader', 'preference']
  .reduce((count, kind) => count + getLocalRecords(kind).length, 0))

const buttonLabel = computed(() => {
  if (!localDataState.serviceAvailable) return '本机服务未连接'
  if (localDataState.git.syncing) return '正在同步课程…'
  return localDataState.git.saving ? '正在保存本机数据…' : '本机保存'
})
const syncBlockReason = computed(() => {
  const git = localDataState.git
  if (git.syncing) return '课程同步正在进行。'
  if (git.saving) return '本机数据正在保存，保存完成后即可同步课程。'
  if (!git.isRepository) return '当前目录还不是 Git 仓库。'
  if (!git.hasRemote || !git.hasUpstream) return '当前分支尚未关联 GitHub 上游。'
  if (git.hasUnmanagedChanges) return '仓库有课程内容以外的改动，请先单独整理后再同步课程。'
  return ''
})

onMounted(() => { void refreshLocalDataState() })

function openCenter() {
  isOpen.value = true
  errorMessage.value = ''
  notice.value = ''
  void refreshLocalDataState()
  void refreshLocalBackups()
}

function closeCenter() {
  if (busy.value || backupBusy.value) return
  isOpen.value = false
}

async function downloadLocalBackup() {
  if (backupBusy.value) return
  backupBusy.value = true
  backupError.value = ''
  backupNotice.value = ''
  try {
    await refreshLocalDataState()
    if (!localDataState.serviceAvailable) throw new Error(localDataState.error || '本机数据服务未连接。')
    const records = Object.fromEntries(recordKinds.map((kind) => [kind, getLocalRecords(kind)]))
    const backup = {
      format: 'zhixu-local-learning-backup',
      version: 1,
      exportedAt: new Date().toISOString(),
      records,
    }
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `zhixu-local-backup-${new Date().toISOString().slice(0, 10)}.json`
    link.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 30000)
    backupNotice.value = `已导出 ${recordKinds.reduce((count, kind) => count + records[kind].length, 0)} 条个人记录。`
  } catch (error) {
    backupError.value = error?.message || '备份文件生成失败。'
  } finally {
    backupBusy.value = false
  }
}

async function refreshLocalBackups() {
  backupListBusy.value = true
  snapshotError.value = ''
  try {
    localBackups.value = await listLocalBackups()
  } catch (error) {
    snapshotError.value = error?.message || '无法读取本机快照列表。'
  } finally {
    backupListBusy.value = false
  }
}

async function saveDeviceSnapshot() {
  if (backupBusy.value) return
  backupBusy.value = true
  backupPreview.value = null
  snapshotRestorePreview.value = null
  snapshotError.value = ''
  snapshotNotice.value = ''
  try {
    const backup = await createDeviceSnapshot()
    await refreshLocalBackups()
    snapshotNotice.value = `快照已保存：${formatBackupDate(backup.createdAt)}，包含 ${backup.recordCount ?? '无法读取'} 条个人记录和 ${backup.ebookCount} 本电子书。`
  } catch (error) {
    snapshotError.value = error?.message || '本机快照创建失败。'
  } finally {
    backupBusy.value = false
  }
}

function previewDeviceRestore(backup) {
  if (!backup.recordsValid) return
  backupPreview.value = null
  backupError.value = ''
  snapshotRestorePreview.value = backup
  snapshotError.value = ''
  snapshotNotice.value = ''
}

async function restoreDeviceSnapshotNow() {
  const backup = snapshotRestorePreview.value
  if (!backup || backupBusy.value) return
  backupBusy.value = true
  snapshotError.value = ''
  snapshotNotice.value = ''
  try {
    const result = await restoreDeviceSnapshot(backup.id)
    snapshotRestorePreview.value = null
    await Promise.all([refreshLocalDataState(), refreshLocalBackups()])
    window.dispatchEvent(new CustomEvent('zhixu:local-backup-restored'))
    snapshotNotice.value = `已恢复 ${result.recordCount} 条个人记录和 ${result.ebookCount} 本电子书。恢复前的当前数据已另存为安全快照。`
  } catch (error) {
    snapshotError.value = error?.message || '快照恢复失败，当前数据未完成替换。'
  } finally {
    backupBusy.value = false
  }
}

function cancelDeviceRestore() {
  snapshotRestorePreview.value = null
}

function formatBackupDate(value) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '时间未知' : new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

function backupReasonLabel(reason) {
  return ({ manual: '手动保存', automatic: '每日自动', 'before-restore': '恢复前安全点' })[reason] || '本机快照'
}

async function inspectBackup(event) {
  const file = event.target.files?.[0]
  event.target.value = ''
  snapshotRestorePreview.value = null
  backupPreview.value = null
  backupError.value = ''
  backupNotice.value = ''
  if (!file) return
  if (file.size > 25 * 1024 * 1024) {
    backupError.value = '备份文件不能超过 25 MB。'
    return
  }

  try {
    const backup = JSON.parse(await file.text())
    if (backup?.format !== 'zhixu-local-learning-backup' || backup.version !== 1 || !backup.records || typeof backup.records !== 'object') {
      throw new Error('这不是知序支持的本机记录备份文件。')
    }
    const unknownKinds = Object.keys(backup.records).filter((kind) => !recordKinds.includes(kind))
    if (unknownKinds.length) throw new Error('备份中包含当前版本不支持的记录类型。')

    const identities = new Set()
    const events = []
    const counts = Object.fromEntries(recordKinds.map((kind) => [kind, 0]))
    for (const kind of recordKinds) {
      const records = backup.records[kind] ?? []
      if (!Array.isArray(records)) throw new Error('备份结构不完整，请重新导出备份文件。')
      for (const record of records) {
        if (!record || typeof record !== 'object' || Array.isArray(record) || typeof record.id !== 'string' || !/^[a-zA-Z0-9._-]{1,120}$/.test(record.id)) {
          throw new Error('备份中有记录标识不合法，未导入任何数据。')
        }
        const identity = `${kind}:${record.id}`
        if (identities.has(identity)) throw new Error('备份中包含重复记录，未导入任何数据。')
        identities.add(identity)
        const { id, updatedAt, ...data } = record
        if (new TextEncoder().encode(JSON.stringify(data)).byteLength > 256 * 1024) throw new Error('备份中的单条记录超过 256 KB，未导入任何数据。')
        events.push({ kind, entityId: id, operation: 'upsert', data })
        counts[kind] += 1
      }
    }

    const current = new Set(recordKinds.flatMap((kind) => getLocalRecords(kind).map((record) => `${kind}:${record.id}`)))
    const additions = events.filter((item) => !current.has(`${item.kind}:${item.entityId}`))
    const conflicts = events.length - additions.length
    backupPreview.value = { fileName: file.name, total: events.length, conflicts, additions, counts }
    if (!additions.length) backupNotice.value = events.length ? '备份里的记录已经存在于本机，没有覆盖任何内容。' : '这个备份文件没有个人记录。'
  } catch (error) {
    backupError.value = error?.message || '无法读取这个备份文件。'
  }
}

async function restoreLocalBackup() {
  const preview = backupPreview.value
  if (!preview?.additions?.length || backupBusy.value) return
  backupBusy.value = true
  backupError.value = ''
  backupNotice.value = ''
  try {
    const result = await importLocalEvents(preview.additions)
    await refreshLocalBackups()
    const skipped = preview.conflicts + Number(result.skipped || 0)
    const safetyNote = result.preRestoreBackupId ? '恢复前已创建本机安全快照。' : ''
    backupNotice.value = `恢复完成：新增 ${result.imported} 条，跳过 ${skipped} 条已存在记录。${safetyNote}`
    backupPreview.value = null
  } catch (error) {
    backupError.value = error?.message || '恢复失败，本机记录没有被部分写入。'
  } finally {
    backupBusy.value = false
  }
}

function cancelBackupRestore() {
  backupPreview.value = null
  backupError.value = ''
  if (backupInput.value) backupInput.value.value = ''
}

async function syncNow() {
  busy.value = true
  errorMessage.value = ''
  notice.value = ''
  try {
    const result = await synchronizeCourses()
    notice.value = result.message || '课程同步完成。'
    window.dispatchEvent(new CustomEvent('zhixu:sync-complete'))
  } catch (error) {
    errorMessage.value = error.message
    await refreshLocalDataState()
  } finally {
    busy.value = false
  }
}

function handleEscape(event) {
  if (event.key === 'Escape') closeCenter()
}
</script>

<template>
  <div class="sync-center">
    <button class="sync-center-trigger" :class="{ 'is-ready': localDataState.serviceAvailable, 'is-offline': !localDataState.serviceAvailable }" @click="openCenter">
      <span class="sync-center-dot"></span>
      <span>{{ buttonLabel }}</span>
      <Icon name="chevronDown" size="13" />
    </button>

    <div v-if="isOpen" class="sync-center-backdrop" @click.self="closeCenter" @keydown.esc="handleEscape">
      <section class="sync-center-dialog" role="dialog" aria-modal="true" aria-labelledby="sync-center-title">
        <header class="sync-center-header">
          <div class="sync-center-mark"><Icon name="sync" size="19" /></div>
          <div class="sync-center-heading"><span class="section-kicker">本机保存 · 按需同步课程</span><h2 id="sync-center-title">数据与同步</h2></div>
          <button class="icon-button" aria-label="关闭" @click="closeCenter"><Icon name="close" size="18" /></button>
        </header>

        <div class="sync-center-content">
          <section class="local-data-card">
            <div class="sync-git-title"><span>个人学习数据</span><span>{{ localDataState.serviceAvailable ? '仅保存在本机' : '本机数据服务异常' }}</span></div>
            <p v-if="localDataState.serviceAvailable">日程、待办、笔记、复习卡和阅读进度保存在 data/local/records.json，EPUB/PDF 原文件在 data/local/ebooks/。它们不会上传或同步到 GitHub。</p>
            <p v-else class="local-data-warning">{{ localDataState.error || '本机数据服务还没有启动。' }} 本机快照仍保存在本机目录；重新连接后即可预览并恢复。</p>
            <small v-if="localDataState.serviceAvailable">当前个人记录 {{ localRecordCount }} 条 · 本机数据目录 data/local/</small>
            <small>本机快照位于 data/local/backups/，最多保留最近 30 份；有个人数据时每天自动保存一次。</small>
            <div class="local-backup-actions">
              <button class="local-backup-button is-primary" type="button" :disabled="backupBusy || !localDataState.serviceAvailable" @click="saveDeviceSnapshot">{{ backupBusy ? '正在处理…' : '保存本机快照' }}</button>
              <button class="local-backup-button" type="button" :disabled="backupBusy || !localDataState.serviceAvailable" @click="downloadLocalBackup"><Icon name="download" size="14" />导出记录 JSON</button>
              <button class="local-backup-button" type="button" :disabled="backupBusy || !localDataState.serviceAvailable" @click="backupInput?.click()"><Icon name="upload" size="14" />导入记录 JSON</button>
              <input ref="backupInput" class="local-backup-input" type="file" accept=".json,application/json" @change="inspectBackup" />
            </div>
            <p class="local-backup-hint">“记录 JSON”只包含个人记录；“本机快照”同时保存记录和 EPUB/PDF 原文件，可在下面按版本完整恢复。这些数据都留在本机目录，不进入 Git。</p>
            <div class="snapshot-list-heading"><strong>本机快照</strong><span>自动与手动保存</span></div>
            <div class="snapshot-list" aria-live="polite">
              <p v-if="backupListBusy" class="snapshot-empty">正在读取快照…</p>
              <p v-else-if="!localBackups.length && !snapshotError" class="snapshot-empty">还没有本机快照。保存一次，或在下次启动时由平台自动创建。</p>
              <article v-for="backup in localBackups" :key="backup.id" class="snapshot-item" :class="{ 'is-selected': snapshotRestorePreview?.id === backup.id }">
                <div class="snapshot-item-copy">
                  <strong>{{ formatBackupDate(backup.createdAt) }}</strong>
                  <span>{{ backupReasonLabel(backup.reason) }} · {{ backup.recordsValid ? `${backup.recordCount ?? 0} 条记录` : '记录文件无法验证' }} · {{ backup.ebookCount }} 本电子书</span>
                </div>
                <button type="button" class="snapshot-restore-button" :disabled="backupBusy || !backup.recordsValid" :title="backup.recordsValid ? '预览并恢复这份快照' : '记录文件无法验证，不能恢复'" @click="previewDeviceRestore(backup)">{{ backup.recordsValid ? '恢复' : '不可恢复' }}</button>
              </article>
            </div>
            <p v-if="snapshotError" class="sync-center-error" role="alert">{{ snapshotError }}</p>
            <p v-if="snapshotNotice" class="sync-center-notice" role="status">{{ snapshotNotice }}</p>
            <div v-if="snapshotRestorePreview" class="local-backup-preview snapshot-restore-preview">
              <strong>恢复到 {{ formatBackupDate(snapshotRestorePreview.createdAt) }}？</strong>
              <span>这会用快照中的 {{ snapshotRestorePreview.recordCount ?? 0 }} 条个人记录和 {{ snapshotRestorePreview.ebookCount }} 本电子书替换当前本机数据。恢复前平台会再保存一份当前数据快照，课程书籍不受影响。</span>
              <div><button type="button" class="local-backup-cancel" :disabled="backupBusy" @click="cancelDeviceRestore">取消</button><button type="button" class="local-backup-confirm" :disabled="backupBusy" @click="restoreDeviceSnapshotNow">{{ backupBusy ? '恢复中…' : '确认恢复' }}</button></div>
            </div>
            <div v-if="backupPreview" class="local-backup-preview">
              <strong>{{ backupPreview.fileName }}</strong>
              <span>共 {{ backupPreview.total }} 条；{{ backupPreview.conflicts }} 条与本机重名，将保留本机内容。</span>
              <div><button type="button" class="local-backup-cancel" :disabled="backupBusy" @click="cancelBackupRestore">取消</button><button type="button" class="local-backup-confirm" :disabled="backupBusy || !backupPreview.additions.length" @click="restoreLocalBackup">{{ backupBusy ? '恢复中…' : `恢复 ${backupPreview.additions.length} 条` }}</button></div>
            </div>
            <p v-if="backupNotice" class="sync-center-notice" role="status">{{ backupNotice }}</p>
            <p v-if="backupError" class="sync-center-error" role="alert">{{ backupError }}</p>
          </section>
          <div v-if="localDataState.serviceAvailable" class="sync-git-card">
            <div class="sync-git-title"><span>课程书籍同步</span><span>{{ localDataState.git.branch || '未连接' }}</span></div>
            <p v-if="syncBlockReason" class="sync-git-description">{{ syncBlockReason }}</p>
            <p v-else class="sync-git-description">只同步 content/books 中的课程 Markdown 和书籍信息，个人学习数据不会进入同步范围。</p>
            <button class="button button-primary sync-now-button" :disabled="busy || localDataState.git.syncing || localDataState.git.saving || !localDataState.git.canSync" @click="syncNow"><Icon name="sync" size="16" />{{ busy || localDataState.git.syncing ? '正在同步课程…' : localDataState.git.saving ? '本机数据保存中…' : '同步课程到 GitHub' }}</button>
          </div>
          <div v-else class="sync-center-offline"><p>创建或恢复快照、记录 JSON 导入导出和课程同步都需要本机数据服务。</p><small>请先在项目目录重新运行以下命令，再回到这里恢复本机快照。</small><code>npm run dev:app</code><button class="button button-secondary" :disabled="busy" @click="refreshLocalDataState">重新连接</button></div>
          <p v-if="notice" class="sync-center-notice" role="status">{{ notice }}</p>
          <p v-if="errorMessage" class="sync-center-error" role="alert">{{ errorMessage }}</p>
          <p class="sync-center-footnote">课程文件是否公开，取决于 GitHub 仓库的可见性设置。</p>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.sync-center { position: relative; }
.sync-center-trigger { display: inline-flex; align-items: center; gap: 7px; min-height: 34px; padding: 0 10px; border: 1px solid #e9edf2; border-radius: 9px; color: #718096; background: rgba(255,255,255,.78); font: inherit; font-size: 10px; cursor: pointer; transition: all .16s ease; }
.sync-center-trigger:hover { border-color: #d6e1ef; color: #4976b8; background: #fff; }
.sync-center-trigger.is-ready { color: #567e62; }
.sync-center-trigger.is-offline { color: #a17868; }
.sync-center-dot { width: 6px; height: 6px; border-radius: 50%; background: #bd9b72; }
.is-ready .sync-center-dot { background: #69a47a; box-shadow: 0 0 0 3px rgba(105,164,122,.1); }
.is-offline .sync-center-dot { background: #ca8c75; }
.sync-center-backdrop { position: fixed; z-index: 120; inset: 0; display: grid; place-items: center; padding: 20px; background: rgba(27,37,51,.28); backdrop-filter: blur(7px); }
.sync-center-dialog { width: min(100%, 485px); max-height: calc(100dvh - 40px); padding: 22px; overflow: auto; border: 1px solid rgba(255,255,255,.82); border-radius: 19px; background: #fff; box-shadow: 0 25px 76px rgba(30,45,68,.2); }
.sync-center-header { display: flex; align-items: center; gap: 12px; }
.sync-center-mark { width: 37px; height: 37px; display: grid; place-items: center; border-radius: 11px; color: #5688d0; background: #edf4ff; }
.sync-center-heading { flex: 1; }
.sync-center-heading .section-kicker { color: #8c9aad; font-size: 9px; }
.sync-center-heading h2 { margin: 4px 0 0; color: #2f3b4d; font-size: 17px; font-weight: 620; letter-spacing: -.03em; }
.sync-center-offline { display: grid; justify-items: start; gap: 14px; margin-top: 20px; }
.sync-center-offline p { margin: 0; color: #7e8998; font-size: 11px; line-height: 1.7; }
.sync-center-offline small { color: #909baa; font-size: 10px; line-height: 1.6; }
.sync-center-offline code { padding: 8px 10px; border-radius: 7px; color: #5a718e; background: #f3f6fa; font-size: 11px; }
.sync-center-offline .button { min-height: 35px; font-size: 10px; }
.sync-center-content { display: grid; gap: 14px; margin-top: 20px; }
.local-data-card, .sync-git-card { padding: 13px; border: 1px solid #e8edf2; border-radius: 12px; background: #fbfcfd; }
.local-data-card { border-color: #e5eee7; background: #f8fbf8; }
.sync-git-title { display: flex; justify-content: space-between; gap: 12px; color: #48566b; font-size: 10px; font-weight: 600; }
.sync-git-title span:last-child { color: #739179; font-weight: 500; }
.local-data-card p, .sync-git-description { margin: 8px 0 0; color: #7e8998; font-size: 10px; line-height: 1.7; }
.local-data-card .local-data-warning { color: #ad7463; }
.local-data-card small { display: block; margin-top: 9px; color: #98a3af; font-size: 9px; }
.local-backup-actions { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 12px; }
.local-backup-button { display: inline-flex; min-height: 34px; align-items: center; gap: 6px; padding: 0 10px; border: 1px solid #e2e8e3; border-radius: 8px; color: #647568; background: #fff; font: inherit; font-size: 10px; cursor: pointer; }
.local-backup-button.is-primary { border-color: #63856b; color: #fff; background: #63856b; }
.local-backup-button:hover:not(:disabled) { border-color: #bfd2c2; color: #4f765b; background: #fbfdfb; }
.local-backup-button.is-primary:hover:not(:disabled) { border-color: #4d7156; color: #fff; background: #4d7156; }
.local-backup-button:disabled { cursor: wait; opacity: .55; }
.local-backup-input { display: none; }
.local-backup-hint { margin: 9px 0 0 !important; color: #89968d !important; font-size: 10px !important; }
.snapshot-list-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 15px; color: #536457; }
.snapshot-list-heading strong { font-size: 10px; font-weight: 650; }
.snapshot-list-heading span { color: #99a49b; font-size: 9px; }
.snapshot-list { display: grid; max-height: 205px; gap: 6px; margin-top: 8px; overflow: auto; overscroll-behavior: contain; }
.snapshot-empty { margin: 0; padding: 12px; border: 1px dashed #dce7dd; border-radius: 9px; color: #89968d; font-size: 10px; line-height: 1.6; }
.snapshot-item { display: flex; align-items: center; gap: 12px; padding: 9px 10px; border: 1px solid #e8eee8; border-radius: 9px; background: rgba(255,255,255,.84); }
.snapshot-item.is-selected { border-color: #93b19a; background: #f4f8f4; }
.snapshot-item-copy { display: grid; min-width: 0; flex: 1; gap: 3px; }
.snapshot-item-copy strong { overflow: hidden; color: #4d5b50; font-size: 10px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.snapshot-item-copy span { color: #909b91; font-size: 9px; line-height: 1.45; }
.snapshot-restore-button { flex: none; min-width: 54px; min-height: 28px; padding: 0 8px; border: 1px solid #d9e4da; border-radius: 7px; color: #5b7960; background: #fff; font: inherit; font-size: 9px; cursor: pointer; }
.snapshot-restore-button:hover:not(:disabled) { border-color: #99b49e; background: #f6faf6; }
.snapshot-restore-button:disabled { color: #aaa; cursor: not-allowed; }
.local-backup-preview { display: grid; gap: 5px; margin-top: 11px; padding: 10px; border: 1px solid #e5eaf0; border-radius: 9px; background: #fff; }
.local-backup-preview > strong { overflow: hidden; color: #5e6978; font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }
.local-backup-preview > span { color: #8993a0; font-size: 9px; line-height: 1.6; }
.local-backup-preview > div { display: flex; justify-content: flex-end; gap: 6px; margin-top: 4px; }
.local-backup-preview button { min-height: 29px; padding: 0 9px; border: 0; border-radius: 7px; font: inherit; font-size: 9px; cursor: pointer; }
.local-backup-cancel { color: #78818c; background: #f1f3f5; }.local-backup-confirm { color: #fff; background: #5c8066; }
.local-backup-preview button:disabled { cursor: not-allowed; opacity: .45; }
.snapshot-restore-preview { border-color: #e7d5b9; background: #fffcf7; }
.snapshot-restore-preview > strong { color: #7b6242; }
.snapshot-restore-preview > span { color: #897d6b; }
.sync-git-description { margin-bottom: 12px; }
.sync-now-button { width: 100%; min-height: 37px; gap: 7px; font-size: 10px; }
.sync-now-button:disabled { opacity: .55; cursor: wait; }
.sync-center-notice, .sync-center-error { margin: 0; font-size: 10px; line-height: 1.6; }
.sync-center-notice { color: #548268; }
.sync-center-error { color: #b65f58; }
.sync-center-footnote { margin: 0; color: #9ba5b2; font-size: 9px; line-height: 1.6; }
@media (max-width: 640px) {
  .sync-center-trigger { min-height: 30px; padding: 0 7px; font-size: 0; }
  .sync-center-trigger > span:nth-child(2) { display: none; }
  .sync-center-trigger :deep(svg) { width: 12px; }
  .sync-center-backdrop { align-items: end; padding: 0; }
  .sync-center-dialog { width: 100%; box-sizing: border-box; padding: 20px 18px max(20px, env(safe-area-inset-bottom)); border-radius: 19px 19px 0 0; }
  .sync-center-dialog { max-height: 92dvh; }
}
</style>
