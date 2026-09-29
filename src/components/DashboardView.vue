<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import BookCover from './BookCover.vue'
import Icon from './Icon.vue'
import TaskEditorDialog from './TaskEditorDialog.vue'
import { deleteLocalRecord, getLocalRecord, getLocalRecords, saveLocalRecord } from '../services/localDataStore.js'
import { isReviewDue } from '../services/reviewSchedule.js'

const props = defineProps({ books: { type: Array, default: () => [] } })
const emit = defineEmits(['open-reader', 'open-calendar', 'open-shelf', 'start-review', 'create-review-card'])
const taskTitle = ref('')
const taskPriority = ref('normal')
const taskError = ref('')
const taskSaving = ref(false)
const editingTask = ref(null)
const currentTime = ref(new Date())
const favoriteError = ref('')
let clockTimer = null
onMounted(() => { clockTimer = window.setInterval(() => { currentTime.value = new Date() }, 30_000) })
onBeforeUnmount(() => { if (clockTimer) window.clearInterval(clockTimer) })

function dateKey(date) {
  return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0')
}
const todayKey = computed(() => dateKey(currentTime.value))
const featuredBook = computed(() => props.books.find((book) => book.lastRead) || props.books[0] || null)
const featuredChapterLabel = computed(() => featuredBook.value?.currentChapter || '从第一章开始')
const isFeaturedBookFavorite = computed(() => {
  const preference = getLocalRecord('preference', 'dashboard')
  return Boolean(featuredBook.value && preference?.favoriteBookIds?.includes(featuredBook.value.id))
})
const dashboardBooks = computed(() => [...props.books]
  .sort((a, b) => Number(Boolean(b.lastRead)) - Number(Boolean(a.lastRead)) || Number(b.progress || 0) - Number(a.progress || 0))
  .slice(0, 3))
const events = computed(() => getLocalRecords('calendar')
  .filter((event) => event.date === todayKey.value)
  .sort((a, b) => String(a.start).localeCompare(String(b.start)))
  .map((event) => {
    const now = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(currentTime.value)
    const tone = { 学习: 'blue', 工作: 'violet', 生活: 'peach', 待办: 'mint' }[event.category] || 'blue'
    return { ...event, tone, detail: props.books.find((book) => book.id === event.bookId)?.title || event.category || '日程', state: now < event.start ? '待开始' : now < event.end ? '进行中' : '已结束' }
  }))
const taskPriorityRank = { high: 0, normal: 1, low: 2 }
function normalizedPriority(task) { return Object.hasOwn(taskPriorityRank, task.priority) ? task.priority : 'normal' }
function priorityRank(task) { return taskPriorityRank[normalizedPriority(task)] }
function taskDueLabel(task) {
  if (!task.dueDate) return '未安排'
  if (typeof task.dueDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(task.dueDate)) return '日期异常'
  const [year, month, day] = task.dueDate.split('-').map(Number)
  const date = new Date(year, month - 1, day)
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return '日期异常'
  if (task.done || task.dueDate >= todayKey.value) return ''
  return `逾期 · ${Number(month)}/${Number(day)}`
}
function isOverdueTask(task) { return !task.done && taskDueLabel(task).startsWith('逾期') }
const tasks = computed(() => getLocalRecords('task')
  .filter((task) => !task.dueDate || task.dueDate <= todayKey.value)
  .sort((a, b) => Number(Boolean(a.done)) - Number(Boolean(b.done))
    || String(a.dueDate || '9999-12-31').localeCompare(String(b.dueDate || '9999-12-31'))
    || priorityRank(a) - priorityRank(b)
    || String(a.createdAt || '').localeCompare(String(b.createdAt || ''))))
