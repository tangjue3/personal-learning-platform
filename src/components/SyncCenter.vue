<script setup>
import { computed, onMounted, ref } from 'vue'
import Icon from './Icon.vue'
import { getLocalRecords, importLocalEvents, localDataState, refreshLocalDataState, synchronizeCourses } from '../services/localDataStore.js'

const isOpen = ref(false)
const busy = ref(false)
const errorMessage = ref('')
const notice = ref('')
const backupInput = ref(null)
const backupBusy = ref(false)
const backupError = ref('')
const backupNotice = ref('')
const backupPreview = ref(null)
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

async function inspectBackup(event) {
  const file = event.target.files?.[0]
  event.target.value = ''
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
    const skipped = preview.conflicts + Number(result.skipped || 0)
    backupNotice.value = `恢复完成：新增 ${result.imported} 条，跳过 ${skipped} 条已存在记录；现有内容没有被覆盖。`
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

        <div v-if="!localDataState.serviceAvailable" class="sync-center-offline">
          <p>{{ localDataState.error || '平台本机数据服务还没有启动。' }}</p>
          <code>npm run dev:app</code>
          <button class="button button-secondary" :disabled="busy" @click="refreshLocalDataState">重新连接</button>
        </div>

        <div v-else class="sync-center-content">
          <section class="local-data-card">
            <div class="sync-git-title"><span>个人学习数据</span><span>仅保存在本机</span></div>
            <p>日程、待办、笔记、复习卡和阅读进度保存在这台电脑，不会上传或同步到 GitHub。</p>
            <small>本机记录 {{ localRecordCount }} 条 · 数据文件位于项目的 data/local 目录</small>
            <small>EPUB/PDF 原文件位于 data/local/ebooks/，同样只在本机</small>
            <div class="local-backup-actions">
              <button class="local-backup-button" type="button" :disabled="backupBusy" @click="downloadLocalBackup"><Icon name="download" size="14" />{{ backupBusy ? '正在处理…' : '下载备份' }}</button>
              <button class="local-backup-button" type="button" :disabled="backupBusy" @click="backupInput?.click()"><Icon name="upload" size="14" />从备份恢复</button>
              <input ref="backupInput" class="local-backup-input" type="file" accept=".json,application/json" @change="inspectBackup" />
            </div>
            <p class="local-backup-hint">记录备份只包含 data/local/records.json 里的个人记录，不包含 EPUB/PDF 原文件。电子书原文件保存在本机目录 data/local/ebooks/<书籍 ID>/，可在书架打开书籍管理并点“导出原文件”单独备份，或直接复制该目录。个人记录备份请保存在私人位置。</p>
            <div v-if="backupPreview" class="local-backup-preview">
              <strong>{{ backupPreview.fileName }}</strong>
              <span>共 {{ backupPreview.total }} 条；{{ backupPreview.conflicts }} 条与本机重名，将保留本机内容。</span>
              <div><button type="button" class="local-backup-cancel" :disabled="backupBusy" @click="cancelBackupRestore">取消</button><button type="button" class="local-backup-confirm" :disabled="backupBusy || !backupPreview.additions.length" @click="restoreLocalBackup">{{ backupBusy ? '恢复中…' : `恢复 ${backupPreview.additions.length} 条` }}</button></div>
            </div>
            <p v-if="backupNotice" class="sync-center-notice" role="status">{{ backupNotice }}</p>
            <p v-if="backupError" class="sync-center-error" role="alert">{{ backupError }}</p>
          </section>
          <div class="sync-git-card">
            <div class="sync-git-title"><span>课程书籍同步</span><span>{{ localDataState.git.branch || '未连接' }}</span></div>
            <p v-if="syncBlockReason" class="sync-git-description">{{ syncBlockReason }}</p>
            <p v-else class="sync-git-description">只同步 content/books 中的课程 Markdown 和书籍信息，个人学习数据不会进入同步范围。</p>
            <button class="button button-primary sync-now-button" :disabled="busy || localDataState.git.syncing || localDataState.git.saving || !localDataState.git.canSync" @click="syncNow"><Icon name="sync" size="16" />{{ busy || localDataState.git.syncing ? '正在同步课程…' : localDataState.git.saving ? '本机数据保存中…' : '同步课程到 GitHub' }}</button>
          </div>
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
.sync-center-dialog { width: min(100%, 425px); max-height: calc(100dvh - 40px); padding: 22px; overflow: auto; border: 1px solid rgba(255,255,255,.82); border-radius: 19px; background: #fff; box-shadow: 0 25px 76px rgba(30,45,68,.2); }
.sync-center-header { display: flex; align-items: center; gap: 12px; }
.sync-center-mark { width: 37px; height: 37px; display: grid; place-items: center; border-radius: 11px; color: #5688d0; background: #edf4ff; }
.sync-center-heading { flex: 1; }
.sync-center-heading .section-kicker { color: #8c9aad; font-size: 9px; }
.sync-center-heading h2 { margin: 4px 0 0; color: #2f3b4d; font-size: 17px; font-weight: 620; letter-spacing: -.03em; }
.sync-center-offline { display: grid; justify-items: start; gap: 14px; margin-top: 20px; }
.sync-center-offline p { margin: 0; color: #7e8998; font-size: 11px; line-height: 1.7; }
.sync-center-offline code { padding: 8px 10px; border-radius: 7px; color: #5a718e; background: #f3f6fa; font-size: 11px; }
.sync-center-offline .button { min-height: 35px; font-size: 10px; }
.sync-center-content { display: grid; gap: 14px; margin-top: 20px; }
.local-data-card, .sync-git-card { padding: 13px; border: 1px solid #e8edf2; border-radius: 12px; background: #fbfcfd; }
.local-data-card { border-color: #e5eee7; background: #f8fbf8; }
.sync-git-title { display: flex; justify-content: space-between; gap: 12px; color: #48566b; font-size: 10px; font-weight: 600; }
.sync-git-title span:last-child { color: #739179; font-weight: 500; }
.local-data-card p, .sync-git-description { margin: 8px 0 0; color: #7e8998; font-size: 10px; line-height: 1.7; }
.local-data-card small { display: block; margin-top: 9px; color: #98a3af; font-size: 9px; }
.local-backup-actions { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 12px; }
.local-backup-button { display: inline-flex; min-height: 32px; align-items: center; gap: 6px; padding: 0 9px; border: 1px solid #e2e8e3; border-radius: 8px; color: #647568; background: #fff; font: inherit; font-size: 9px; cursor: pointer; }
.local-backup-button:hover:not(:disabled) { border-color: #bfd2c2; color: #4f765b; background: #fbfdfb; }
.local-backup-button:disabled { cursor: wait; opacity: .55; }
.local-backup-input { display: none; }
.local-backup-hint { margin: 8px 0 0 !important; color: #9b9f99 !important; font-size: 9px !important; }
.local-backup-preview { display: grid; gap: 5px; margin-top: 11px; padding: 10px; border: 1px solid #e5eaf0; border-radius: 9px; background: #fff; }
.local-backup-preview > strong { overflow: hidden; color: #5e6978; font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }
.local-backup-preview > span { color: #8993a0; font-size: 9px; line-height: 1.6; }
.local-backup-preview > div { display: flex; justify-content: flex-end; gap: 6px; margin-top: 4px; }
.local-backup-preview button { min-height: 29px; padding: 0 9px; border: 0; border-radius: 7px; font: inherit; font-size: 9px; cursor: pointer; }
.local-backup-cancel { color: #78818c; background: #f1f3f5; }.local-backup-confirm { color: #fff; background: #5c8066; }
.local-backup-preview button:disabled { cursor: not-allowed; opacity: .45; }
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
