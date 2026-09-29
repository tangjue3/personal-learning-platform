<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Icon from './Icon.vue'
import MarkdownNoteInput from './MarkdownNoteInput.vue'
import { deleteLocalRecord, getLocalRecords, saveLocalRecord } from '../services/localDataStore.js'

const props = defineProps({ books: { type: Array, default: () => [] } })
const emit = defineEmits(['open-book', 'open-calendar', 'open-shelf'])
const query = ref('')
const selectedId = ref('')
const draft = ref({ title: '', body: '', icon: '📄' })
const baseline = ref('')
const loading = ref(false)
const saving = ref(false)
const saveState = ref('saved')
const error = ref('')
const taskTitle = ref('')
const taskSaving = ref(false)
const taskError = ref('')
let saveTimer = null

const pages = computed(() => getLocalRecords('workspace')
  .filter((page) => typeof page.title === 'string')
  .sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || ''))))
const selectedPage = computed(() => pages.value.find((page) => page.id === selectedId.value) || null)
const currentParent = computed(() => pages.value.find((page) => page.id === selectedPage.value?.parentId) || null)
const flatPages = computed(() => {
  const result = []
  const visited = new Set()
  const walk = (parentId, depth, ancestry) => {
    for (const page of pages.value.filter((item) => String(item.parentId || '') === parentId)) {
      if (visited.has(page.id) || ancestry.has(page.id)) continue
      visited.add(page.id)
      const hasChildren = pages.value.some((item) => item.parentId === page.id)
      result.push({ ...page, depth, hasChildren })
      const nextAncestry = new Set(ancestry)
      nextAncestry.add(page.id)
      walk(page.id, depth + 1, nextAncestry)
    }
  }
  walk('', 0, new Set())
  for (const page of pages.value) {
    if (visited.has(page.id)) continue
    visited.add(page.id)
    result.push({ ...page, depth: 0, hasChildren: pages.value.some((item) => item.parentId === page.id) })
    walk(page.id, 1, new Set([page.id]))
  }
  return result
})
const filteredPages = computed(() => {
  const search = query.value.trim().toLocaleLowerCase('zh-CN')
  return flatPages.value.filter((page) => !search || (page.title + ' ' + (page.body || '')).toLocaleLowerCase('zh-CN').includes(search))
})
const dirty = computed(() => JSON.stringify(draft.value) !== baseline.value)
const saveLabel = computed(() => saving.value ? '正在保存…' : saveState.value === 'error' ? '保存失败' : dirty.value ? '有未保存更改' : '已保存到本机')
const tasks = computed(() => getLocalRecords('task').filter((task) => !task.done)
  .sort((a, b) => ({ high: 0, normal: 1, low: 2 }[a.priority] ?? 1) - ({ high: 0, normal: 1, low: 2 }[b.priority] ?? 1)
    || String(a.dueDate || '9999-12-31').localeCompare(String(b.dueDate || '9999-12-31'))).slice(0, 5))
const events = computed(() => {
  const today = dateKey(new Date())
  return getLocalRecords('calendar').filter((event) => event.title && event.date >= today)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.start || '').localeCompare(String(b.start || ''))).slice(0, 3)
})
const recentBooks = computed(() => [...props.books].filter((book) => book.lastRead || book.lastReadAt)
  .sort((a, b) => String(b.lastReadAt || '').localeCompare(String(a.lastReadAt || ''))).slice(0, 3))

function dateKey(date) {
  return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0')
}
function newId() { return window.crypto?.randomUUID?.() || String(Date.now()) + '-' + Math.random().toString(36).slice(2) }
function loadPage(page) {
  loading.value = true
  selectedId.value = page?.id || ''
  draft.value = page ? { title: page.title || '', body: page.body || '', icon: page.icon || '📄' } : { title: '', body: '', icon: '📄' }
  baseline.value = JSON.stringify(draft.value)
  error.value = ''
  saveState.value = 'saved'
  loading.value = false
}
function queueSave() {
  if (saveTimer) window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => { saveTimer = null; void savePage() }, 700)
}
watch(() => [draft.value.title, draft.value.body, draft.value.icon], () => {
  if (loading.value || !selectedId.value) return
  if (!dirty.value) {
    if (saveTimer) window.clearTimeout(saveTimer)
    saveTimer = null
    saveState.value = 'saved'
    return
  }
  saveState.value = 'unsaved'
  queueSave()
}, { flush: 'sync' })