const hiddenTaskCount = computed(() => Math.max(0, tasks.value.length - 5))
const reviewCards = computed(() => getLocalRecords('review'))
const dueReviewCards = computed(() => {
  const now = currentTime.value.getTime()
  return reviewCards.value.filter((card) => isReviewDue(card, now))
})
const dueReviewCount = computed(() => dueReviewCards.value.length)
const week = computed(() => {
  const monday = new Date(currentTime.value)
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7))
  const studiedDays = new Set(getLocalRecords('reader').flatMap((record) => Array.isArray(record.readDays) ? record.readDays : []))
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(monday)
    date.setDate(date.getDate() + index)
    const key = dateKey(date)
    return { label: ['一', '二', '三', '四', '五', '六', '日'][index], done: studiedDays.has(key), current: key === todayKey.value }
  })
})
const studyStreak = computed(() => {
  const days = new Set(getLocalRecords('reader').flatMap((record) => Array.isArray(record.readDays) ? record.readDays : []))
  const cursor = new Date(currentTime.value)
  if (!days.has(todayKey.value)) cursor.setDate(cursor.getDate() - 1)
  let count = 0
  while (days.has(dateKey(cursor)) && count < 365) { count += 1; cursor.setDate(cursor.getDate() - 1) }
  return count
})
const daysThisWeek = computed(() => week.value.filter((day) => day.done).length)
const greeting = computed(() => {
  const hour = currentTime.value.getHours()
  return hour < 11 ? '早上好' : hour < 14 ? '中午好' : hour < 18 ? '下午好' : '晚上好'
})
const todayLabel = computed(() => new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }).format(currentTime.value))
async function addTask() {
  const title = taskTitle.value.trim()
  if (!title || taskSaving.value) return
  taskError.value = ''
  taskSaving.value = true
  try {
    await saveLocalRecord('task', window.crypto?.randomUUID?.() || String(Date.now()), {
      title: title.slice(0, 120), done: false, dueDate: todayKey.value, priority: taskPriority.value, createdAt: new Date().toISOString(),
    })
    taskTitle.value = ''
    taskPriority.value = 'normal'
  } catch (error) { taskError.value = error.message }
  finally { taskSaving.value = false }
}
async function toggleTask(task) {
  if (taskSaving.value) return
  taskError.value = ''
  taskSaving.value = true
  try {
    const { id, updatedAt, ...data } = task
    await saveLocalRecord('task', id, { ...data, done: !task.done, doneAt: !task.done ? new Date().toISOString() : '' })
  } catch (error) { taskError.value = error.message }
  finally { taskSaving.value = false }
}
async function updateTaskPriority(task, priority) {
  if (taskSaving.value || !Object.hasOwn(taskPriorityRank, priority) || priorityRank(task) === taskPriorityRank[priority]) return
  taskError.value = ''
  taskSaving.value = true
  try {
    const { id, updatedAt, ...data } = task
    await saveLocalRecord('task', id, { ...data, priority })
  } catch (error) { taskError.value = error.message }
  finally { taskSaving.value = false }
}
async function removeTask(task) {
  if (taskSaving.value) return
  taskError.value = ''
  taskSaving.value = true
  try { await deleteLocalRecord('task', task.id) }
  catch (error) { taskError.value = error.message }
  finally { taskSaving.value = false }
}
function editTask(task) { editingTask.value = task }
async function toggleFeaturedFavorite() {
  if (!featuredBook.value) return
  favoriteError.value = ''
  try {
    const preference = getLocalRecord('preference', 'dashboard') || { favoriteBookIds: [] }
    const favoriteBookIds = new Set(preference.favoriteBookIds || [])
    if (favoriteBookIds.has(featuredBook.value.id)) favoriteBookIds.delete(featuredBook.value.id)
    else favoriteBookIds.add(featuredBook.value.id)
    await saveLocalRecord('preference', 'dashboard', { favoriteBookIds: [...favoriteBookIds] })
  } catch (error) { favoriteError.value = error.message }
}
</script>

<template>
  <main class="page-content dashboard-page">
    <header class="page-heading dashboard-heading">
      <div>
        <div class="eyebrow-label"><Icon name="sun" size="15" /> {{ greeting }}</div>
        <h1>工作台</h1>
        <p>专注当下，积累每一次小小的进步。</p>
      </div>
      <div class="heading-side">
        <span class="date-label">{{ todayLabel }}</span>
        <span class="avatar-button" aria-hidden="true">知</span>
      </div>
    </header>

    <section class="dashboard-top-grid">
      <article v-if="featuredBook" class="continue-card surface-card">
        <div class="continue-cover-wrap"><BookCover :book="featuredBook" compact /></div>
        <div class="continue-copy">
          <span class="section-kicker"><span class="live-dot"></span> 继续阅读</span>
          <div class="continue-title-row">
            <div>
              <h2>{{ featuredBook.title }}</h2>
              <p class="subtle-copy">{{ featuredBook.subtitle }} · {{ featuredChapterLabel }}</p>
            </div>
            <button class="icon-button bookmark-action" :aria-label="isFeaturedBookFavorite ? '取消收藏课程' : '收藏课程'" :aria-pressed="isFeaturedBookFavorite" @click="toggleFeaturedFavorite"><Icon name="bookmark" size="18" :class="{ 'is-bookmarked': isFeaturedBookFavorite }" /></button>
          </div>
          <div class="progress-label-row"><span>阅读进度</span><strong>{{ featuredBook.progress }}%</strong></div>
          <div class="progress-track"><span :style="{ width: `${featuredBook.progress}%` }"></span></div>
          <div class="continue-actions">
            <button class="button button-primary" @click="$emit('open-reader', featuredBook)">接着读 <Icon name="arrowRight" size="16" /></button>
            <button class="button button-secondary" @click="$emit('open-shelf')"><Icon name="list" size="16" /> 查看目录</button>
          </div>
          <p v-if="favoriteError" class="favorite-feedback" role="status">{{ favoriteError }}</p>
        </div>
      </article>
      <article v-else class="no-book-card surface-card"><span class="overview-icon"><Icon name="shelf" size="20" /></span><div><span class="section-kicker">从一本书开始</span><h2>你的学习书架还是空的</h2><p>把 AI 生成的 Markdown 课程导入书架，按一本书的方式阅读和管理。</p><button class="button button-primary" @click="$emit('open-shelf')"><Icon name="plus" size="15" /> 导入课程</button></div></article>

      <article class="week-card surface-card">
        <div class="card-heading-inline"><div><span class="section-kicker">学习节奏</span><h2>本周学习</h2></div><span class="streak-pill"><Icon name="sparkles" size="14" /> 连续 {{ studyStreak }} 天</span></div>
        <div class="week-days">
          <div v-for="day in week" :key="day.label" class="week-day" :class="{ 'is-complete': day.done, 'is-current': day.current }">
            <span class="week-check"><Icon v-if="day.done" name="check" size="15" /></span>
            <span>{{ day.label }}</span>
          </div>
        </div>
        <div class="dashboard-review-prompt" :class="{ 'dashboard-review-prompt--ready': dueReviewCount, 'dashboard-review-prompt--empty': !dueReviewCount && !reviewCards.length }">
          <span class="dashboard-review-icon"><Icon name="review" size="16" /></span>
          <div class="dashboard-review-copy">
            <strong>{{ dueReviewCount ? `${dueReviewCount} 张卡片待复习` : reviewCards.length ? '暂无到期卡片' : '建立你的复习卡片' }}</strong>
            <span>{{ dueReviewCount ? '花几分钟回忆，帮助知识留得更久' : reviewCards.length ? '卡片到期后会出现在这里' : '从课程笔记创建卡片，或手动添加' }}</span>
          </div>
          <button v-if="dueReviewCount" class="dashboard-review-action" @click="$emit('start-review')">开始复习 <Icon name="arrowRight" size="14" /></button>
          <button v-else-if="!reviewCards.length" class="dashboard-review-action dashboard-review-action--quiet" @click="$emit('create-review-card')">添加卡片 <Icon name="arrowRight" size="14" /></button>
          <span v-else class="dashboard-review-complete">无待复习</span>
        </div>
        <div class="week-footer"><span>本周已学习 {{ daysThisWeek }} 天</span><button class="tiny-link" @click="$emit('open-shelf')">查看学习进度</button></div>
      </article>
    </section>

    <section class="dashboard-middle-grid">
        <article class="agenda-card surface-card">
          <div class="section-heading-row"><div><span class="section-kicker">安排与日程</span><h2>今天的安排</h2></div><button class="text-button" @click="$emit('open-calendar')">查看日历 <Icon name="chevronRight" size="16" /></button></div>
          <div v-if="events.length" class="agenda-list">
            <div v-for="event in events" :key="event.id" class="agenda-row">
              <div class="agenda-time"><strong>{{ event.start }}</strong><span>{{ event.end }}</span></div>
              <span class="agenda-marker" :class="`tone-${event.tone}`"></span>
              <div class="agenda-copy"><strong>{{ event.title }}</strong><span>{{ event.detail }}</span></div>
              <span class="status-pill" :class="{ 'status-active': event.state === '进行中' }">{{ event.state }}</span>
            </div>
          </div>
          <div v-else class="dashboard-empty-copy">今天还没有安排。<button class="text-button" @click="$emit('open-calendar')">添加一个日程</button></div>
        </article>

        <article class="task-card surface-card">
          <div class="section-heading-row"><div><span class="section-kicker">轻轻推进</span><h2>今天的待办</h2></div><span class="task-count">{{ tasks.filter((task) => !task.done).length }} 项未完成</span></div>
          <ul class="task-list">
            <li v-for="task in tasks.slice(0, 5)" :key="task.id" :class="{ 'task-done': task.done }"><button class="task-checkbox" :aria-label="task.done ? '标记为未完成' : '标记为完成'" :disabled="taskSaving" @click="toggleTask(task)"><Icon v-if="task.done" name="check" size="13" /></button><span class="task-title">{{ task.title }}</span><span v-if="taskDueLabel(task)" class="task-date-badge" :class="{ 'is-overdue': isOverdueTask(task) }">{{ taskDueLabel(task) }}</span><select class="task-priority-select" :aria-label="`设置 ${task.title} 的优先级`" :value="normalizedPriority(task)" :disabled="taskSaving" @change="updateTaskPriority(task, $event.target.value)"><option value="high">高</option><option value="normal">普通</option><option value="low">低</option></select><button class="task-edit" :aria-label="'编辑待办：' + task.title" :disabled="taskSaving" @click="editTask(task)"><Icon name="edit" size="13" /></button><button class="task-delete" :aria-label="'删除待办：' + task.title" :disabled="taskSaving" @click="removeTask(task)"><Icon name="trash" size="13" /></button></li>
          </ul>
          <button v-if="hiddenTaskCount" type="button" class="task-more-link" @click="$emit('open-calendar')">还有 {{ hiddenTaskCount }} 项待办 · 前往日历管理 <Icon name="chevronRight" size="13" /></button>
          <form class="dashboard-task-form" @submit.prevent="addTask"><input v-model="taskTitle" maxlength="120" aria-label="新待办事项" placeholder="添加今天要做的事" :disabled="taskSaving" /><select v-model="taskPriority" aria-label="新待办优先级" :disabled="taskSaving"><option value="high">高</option><option value="normal">普通</option><option value="low">低</option></select><button type="submit" aria-label="添加待办" :disabled="taskSaving || !taskTitle.trim()"><Icon name="plus" size="16" /></button></form>
          <p v-if="taskError" class="workspace-error" role="alert">{{ taskError }}</p>
          <div v-if="!tasks.length" class="dashboard-empty-copy">写下一件今天想推进的小事。</div>
        </article>
    </section>

    <TaskEditorDialog :open="Boolean(editingTask)" :task="editingTask" @close="editingTask = null" @saved="editingTask = null" />

    <section class="book-preview-section">
      <div class="section-heading-row book-preview-heading"><div><span class="section-kicker">正在学习</span><h2>我的课程与书籍</h2></div><button class="text-button" @click="$emit('open-shelf')">前往书架 <Icon name="chevronRight" size="16" /></button></div>
      <div v-if="dashboardBooks.length" class="mini-book-row">
        <button v-for="book in dashboardBooks" :key="book.id" class="mini-book" @click="$emit('open-reader', book)">
          <div class="mini-cover"><BookCover :book="book" compact /></div>
          <div class="mini-book-info"><strong>{{ book.title }}</strong><span>{{ book.subtitle }}</span><div class="mini-progress"><span class="progress-track"><i :style="{ width: `${book.progress}%` }"></i></span><small>{{ book.progress }}%</small></div></div>
        </button>
        <button class="discover-book" @click="$emit('open-shelf')"><span class="discover-plus"><Icon name="plus" size="20" /></span><span>发现更多书籍</span></button>
      </div>
      <div v-else class="dashboard-empty-copy">导入课程后，书架内容会显示在这里。</div>
    </section>
  </main>