async function savePage() {
  if (!selectedId.value || !dirty.value) return true
  if (saving.value) return false
  if (saveTimer) window.clearTimeout(saveTimer)
  saveTimer = null
  const id = selectedId.value
  const snapshot = { ...draft.value }
  const title = snapshot.title.trim()
  if (!title) { error.value = '页面标题不能为空。'; saveState.value = 'error'; return false }
  const existing = pages.value.find((page) => page.id === id)
  const now = new Date().toISOString()
  const normalized = { ...snapshot, title }
  const recordData = { title, body: snapshot.body, icon: snapshot.icon || '📄', createdAt: existing?.createdAt || now, updatedAt: now }
  if (new Blob([JSON.stringify(recordData)]).size > 256 * 1024) {
    error.value = '单页不能超过 256 KB，请拆分成多个子页面。'
    saveState.value = 'error'
    return false
  }
  saving.value = true
  saveState.value = 'saving'
  error.value = ''
  try {
    await saveLocalRecord('workspace', id, {
      title, body: snapshot.body, icon: snapshot.icon || '📄',
      createdAt: existing?.createdAt || now, updatedAt: now,
    })
    baseline.value = JSON.stringify(normalized)
    if (JSON.stringify(draft.value) === JSON.stringify(snapshot)) {
      loading.value = true
      draft.value = normalized
      loading.value = false
    }
    saveState.value = dirty.value ? 'unsaved' : 'saved'
    return true
  } catch (reason) {
    error.value = reason?.message || '页面保存失败，请重试。'
    saveState.value = 'error'
    return false
  } finally {
    saving.value = false
    if (dirty.value && saveState.value !== 'error') queueSave()
  }
}
async function createPage(parentId = '') {
  if (saving.value) return
  if (selectedId.value && dirty.value && !(await savePage())) return
  const now = new Date().toISOString()
  const page = {
    title: '无标题页面',
    body: '## 学习目标\n\n写下这页要解决的问题。\n\n## 资料与记录\n\n整理课程链接、阅读摘录和自己的理解。\n\n## 下一步\n\n- [ ] 写下一件可以推进的小事\n',
    icon: '📄', parentId: pages.value.some((item) => item.id === parentId) ? parentId : '', createdAt: now, updatedAt: now,
  }
  const id = newId()
  query.value = ''
  saving.value = true
  saveState.value = 'saving'
  try {
    await saveLocalRecord('workspace', id, page)
    loadPage({ ...page, id })
  } catch (reason) {
    error.value = reason?.message || '无法创建工作台页面。'
    saveState.value = 'error'
  } finally { saving.value = false }
}
async function selectPage(page) {
  if (saving.value || page.id === selectedId.value) return
  if (dirty.value && !(await savePage())) return
  loadPage(page)
}
async function deletePage() {
  if (!selectedPage.value || saving.value) return
  if (dirty.value && !(await savePage())) return
  if (!window.confirm('确定删除页面「' + selectedPage.value.title + '」吗？此操作无法撤销。')) return
  const deletedId = selectedPage.value.id
  saving.value = true
  try {
    await deleteLocalRecord('workspace', deletedId)
    const next = getLocalRecords('workspace').filter((page) => page.id !== deletedId)
      .sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')))[0]
    loadPage(next || null)
  } catch (reason) {
    error.value = reason?.message || '删除页面失败。'
    saveState.value = 'error'
  } finally { saving.value = false }
}
function insertBlock(type) {
  const block = { heading: '\n\n## 新标题\n', task: '\n\n- [ ] 新任务\n', quote: '\n\n> 写下一个想法\n', divider: '\n\n---\n' }[type]
  draft.value.body = String(draft.value.body || '').trimEnd() + block
}
async function addTask() {
  const title = taskTitle.value.trim()
  if (!title || taskSaving.value) return
  taskSaving.value = true
  taskError.value = ''
  try {
    await saveLocalRecord('task', newId(), { title: title.slice(0, 120), done: false, dueDate: dateKey(new Date()), priority: 'normal', createdAt: new Date().toISOString() })
    taskTitle.value = ''
  } catch (reason) { taskError.value = reason?.message || '待办保存失败。' }
  finally { taskSaving.value = false }
}
async function finishTask(task) {
  if (taskSaving.value) return
  taskSaving.value = true
  taskError.value = ''
  try {
    const { id, updatedAt, ...data } = task
    await saveLocalRecord('task', id, { ...data, done: true, doneAt: new Date().toISOString() })
  } catch (reason) { taskError.value = reason?.message || '待办更新失败。' }
  finally { taskSaving.value = false }
}
function formatDate(value) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '刚刚' : new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric' }).format(date)
}
function eventDate(value) { return value === dateKey(new Date()) ? '今天' : formatDate(String(value) + 'T12:00:00') }
function pagePreview(page) { return String(page.body || '').replace(/[#>*_~\[\]-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 72) || '还没有内容' }
async function focusPageById(id) {
  const page = pages.value.find((item) => item.id === id)
  if (!page) return false
  if (dirty.value && !(await savePage())) return false
  loadPage(page)
  return true
}function saveShortcut(event) {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void savePage() }
}
onMounted(() => { if (pages.value[0]) loadPage(pages.value[0]); window.addEventListener('keydown', saveShortcut) })
onBeforeUnmount(() => {
  window.removeEventListener('keydown', saveShortcut)
  if (saveTimer) window.clearTimeout(saveTimer)
  if (dirty.value) void savePage()
})
defineExpose({ focusPageById })
</script>

<template>
  <main class="page-content workbench-page">
    <header class="page-heading workbench-heading">
      <div><span class="eyebrow-label"><span class="eyebrow-line"></span> 个人学习空间</span><h1>工作台</h1><p>把学习计划、想法和正在阅读的内容，放在一个顺手的地方。</p></div>
      <button class="button button-primary" :disabled="saving" @click="createPage"><Icon name="plus" size="16" /> 新建页面</button>
    </header>
    <div class="workbench-layout">
      <aside class="workbench-page-panel">
        <div class="workbench-panel-heading"><div><span class="section-kicker">我的页面</span><strong>{{ pages.length }}</strong></div><button class="icon-button" aria-label="新建工作台页面" :disabled="saving" @click="createPage"><Icon name="plus" size="16" /></button></div>
        <label class="workbench-page-search"><Icon name="search" size="15" /><input v-model="query" type="search" placeholder="搜索页面" aria-label="搜索工作台页面" /></label>
        <div v-if="filteredPages.length" class="workbench-page-list">
          <button v-for="page in filteredPages" :key="page.id" type="button" class="workbench-page-item" :style="{ marginLeft: (page.depth * 12) + 'px' }" :class="{ 'is-active': page.id === selectedId }" :aria-current="page.id === selectedId ? 'page' : undefined" :disabled="saving" @click="selectPage(page)"><span class="workbench-page-tree-marker" :class="{ 'is-child': page.depth }">{{ page.depth ? '↳' : page.hasChildren ? '⌄' : '' }}</span><span class="workbench-page-icon">{{ page.icon || '📄' }}</span><span class="workbench-page-copy"><strong>{{ page.title }}</strong><small>{{ pagePreview(page) }}</small></span></button>
        </div>
        <div v-else class="workbench-page-empty">{{ query ? '没有匹配页面' : '还没有页面' }}</div>
        <div class="workbench-local-note"><Icon name="lock" size="14" /> 页面只保存在这台电脑</div>
      </aside>

      <section v-if="selectedPage" class="workbench-editor-card surface-card">
        <div class="workbench-breadcrumb"><span>{{ currentParent?.title || '工作台' }}</span><Icon name="chevronRight" size="14" /><span class="workbench-breadcrumb-current">{{ draft.title || selectedPage.title }}</span><span class="workbench-save-status" :class="{ 'is-error': saveState === 'error' }"><i></i>{{ saveLabel }}</span></div>
        <div class="workbench-document">
          <div class="workbench-title-row"><span class="workbench-document-icon">{{ draft.icon }}</span><input v-model="draft.title" maxlength="120" aria-label="页面标题" placeholder="无标题页面" /><button type="button" class="icon-button workbench-child" aria-label="新建子页面" title="新建子页面" :disabled="saving" @click="createPage(selectedId)"><Icon name="plus" size="15" /></button><button class="icon-button workbench-delete" aria-label="删除当前页面" :disabled="saving" @click="deletePage"><Icon name="trash" size="16" /></button></div>
          <div class="workbench-page-meta">最后编辑于 {{ formatDate(selectedPage.updatedAt || selectedPage.createdAt) }} <span>·</span> 私人页面</div>
          <div class="workbench-block-toolbar" role="group" aria-label="插入内容块"><span>快速插入</span><button type="button" @click="insertBlock('heading')"><strong>H</strong> 标题</button><button type="button" @click="insertBlock('task')"><Icon name="check" size="13" /> 待办</button><button type="button" @click="insertBlock('quote')"><span class="quote-glyph">“</span> 引用</button><button type="button" @click="insertBlock('divider')">— 分隔线</button></div>
          <MarkdownNoteInput v-model="draft.body" :rows="18" placeholder="从一个想法开始。输入 Markdown，整理成自己的学习页面…" />
          <p v-if="error" class="workbench-error" role="alert">{{ error }} <button type="button" @click="savePage">重试</button></p>
          <div class="workbench-editor-footer"><span>自动保存到本机 · Ctrl/⌘ + S 手动保存</span><button class="button button-secondary" :disabled="saving || !dirty" @click="savePage">{{ saving ? '保存中…' : '保存页面' }}</button></div>
        </div>
      </section>
      <section v-else class="workbench-editor-empty surface-card"><span class="workbench-empty-icon"><Icon name="grid" size="24" /></span><h2>{{ pages.length ? '选择一个页面' : '从一张空白页面开始' }}</h2><p v-if="error" class="workbench-error" role="alert">{{ error }}</p><p>{{ pages.length ? '使用左侧页面列表切换，也可以创建一个新页面。' : '用页面整理一门课程、一个学习主题，或一段正在推进的计划。' }}</p><button class="button button-primary" :disabled="saving" @click="createPage"><Icon name="plus" size="15" /> 新建页面</button></section>

      <aside class="workbench-right-rail">
        <section class="workbench-widget surface-card">
          <header><div><span class="section-kicker">行动清单</span><h2>待办事项</h2></div><button class="text-button" @click="emit('open-calendar')">查看日历 <Icon name="arrowRight" size="14" /></button></header>
          <form class="workbench-task-form" @submit.prevent="addTask"><input v-model="taskTitle" maxlength="120" aria-label="添加一个待办" placeholder="添加一个待办…" :disabled="taskSaving" /><button type="submit" aria-label="保存待办" :disabled="taskSaving || !taskTitle.trim()"><Icon name="plus" size="16" /></button></form>
          <p v-if="taskError" class="workbench-error" role="alert">{{ taskError }}</p>
          <ul v-if="tasks.length" class="workbench-task-list"><li v-for="task in tasks" :key="task.id"><button type="button" class="workbench-task-check" :aria-label="'完成待办：' + task.title" :disabled="taskSaving" @click="finishTask(task)"><Icon name="check" size="13" /></button><span><strong>{{ task.title }}</strong><small>{{ task.dueDate || '未安排日期' }}<b v-if="task.priority === 'high'"> · 优先</b></small></span></li></ul>
          <p v-else class="workbench-widget-empty">待办清单已清空，给自己一点掌声。</p>
        </section>
        <section class="workbench-widget surface-card">
          <header><div><span class="section-kicker">接下来</span><h2>近期日程</h2></div><button class="icon-button" aria-label="打开日历" @click="emit('open-calendar')"><Icon name="arrowRight" size="15" /></button></header>
          <ul v-if="events.length" class="workbench-agenda-list"><li v-for="event in events" :key="event.id"><span class="workbench-agenda-date">{{ eventDate(event.date) }}<small>{{ event.start || '' }}</small></span><span class="workbench-agenda-copy"><strong>{{ event.title }}</strong><small>{{ event.category || '学习' }}</small></span></li></ul>
          <div v-else class="workbench-widget-empty">还没有近期日程。<button class="text-button" @click="emit('open-calendar')">去安排时间</button></div>
        </section>
        <section class="workbench-widget workbench-reading-widget surface-card">
          <header><div><span class="section-kicker">继续学习</span><h2>最近阅读</h2></div><button class="text-button" @click="emit('open-shelf')">书架 <Icon name="arrowRight" size="14" /></button></header>
          <button v-for="book in recentBooks" :key="book.id" type="button" class="workbench-book-link" @click="emit('open-book', book)"><span class="workbench-book-icon"><Icon name="shelf" size="15" /></span><span><strong>{{ book.title }}</strong><small>{{ book.currentChapter || ('阅读进度 ' + book.progress + '%') }}</small></span><Icon name="chevronRight" size="14" /></button>
          <p v-if="!recentBooks.length" class="workbench-widget-empty">读过的书会显示在这里。</p>
        </section>
      </aside>
    </div>
  </main>
</template>
<style scoped>
.workbench-heading { align-items:center; margin-bottom:20px; }
.workbench-heading h1 { margin-top:7px; }
.workbench-layout { display:grid; grid-template-columns:205px minmax(0,1fr) 245px; align-items:start; gap:14px; }
.workbench-page-panel { position:sticky; top:14px; display:grid; gap:10px; padding:12px 10px; border:1px solid #e7e9e5; border-radius:16px; background:rgba(255,255,255,.82); }
.workbench-panel-heading,.workbench-panel-heading>div { display:flex; align-items:center; justify-content:space-between; gap:8px; }
.workbench-panel-heading { padding:0 4px; }
.workbench-panel-heading>div strong { min-width:20px; height:20px; display:grid; place-items:center; border-radius:6px; color:#738096; background:#f0f3f0; font-size:11px; }
.workbench-panel-heading .icon-button { width:28px; height:28px; }
.workbench-page-search { height:34px; display:flex; align-items:center; gap:7px; padding:0 9px; border:1px solid #e8ebe7; border-radius:8px; color:#9ba4b0; background:white; }
.workbench-page-search input { width:100%; min-width:0; border:0; outline:0; color:#4c596b; background:transparent; font:inherit; font-size:12px; }
.workbench-page-list { display:grid; gap:3px; max-height:min(55vh,570px); overflow:auto; }
.workbench-page-item { width:auto; min-width:0; display:flex; align-items:flex-start; gap:9px; padding:9px 8px; border:0; border-radius:9px; color:#627083; background:transparent; text-align:left; cursor:pointer; }
.workbench-page-item:hover { background:#f4f6f3; }
.workbench-page-tree-marker { width:12px; flex:0 0 12px; color:#a0a9b3; font-size:12.5px; text-align:center; }
.workbench-page-tree-marker.is-child { color:#9eabb8; }
.workbench-child:hover { color:#4f7cac; background:#edf3f8; }
.workbench-page-item.is-active { color:#3f6eaa; background:#edf3fa; }
.workbench-page-icon { flex:0 0 auto; font-size:15px; }
.workbench-page-copy { min-width:0; display:grid; gap:4px; }
.workbench-page-copy strong,.workbench-page-copy small { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.workbench-page-copy strong { color:#445268; font-size:12.5px; font-weight:600; }
.workbench-page-copy small { color:#909aa7; font-size:12px; }
.workbench-page-empty { padding:13px 7px; color:#919ba7; font-size:12px; text-align:center; }
.workbench-local-note { display:flex; align-items:center; gap:7px; padding:10px 7px 0; border-top:1px solid #eceeea; color:#86918f; font-size:11px; }
.workbench-editor-card { min-width:0; overflow:hidden; }
.workbench-breadcrumb { min-height:44px; display:flex; align-items:center; gap:7px; padding:0 17px; border-bottom:1px solid #eef0ec; color:#8a95a1; font-size:12px; }
.workbench-breadcrumb-current { min-width:0; overflow:hidden; color:#586679; text-overflow:ellipsis; white-space:nowrap; }
.workbench-save-status { margin-left:auto; display:flex; flex:0 0 auto; align-items:center; gap:5px; color:#84938d; }
.workbench-save-status i { width:6px; height:6px; border-radius:50%; background:#82ac95; }
.workbench-save-status.is-error { color:#c06f65; }
.workbench-save-status.is-error i { background:#c06f65; }
.workbench-document { padding:22px clamp(15px,2.4vw,32px) 18px; }
.workbench-title-row { display:flex; align-items:center; gap:10px; }
.workbench-document-icon { width:33px; flex:0 0 33px; font-size:25px; }
.workbench-title-row input { width:100%; min-width:0; height:45px; border:0; outline:0; color:#283343; background:transparent; font:inherit; font-size:clamp(22px,2vw,30px); font-weight:650; letter-spacing:-.045em; }
.workbench-delete { opacity:.6; }
.workbench-delete:hover { opacity:1; color:#bd7167; }
.workbench-page-meta { margin:7px 0 19px 43px; color:#909aa5; font-size:11px; }
.workbench-page-meta span { margin:0 4px; color:#c1c7ce; }
.workbench-block-toolbar { display:flex; flex-wrap:wrap; align-items:center; gap:4px; margin:0 0 9px 43px; }
.workbench-block-toolbar>span { margin-right:4px; color:#9aa3ad; font-size:11px; }
.workbench-block-toolbar button { min-height:27px; display:inline-flex; align-items:center; gap:5px; padding:0 7px; border:1px solid transparent; border-radius:7px; color:#798596; background:transparent; font:inherit; font-size:11px; cursor:pointer; }
.workbench-block-toolbar button:hover { border-color:#e9ece8; color:#527ba9; background:#f8faf8; }
.workbench-block-toolbar button strong { color:#7288a2; font-size:12.5px; }
.workbench-document :deep(.markdown-note-editor) { border-color:#ebede9; background:white; }
.workbench-document :deep(.markdown-note-toolbar) { min-height:40px; background:#fbfcfa; }
.workbench-document :deep(.markdown-note-editor textarea) { min-height:380px; padding:21px 22px; font-size:13px; line-height:1.85; }
.workbench-document :deep(.markdown-note-preview) { min-height:380px; padding:22px clamp(18px,4vw,48px); font-size:13px; line-height:1.9; }
.workbench-editor-footer { display:flex; align-items:center; justify-content:space-between; gap:9px; margin:12px 0 0 43px; color:#929ca7; font-size:11px; }
.workbench-editor-footer .button { min-height:32px; padding:0 11px; font-size:11px; }
.workbench-error { margin:9px 0 0 43px; color:#b8665e; font-size:12px; }
.workbench-error button { border:0; color:#517caf; background:transparent; cursor:pointer; }
.workbench-editor-empty { min-height:460px; display:grid; justify-items:center; align-content:center; padding:28px; text-align:center; }
.workbench-editor-empty .workbench-error { margin:12px 0; }
.workbench-empty-icon { width:48px; height:48px; display:grid; place-items:center; border-radius:15px; color:#6283ad; background:#eef3f8; }
.workbench-editor-empty h2 { margin:15px 0 6px; color:#354155; font-size:17px; }
.workbench-editor-empty p { max-width:360px; margin:0 0 16px; color:#8994a2; font-size:12.5px; line-height:1.7; }
.workbench-right-rail { display:grid; gap:12px; }
.workbench-widget { min-width:0; padding:15px; border-radius:16px; }
.workbench-widget header { display:flex; align-items:center; justify-content:space-between; gap:8px; }
.workbench-widget header h2 { margin:5px 0 0; color:#39465a; font-size:13px; font-weight:620; }
.workbench-widget header .text-button { flex:0 0 auto; font-size:11px; }
.workbench-task-form { display:flex; gap:5px; margin-top:12px; }
.workbench-task-form input { width:100%; min-width:0; height:34px; padding:0 9px; border:1px solid #e7eae6; border-radius:8px; color:#4e5a6b; background:#fbfcfa; font:inherit; font-size:12px; }
.workbench-task-form button { width:34px; flex:0 0 34px; display:grid; place-items:center; border:0; border-radius:8px; color:white; background:#648aba; cursor:pointer; }
.workbench-task-list,.workbench-agenda-list { display:grid; gap:2px; margin:8px 0 0; padding:0; list-style:none; }
.workbench-task-list li,.workbench-agenda-list li { display:flex; align-items:flex-start; gap:8px; padding:8px 1px; border-bottom:1px solid #f0f1ee; }
.workbench-task-check { width:17px; height:17px; flex:0 0 17px; display:grid; place-items:center; border:1px solid #d6ddd8; border-radius:5px; color:#789681; background:white; cursor:pointer; }
.workbench-task-list li>span { min-width:0; display:grid; gap:4px; }
.workbench-task-list li strong,.workbench-agenda-copy strong { overflow:hidden; color:#596779; font-size:12.5px; font-weight:550; text-overflow:ellipsis; white-space:nowrap; }
.workbench-task-list li small,.workbench-agenda-copy small { color:#929ca8; font-size:11px; }
.workbench-task-list li small b { color:#bf8974; font-weight:500; }
.workbench-widget-empty { margin:12px 0 1px; color:#929ca8; font-size:12px; line-height:1.6; }
.workbench-agenda-list li { align-items:center; gap:9px; }
.workbench-agenda-date { min-width:46px; display:grid; gap:3px; color:#71829a; font-size:11px; }
.workbench-agenda-date small { color:#9ba4af; font-size:10px; }
.workbench-agenda-copy { min-width:0; display:grid; gap:4px; }
.workbench-book-link { width:100%; min-width:0; display:flex; align-items:center; gap:8px; margin-top:9px; padding:6px 0; border:0; color:#768397; background:transparent; text-align:left; cursor:pointer; }
.workbench-book-icon { width:28px; height:34px; flex:0 0 28px; display:grid; place-items:center; border-radius:5px; color:#7f9bbd; background:#f1f4f7; }
.workbench-book-link>span:nth-child(2) { min-width:0; flex:1; display:grid; gap:4px; }
.workbench-book-link>span:nth-child(2) strong,.workbench-book-link>span:nth-child(2) small { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.workbench-book-link>span:nth-child(2) strong { color:#566376; font-size:12px; }
.workbench-book-link>span:nth-child(2) small { color:#969faa; font-size:11px; }
@media(max-width:1250px) {
  .workbench-layout { grid-template-columns:190px minmax(0,1fr); }
  .workbench-right-rail { grid-column:2; grid-template-columns:repeat(2,minmax(0,1fr)); }
  .workbench-reading-widget { grid-column:1/-1; }
}
@media(max-width:980px) {
  .workbench-layout { grid-template-columns:170px minmax(0,1fr); gap:10px; }
  .workbench-document { padding-right:15px; padding-left:15px; }
  .workbench-document :deep(.markdown-note-editor textarea),.workbench-document :deep(.markdown-note-preview) { min-height:320px; }
}
@media(max-width:640px) {
  .workbench-heading { align-items:flex-end; }
  .workbench-heading .button { min-height:36px; padding:0 9px; font-size:11px; }
  .workbench-layout { grid-template-columns:minmax(0,1fr); gap:10px; }
  .workbench-page-panel { position:static; gap:8px; padding:10px; }
  .workbench-page-list { display:flex; max-height:none; overflow-x:auto; }
  .workbench-page-item { min-width:155px; max-width:190px; }
  .workbench-right-rail { grid-column:auto; grid-template-columns:minmax(0,1fr); }
  .workbench-reading-widget { grid-column:auto; }
  .workbench-document { padding:16px 11px; }
  .workbench-breadcrumb { padding:0 11px; font-size:10px; }
  .workbench-title-row input { height:39px; font-size:21px; }
  .workbench-page-meta,.workbench-block-toolbar,.workbench-editor-footer,.workbench-error { margin-left:35px; }
  .workbench-document :deep(.markdown-note-editor textarea) { min-height:285px; padding:15px; font-size:13.5px; }
  .workbench-document :deep(.markdown-note-preview) { min-height:285px; padding:16px; font-size:13.5px; }
  .workbench-editor-footer { align-items:flex-start; flex-direction:column; }
}
</style>