</template>

<style scoped>
.no-book-card { min-height: 232px; display: flex; align-items: center; gap: 16px; padding: 22px; }
.no-book-card .overview-icon { flex: 0 0 38px; }
.no-book-card h2 { margin: 7px 0; color: #39475b; font-size: 16px; }
.no-book-card p { max-width: 350px; margin: 0 0 13px; color: #8792a1; font-size: 12px; line-height: 1.7; }
.favorite-feedback { margin: 8px 0 0; color: #9a7b72; font-size: 11px; }
.dashboard-private-hint, .dashboard-empty-copy { padding: 14px 3px; color: #9aa4b1; font-size: 12px; line-height: 1.65; }
.dashboard-private-setup { grid-column: 1 / -1; min-height: 132px; display: flex; align-items: center; gap: 16px; padding: 22px; }
.dashboard-private-setup > div { min-width: 0; flex: 1; }
.dashboard-private-setup h2 { margin: 6px 0; color: #39475b; font-size: 15px; font-weight: 620; }
.dashboard-private-setup p { max-width: 510px; margin: 0; color: #8792a1; font-size: 12px; line-height: 1.7; }
.dashboard-private-setup .button { min-height: 35px; flex: 0 0 auto; font-size: 12px; }
.dashboard-empty-copy .text-button { margin-left: 5px; }
.task-count { color: #9aa4b1; font-size: 10px; }
.task-list li { display: flex; align-items: center; gap: 9px; }
.task-title { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.task-date-badge { flex: 0 0 auto; color: #969eaa; font-size: 10px; white-space: nowrap; }
.task-date-badge.is-overdue { color: #b96e63; }
.task-more-link { display: inline-flex; align-items: center; gap: 2px; margin: 7px 0 0 25px; padding: 4px 0; border: 0; color: #7186a3; background: transparent; font: inherit; font-size: 11px; cursor: pointer; }
.task-more-link:hover { color: #426da8; }
.task-priority-select { min-height: 25px; flex: 0 0 48px; padding: 0 2px; border: 1px solid transparent; border-radius: 6px; color: #7c8795; background: transparent; font: inherit; font-size: 10px; cursor: pointer; }
.task-priority-select:focus-visible { border-color: #dce5f1; outline: 2px solid rgba(89,139,218,.12); }
.task-priority-select:disabled { opacity: .55; cursor: wait; }
.task-checkbox { flex: 0 0 16px; cursor: pointer; }
.task-delete { display: grid; width: 23px; height: 23px; flex: 0 0 23px; place-items: center; margin-left: auto; border: 0; border-radius: 6px; color: #a7afba; background: transparent; cursor: pointer; }
.task-delete:hover { color: #bb6e67; background: #fbf2f1; }
.task-edit { display: grid; width: 23px; height: 23px; flex: 0 0 23px; place-items: center; border: 0; border-radius: 6px; color: #9aa5b2; background: transparent; cursor: pointer; }
.task-edit:hover { color: #5e82b5; background: #f1f5fa; }
.dashboard-task-form { display: flex; gap: 6px; margin-top: 14px; }
.dashboard-task-form input { min-width: 0; flex: 1; height: 31px; box-sizing: border-box; padding: 0 9px; border: 1px solid #e8ebef; border-radius: 8px; outline: 0; color: #596779; background: #fff; font: inherit; font-size: 11px; }
.dashboard-task-form select { width: 57px; height: 31px; padding: 0 5px; border: 1px solid #e8ebef; border-radius: 8px; color: #687485; background: #fff; font: inherit; font-size: 10px; }
.dashboard-task-form select:disabled { opacity: .55; }
.dashboard-task-form button:disabled { opacity: .55; cursor: wait; }
.task-checkbox:disabled, .task-delete:disabled, .task-edit:disabled { opacity: .55; cursor: wait; }
.dashboard-task-form button { width: 31px; display: grid; place-items: center; border: 0; border-radius: 8px; color: #fff; background: #6e98d4; cursor: pointer; }
@media (max-width: 640px) { .no-book-card { min-height: 170px; padding: 17px; } }
.dashboard-review-prompt { min-height: 60px; display: flex; align-items: center; gap: 10px; margin-top: 18px; padding: 10px 11px; border: 1px solid #edf0f3; border-radius: 12px; background: linear-gradient(115deg, #f7f9fc, #fbfcfa); }
.dashboard-review-icon { width: 31px; height: 31px; flex: 0 0 31px; display: grid; place-items: center; border-radius: 9px; color: #648ac1; background: #eaf1fa; }
.dashboard-review-prompt--ready { border-color: #e4ebf4; background: linear-gradient(115deg, #f2f6fc, #fbfcfa); }
.dashboard-review-prompt--ready .dashboard-review-icon { color: #4f7fba; background: #e4eef9; }
.dashboard-review-prompt--empty .dashboard-review-icon { color: #789b88; background: #edf4ef; }
.dashboard-review-copy { min-width: 0; flex: 1; display: grid; gap: 4px; }
.dashboard-review-copy strong { overflow: hidden; color: #506075; font-size: 12px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
.dashboard-review-copy span { overflow: hidden; color: #8793a2; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.dashboard-review-action { min-height: 30px; display: inline-flex; flex: 0 0 auto; align-items: center; gap: 4px; padding: 0 9px; border: 0; border-radius: 8px; color: #fff; background: #618bc3; font: inherit; font-size: 11px; font-weight: 600; cursor: pointer; transition: background .18s ease, transform .18s ease; }
.dashboard-review-action:hover { background: #4e7cb7; transform: translateY(-1px); }
.dashboard-review-action--quiet { color: #63866f; background: #eaf2ec; }
.dashboard-review-action--quiet:hover { background: #dfece2; }
.dashboard-review-complete { flex: 0 0 auto; padding: 5px 7px; border-radius: 7px; color: #6f9880; background: #edf5ef; font-size: 11px; }
@media (max-width: 640px) { .dashboard-review-prompt { gap: 8px; margin-top: 14px; padding: 9px; } .dashboard-review-copy strong { font-size: 11px; } .dashboard-review-copy span { font-size: 10px; } .dashboard-review-action { min-height: 28px; padding: 0 7px; font-size: 10px; } }
</style>
