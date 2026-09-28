<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Icon from './Icon.vue'
import TaskEditorDialog from './TaskEditorDialog.vue'
import { getLocalRecords, localDataState, saveLocalRecord, deleteLocalRecord } from '../services/localDataStore.js'

const props = defineProps({ books: { type: Array, default: () => [] } })
const mode = ref('周')
const focusDate = ref(new Date())
const calendarNow = ref(new Date())
let clockTimer = null
const modalOpen = ref(false)
const formError = ref('')
const formSaving = ref(false)
const draft = ref(createEmptyDraft())
const storageStatus = ref('')
const taskTitle = ref('')
const taskPriority = ref('normal')
const taskError = ref('')
const taskSaving = ref(false)
const editingTask = ref(null)
let draftBaseline = ''
let calendarPreferenceRestored = false
let calendarPreferenceTimer = null
let preferenceSaveQueue = Promise.resolve()

const categories = [
  { label: '学习', tone: 'blue' },
  { label: '工作', tone: 'lavender' },
  { label: '生活', tone: 'peach' },
  { label: '待办', tone: 'mint' },
]

function toDateKey(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

const todayKey = computed(() => toDateKey(calendarNow.value))
onMounted(() => { clockTimer = window.setInterval(() => { calendarNow.value = new Date() }, 30_000) })
onBeforeUnmount(() => {
  if (clockTimer) window.clearInterval(clockTimer)
  if (calendarPreferenceTimer) {
    window.clearTimeout(calendarPreferenceTimer)
    calendarPreferenceTimer = null
    saveCalendarPreference()
  }
})

watch(() => localDataState.serviceAvailable, (available) => {
  if (available) restoreCalendarPreference()
}, { immediate: true })
watch([mode, () => toDateKey(focusDate.value)], queueCalendarPreferenceSave)

function fromDateKey(key) {
  const [year, month, day] = key.split('-').map(Number)
  return new Date(year, month - 1, day)
}

function startOfWeek(date) {
  const result = new Date(date)
  result.setDate(result.getDate() - ((result.getDay() + 6) % 7))
  result.setHours(0, 0, 0, 0)
  return result
}

function createEmptyDraft(date = focusDate.value) {
  return {
    id: null,
    title: '',
    date: toDateKey(date),
    start: '09:00',
    end: '10:00',
    category: '学习',
    bookId: '',
  }
}

function readLegacyCalendarEvents() {
  try {
    const saved = window.localStorage.getItem('zhixu:calendar:v1')
    if (!saved) return null
    const payload = JSON.parse(saved)
    if (payload?.version !== 1 || !Array.isArray(payload.events)) {
      throw new Error('日历数据格式不受支持。')
    }

    return payload.events.map(normalizeStoredEvent).filter((event) => event && !String(event.id).startsWith('demo-'))
  } catch (error) {
    console.warn('无法迁移旧版本地日程。', error)
    storageStatus.value = '旧版本地日程格式无法识别，尚未迁入项目目录；原始数据保持未动。'
    return null
  }
}

function normalizeStoredEvent(event, index) {
  if (!event || typeof event !== 'object') return null
  if (!isValidDateKey(event.date)) return null
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(event.start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(event.end)) return null
  if (event.end <= event.start || typeof event.title !== 'string' || !event.title.trim()) return null

  return {
    id: typeof event.id === 'string' || typeof event.id === 'number' ? event.id : `saved-${index}`,
    title: event.title.trim().slice(0, 80),
    date: event.date,
    start: event.start,
    end: event.end,
    category: categories.some((item) => item.label === event.category) ? event.category : '学习',
    bookId: typeof event.bookId === 'string' ? event.bookId : '',
  }
}

function isValidDateKey(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = fromDateKey(value)
  return !Number.isNaN(date.getTime()) && toDateKey(date) === value
}

function restoreCalendarPreference() {
  if (calendarPreferenceRestored || !localDataState.serviceAvailable) return
  const preference = getLocalRecord('preference', 'calendar')
  if (['周', '月'].includes(preference?.mode)) mode.value = preference.mode
  if (isValidDateKey(preference?.focusDate)) focusDate.value = fromDateKey(preference.focusDate)
  calendarPreferenceRestored = true
}

function queueCalendarPreferenceSave() {
  if (!calendarPreferenceRestored) return
  if (calendarPreferenceTimer) window.clearTimeout(calendarPreferenceTimer)
  calendarPreferenceTimer = window.setTimeout(() => {
    calendarPreferenceTimer = null
    saveCalendarPreference()
  }, 250)
}

function saveCalendarPreference() {
  if (!calendarPreferenceRestored || !localDataState.serviceAvailable) return
  const preference = { mode: mode.value, focusDate: toDateKey(focusDate.value) }
  preferenceSaveQueue = preferenceSaveQueue
    .catch(() => {})
    .then(() => saveLocalRecord('preference', 'calendar', preference))
    .catch((error) => { storageStatus.value = error.message || '无法保存日历视图偏好。' })
}

function createEventId() {
  return window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

const calendarEvents = ref([])
let isRefreshingCalendar = false
let calendarRefreshRequested = false

async function refreshCalendarEvents() {
  if (isRefreshingCalendar) {
    calendarRefreshRequested = true
    return
  }

  isRefreshingCalendar = true
  try {
    let records = getLocalRecords('calendar')
    const legacyEvents = readLegacyCalendarEvents()
    if (legacyEvents) {
      const existingIds = new Set(records.map((event) => String(event.id)))
      for (const event of legacyEvents) {
        if (existingIds.has(String(event.id))) continue
        const { id, updatedAt, ...data } = event
        await saveLocalRecord('calendar', String(id), data)
        existingIds.add(String(id))
      }
      window.localStorage.removeItem('zhixu:calendar:v1')
      records = getLocalRecords('calendar')
    }
    calendarEvents.value = records.map(normalizeStoredEvent).filter(Boolean)
    if (!storageStatus.value.includes('无法迁移')) storageStatus.value = ''
  } catch (error) {
    console.warn('无法读取本机日程。', error)
    storageStatus.value = error.message || '无法读取本机日程。'
  } finally {
    isRefreshingCalendar = false
    if (calendarRefreshRequested) {
      calendarRefreshRequested = false
      void refreshCalendarEvents()
    }
  }
}

watch(() => localDataState.events, refreshCalendarEvents, { deep: true, immediate: true })

const sortedEvents = computed(() => [...calendarEvents.value].sort((a, b) => `${a.date} ${a.start}`.localeCompare(`${b.date} ${b.start}`, 'zh-CN')))
const calendarTasks = computed(() => getLocalRecords('task'))
const calendarTasksByDate = computed(() => {
  const groups = new Map()
  for (const task of calendarTasks.value) {
    if (!isValidDateKey(task.dueDate)) continue
    const summary = groups.get(task.dueDate) || { total: 0, open: 0 }
    summary.total += 1
    if (!task.done) summary.open += 1
    groups.set(task.dueDate, summary)
  }
  return groups
})
const startOfVisibleWeek = computed(() => startOfWeek(focusDate.value))
const weekDays = computed(() => Array.from({ length: 7 }, (_, index) => {
  const date = new Date(startOfVisibleWeek.value)
  date.setDate(date.getDate() + index)
  const key = toDateKey(date)
  const taskSummary = calendarTasksByDate.value.get(key) || { total: 0, open: 0 }
  return {
    date,
    key,
    label: ['一', '二', '三', '四', '五', '六', '日'][index],
    isToday: key === todayKey.value,
    events: sortedEvents.value.filter((event) => event.date === key),
    taskCount: taskSummary.total,
    openTaskCount: taskSummary.open,
  }
}))
const weekEvents = computed(() => {
  const visibleDays = new Set(weekDays.value.map((day) => day.key))
  return sortedEvents.value.filter((event) => visibleDays.has(event.date) && visibleOnWeek(event))
})

const monthDays = computed(() => {
  const firstOfMonth = new Date(focusDate.value.getFullYear(), focusDate.value.getMonth(), 1)
  const gridStart = new Date(firstOfMonth)
  gridStart.setDate(gridStart.getDate() - ((gridStart.getDay() + 6) % 7))
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(gridStart)
    date.setDate(date.getDate() + index)
    const key = toDateKey(date)
    const taskSummary = calendarTasksByDate.value.get(key) || { total: 0, open: 0 }
    return {
      date,
      key,
      inMonth: date.getMonth() === focusDate.value.getMonth(),
      isToday: key === todayKey.value,
      isSelected: key === toDateKey(focusDate.value),
      events: sortedEvents.value.filter((event) => event.date === key),
      taskCount: taskSummary.total,
      openTaskCount: taskSummary.open,
    }
  })
})

const periodTitle = computed(() => {
  if (mode.value === '月') {
    return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long' }).format(focusDate.value)
  }

  const first = weekDays.value[0].date
  const last = weekDays.value[6].date
  const firstLabel = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long' }).format(first)
  if (first.getFullYear() === last.getFullYear() && first.getMonth() === last.getMonth()) return firstLabel
  const lastLabel = new Intl.DateTimeFormat('zh-CN', first.getFullYear() === last.getFullYear() ? { month: 'long' } : { year: 'numeric', month: 'long' }).format(last)
  return `${firstLabel} — ${lastLabel}`
})

const selectedDateKey = computed(() => toDateKey(focusDate.value))
const selectedDateLabel = computed(() => new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }).format(focusDate.value))
const taskPriorityRank = { high: 0, normal: 1, low: 2 }
function normalizedPriority(task) { return Object.hasOwn(taskPriorityRank, task.priority) ? task.priority : 'normal' }
function priorityRank(task) { return taskPriorityRank[normalizedPriority(task)] }
const selectedDateTasks = computed(() => calendarTasks.value
  .filter((task) => task.dueDate === selectedDateKey.value)
  .sort((a, b) => Number(Boolean(a.done)) - Number(Boolean(b.done))
    || priorityRank(a) - priorityRank(b)
    || String(a.createdAt || '').localeCompare(String(b.createdAt || ''))))
const unscheduledOpenTasks = computed(() => calendarTasks.value
  .filter((task) => !task.done && !isValidDateKey(task.dueDate))
  .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || ''))))
const completedSelectedTasks = computed(() => selectedDateTasks.value.filter((task) => task.done).length)
const hours = Array.from({ length: 14 }, (_, index) => `${String(index + 8).padStart(2, '0')}:00`)
const isEditing = computed(() => draft.value.id !== null)

function movePeriod(amount) {
  const next = new Date(focusDate.value)
  if (mode.value === '周') next.setDate(next.getDate() + amount * 7)
  else {
    next.setDate(1)
    next.setMonth(next.getMonth() + amount)
  }
  focusDate.value = next
}

function goToToday() {
  focusDate.value = new Date(calendarNow.value)
}

function showDayInWeek(date) {
  focusDate.value = new Date(date)
  mode.value = '周'
}

function openNewEvent(date = focusDate.value) {
  draft.value = createEmptyDraft(date)
  draftBaseline = JSON.stringify(draft.value)
  formError.value = ''
  modalOpen.value = true
}

function openEditEvent(event) {
  draft.value = { ...event }
  draftBaseline = JSON.stringify(draft.value)
  formError.value = ''
  modalOpen.value = true
}

function closeModal(discard = false) {
  if (formSaving.value && !discard) return
  if (!discard && JSON.stringify(draft.value) !== draftBaseline
    && !window.confirm('这条日程有未保存的修改，确定丢弃吗？')) return
  modalOpen.value = false
  formError.value = ''
}

async function saveEvent() {
  if (formSaving.value) return
  if (draft.value.end <= draft.value.start) {
    formError.value = '结束时间需要晚于开始时间。'
    return
  }

  const conflicts = calendarEvents.value.filter((event) =>
    event.date === draft.value.date
    && String(event.id) !== String(draft.value.id ?? '')
    && draft.value.start < event.end
    && draft.value.end > event.start)
  if (conflicts.length) {
    const newline = String.fromCharCode(10)
    const conflictSummary = conflicts.slice(0, 3)
      .map((event) => event.start + '–' + event.end + ' ' + event.title)
      .join(newline)
    const additionalConflicts = conflicts.length > 3
      ? newline + '另有 ' + (conflicts.length - 3) + ' 项重叠安排。'
      : ''
    if (!window.confirm('与已有日程时间重叠：' + newline + conflictSummary + additionalConflicts + newline + newline + '仍要保存吗？')) return
  }

  const event = { ...draft.value, id: draft.value.id || createEventId() }
  const { id, ...data } = event
  formSaving.value = true
  try {
    await saveLocalRecord('calendar', String(id), data)
    calendarEvents.value = getLocalRecords('calendar').map(normalizeStoredEvent).filter(Boolean)
    focusDate.value = fromDateKey(event.date)
    closeModal(true)
  } catch (error) {
    formError.value = error.message
  } finally {
    formSaving.value = false
  }
}

async function deleteEvent() {
  if (formSaving.value || !window.confirm('确定删除这条日程吗？')) return
  formSaving.value = true
  try {
    await deleteLocalRecord('calendar', String(draft.value.id))
    calendarEvents.value = getLocalRecords('calendar').map(normalizeStoredEvent).filter(Boolean)
    closeModal(true)
  } catch (error) {
    formError.value = error.message
  } finally {
    formSaving.value = false
  }
}

function bookTitle(bookId) {
  return props.books.find((book) => book.id === bookId)?.title || ''
}

function categoryTone(category) {
  return categories.find((item) => item.label === category)?.tone || 'blue'
}

function eventNote(event) {
  return `${event.start}–${event.end}${event.bookId ? ` · ${bookTitle(event.bookId)}` : ''}`
}

function visibleOnWeek(event) {
  return event.end > '08:00' && event.start < '22:00'
}

async function addTaskForSelectedDate() {
  const title = taskTitle.value.trim()
  if (!title) return
  taskError.value = ''
  taskSaving.value = true
  try {
    await saveLocalRecord('task', createEventId(), {
      title: title.slice(0, 120), done: false, dueDate: selectedDateKey.value, priority: taskPriority.value, createdAt: new Date().toISOString(),
    })
    taskTitle.value = ''
    taskPriority.value = 'normal'
  } catch (error) { taskError.value = error.message }
  finally { taskSaving.value = false }
}
async function toggleCalendarTask(task) {
  if (taskSaving.value) return
  taskError.value = ''
  taskSaving.value = true
  const { id, updatedAt, ...data } = task
  try { await saveLocalRecord('task', id, { ...data, done: !task.done, doneAt: !task.done ? new Date().toISOString() : '' }) }
  catch (error) { taskError.value = error.message }
  finally { taskSaving.value = false }
}
async function updateCalendarTaskPriority(task, priority) {
  if (taskSaving.value || !Object.hasOwn(taskPriorityRank, priority) || priorityRank(task) === taskPriorityRank[priority]) return
  taskError.value = ''
  taskSaving.value = true
  const { id, updatedAt, ...data } = task
  try { await saveLocalRecord('task', id, { ...data, priority }) }
  catch (error) { taskError.value = error.message }
  finally { taskSaving.value = false }
}
async function scheduleUndatedTask(task) {
  if (taskSaving.value) return
  taskError.value = ''
  taskSaving.value = true
  const { id, updatedAt, ...data } = task
  try { await saveLocalRecord('task', id, { ...data, dueDate: selectedDateKey.value }) }
  catch (error) { taskError.value = error.message }
  finally { taskSaving.value = false }
}
async function removeCalendarTask(task) {
  if (taskSaving.value || !window.confirm(`确定删除待办“${task.title}”吗？删除后将从日历待办中移除。`)) return
  taskError.value = ''
  taskSaving.value = true
  try { await deleteLocalRecord('task', task.id) }
  catch (error) { taskError.value = error.message }
  finally { taskSaving.value = false }
}
function editCalendarTask(task) { editingTask.value = task }
function eventGridRowStart(event) {
  const visibleStart = event.start < '08:00' ? '08:00' : event.start
  const [hour, minute] = visibleStart.split(':').map(Number)
  return Math.max(1, ((hour - 8) * 60 + minute) / 30 + 1)
}

function eventGridRowEnd(event) {
  const visibleEnd = event.end > '22:00' ? '22:00' : event.end
  const [hour, minute] = visibleEnd.split(':').map(Number)
  return Math.max(eventGridRowStart(event) + 1, ((hour - 8) * 60 + minute) / 30 + 1)
}
</script>

<template>
  <main class="page-content calendar-page">
    <header class="page-heading calendar-heading">
      <div><span class="eyebrow-label"><span class="eyebrow-line"></span> 安排你的时间</span><h1>日历</h1><p>学习、生活与值得期待的每一件事。</p></div>
      <button class="button button-primary" @click="openNewEvent()"><Icon name="plus" size="17" /> 新建日程</button>
    </header>

    <section class="calendar-toolbar surface-card">
      <div class="calendar-month-controls">
        <button class="icon-button" :aria-label="mode === '周' ? '上一周' : '上个月'" @click="movePeriod(-1)"><Icon name="arrowLeft" size="18" /></button>
        <button class="icon-button" :aria-label="mode === '周' ? '下一周' : '下个月'" @click="movePeriod(1)"><Icon name="arrowRight" size="18" /></button>
        <h2>{{ periodTitle }}</h2>
        <button class="today-button" @click="goToToday">今天</button>
      </div>
      <div class="calendar-view-toggle" aria-label="日历视图">
        <button :class="{ selected: mode === '周' }" :aria-pressed="mode === '周'" @click="mode = '周'">周</button>
        <button :class="{ selected: mode === '月' }" :aria-pressed="mode === '月'" @click="mode = '月'">月</button>
      </div>
    </section>

    <section v-if="mode === '周'" class="calendar-panel calendar-week-panel surface-card">
      <div class="calendar-grid">
        <div class="calendar-corner"></div>
        <div v-for="day in weekDays" :key="day.key" class="calendar-day-heading" :class="{ 'calendar-day-heading--today': day.isToday, 'calendar-day-heading--selected': day.key === toDateKey(focusDate) }">
          <span>{{ day.label }}</span>
          <button :aria-label="`选择 ${day.key}`" @click="focusDate = new Date(day.date)">{{ day.date.getDate() }}</button>
          <span v-if="day.openTaskCount" class="calendar-day-task-count" :aria-label="`${day.openTaskCount} 项待办`">{{ day.openTaskCount }}</span>
          <button class="calendar-day-add" :aria-label="`在 ${day.key} 新建日程`" @click="openNewEvent(day.date)"><Icon name="plus" size="13" /></button>
          <i v-if="day.isToday"></i>
        </div>
        <div class="calendar-time-column"><span v-for="hour in hours" :key="hour">{{ hour }}</span></div>
        <div class="calendar-days-grid">
          <div v-for="day in weekDays" :key="`lines-${day.key}`" class="calendar-day-column"><span v-for="hour in hours" :key="hour" class="calendar-hour-line"></span></div>
          <button
            v-for="event in weekEvents"
            :key="event.id"
            class="calendar-event"
            :class="`calendar-event--${categoryTone(event.category)}`"
            :style="{ gridColumn: weekDays.findIndex((day) => day.key === event.date) + 1, gridRow: `${eventGridRowStart(event)} / ${eventGridRowEnd(event)}` }"
            :title="`${event.title} · ${eventNote(event)}`"
            @click="openEditEvent(event)"
          ><strong>{{ event.title }}</strong><span>{{ eventNote(event) }}</span></button>
        </div>
      </div>
    </section>

    <section v-else class="calendar-panel calendar-month-panel surface-card">
      <div class="calendar-month-grid">
        <div v-for="label in ['一', '二', '三', '四', '五', '六', '日']" :key="label" class="calendar-month-weekday">周{{ label }}</div>
        <article v-for="day in monthDays" :key="day.key" class="calendar-month-day" :class="{ 'is-outside-month': !day.inMonth, 'is-today': day.isToday, 'is-selected': day.isSelected }">
          <div class="calendar-month-day-top">
            <button class="calendar-month-date" :class="{ 'is-today': day.isToday }" @click="focusDate = new Date(day.date)">{{ day.date.getDate() }}</button>
            <span v-if="day.openTaskCount" class="calendar-month-task-count">{{ day.openTaskCount }} 项待办</span>
            <button class="calendar-month-add" :aria-label="`在 ${day.key} 新建日程`" @click="openNewEvent(day.date)"><Icon name="plus" size="13" /></button>
          </div>
          <button v-for="event in day.events.slice(0, 3)" :key="event.id" class="calendar-month-event" :class="`calendar-month-event--${categoryTone(event.category)}`" :title="`${event.start} ${event.title}`" @click="openEditEvent(event)">
            <time>{{ event.start }}</time><span>{{ event.title }}</span>
          </button>
          <button v-if="day.events.length > 3" type="button" class="calendar-month-more" :aria-label="`查看 ${day.key} 的全部日程`" @click="showDayInWeek(day.date)">还有 {{ day.events.length - 3 }} 项</button>
        </article>
      </div>
    </section>

    <section class="calendar-task-panel surface-card" aria-labelledby="calendar-task-title">
      <header class="calendar-task-heading">
        <div><span class="section-kicker">按日期安排</span><h2 id="calendar-task-title">{{ selectedDateLabel }} · 待办事项</h2></div>
        <span class="calendar-task-progress">{{ completedSelectedTasks }} / {{ selectedDateTasks.length }} 已完成</span>
      </header>
      <p v-if="taskError" class="calendar-task-error" role="alert">{{ taskError }}</p>
      <ul v-if="selectedDateTasks.length" class="calendar-task-list">
        <li v-for="task in selectedDateTasks" :key="task.id" class="calendar-task-row" :class="{ 'is-done': task.done }">
          <button type="button" class="calendar-task-toggle" :aria-label="task.done ? '标记为未完成' : '标记为完成'" :aria-pressed="task.done" @click="toggleCalendarTask(task)" :disabled="taskSaving"><Icon v-if="task.done" name="check" size="13" /></button>
          <span class="calendar-task-title">{{ task.title }}</span>
          <select class="calendar-task-priority" :aria-label="`设置 ${task.title} 的优先级`" :value="normalizedPriority(task)" :disabled="taskSaving" @change="updateCalendarTaskPriority(task, $event.target.value)"><option value="high">高</option><option value="normal">普通</option><option value="low">低</option></select>
          <button type="button" class="calendar-task-edit" :aria-label="'编辑待办：' + task.title" @click="editCalendarTask(task)" :disabled="taskSaving"><Icon name="edit" size="14" /></button>
          <button type="button" class="calendar-task-delete" :aria-label="`删除待办：${task.title}`" @click="removeCalendarTask(task)" :disabled="taskSaving"><Icon name="trash" size="14" /></button>
        </li>
      </ul>
      <p v-else class="calendar-task-empty">这一天还没有待办。添加一件小事，让安排更清楚。</p>
      <details v-if="unscheduledOpenTasks.length" class="calendar-unscheduled">
        <summary>未安排日期 <span>{{ unscheduledOpenTasks.length }} 件</span></summary>
        <ul>
          <li v-for="task in unscheduledOpenTasks" :key="task.id">
            <span>{{ task.title }}</span>
            <button type="button" :disabled="taskSaving" @click="editCalendarTask(task)">编辑</button>
            <button type="button" :disabled="taskSaving" @click="scheduleUndatedTask(task)">安排到这一天</button>
          </li>
        </ul>
      </details>
      <form class="calendar-task-form" @submit.prevent="addTaskForSelectedDate">
        <input v-model.trim="taskTitle" type="text" maxlength="120" required :disabled="taskSaving" :aria-label="`添加 ${selectedDateLabel} 的待办`" placeholder="添加这一天要完成的事" />
        <select v-model="taskPriority" aria-label="新待办优先级" :disabled="taskSaving"><option value="high">高</option><option value="normal">普通</option><option value="low">低</option></select>
        <button type="submit" :disabled="taskSaving || !taskTitle.trim()"><Icon name="plus" size="15" /> {{ taskSaving ? '保存中…' : '添加待办' }}</button>
      </form>
    </section>
    <div class="calendar-footnote" :class="{ 'calendar-footnote--warning': storageStatus }"><span class="live-dot"></span> {{ storageStatus || '日程和待办保存在本机，不会同步到 GitHub。' }}</div>
    <TaskEditorDialog :open="Boolean(editingTask)" :task="editingTask" @close="editingTask = null" @saved="editingTask = null" />

    <div v-if="modalOpen" class="schedule-modal-backdrop" @click.self="closeModal" @keydown.esc.stop.prevent="closeModal">
      <section class="schedule-modal" role="dialog" aria-modal="true" :aria-labelledby="'schedule-modal-title'">
        <header class="schedule-modal-header">
          <div><span class="section-kicker">日历 · {{ isEditing ? '编辑安排' : '添加安排' }}</span><h2 id="schedule-modal-title">{{ isEditing ? '编辑日程' : '新建日程' }}</h2></div>
          <button class="icon-button" aria-label="关闭" :disabled="formSaving" @click="closeModal"><Icon name="close" size="18" /></button>
        </header>
        <form class="schedule-form" @submit.prevent="saveEvent">
          <label class="schedule-field schedule-field--full"><span>日程标题</span><input v-model.trim="draft.title" autofocus required maxlength="80" placeholder="例如：阅读 RAG 工程学习手册" :disabled="formSaving" /></label>
          <label class="schedule-field schedule-field--full"><span>日期</span><input v-model="draft.date" required type="date" :disabled="formSaving" /></label>
          <label class="schedule-field"><span>开始时间</span><input v-model="draft.start" required type="time" step="1800" :disabled="formSaving" /></label>
          <label class="schedule-field"><span>结束时间</span><input v-model="draft.end" required type="time" step="1800" :disabled="formSaving" /></label>
          <label class="schedule-field schedule-field--full"><span>分类</span><select v-model="draft.category" :disabled="formSaving"><option v-for="category in categories" :key="category.label" :value="category.label">{{ category.label }}</option></select></label>
          <label class="schedule-field schedule-field--full"><span>关联学习书籍 <small>可选</small></span><select v-model="draft.bookId" :disabled="formSaving"><option value="">暂不关联</option><option v-for="book in books" :key="book.id" :value="book.id">{{ book.title }}</option></select></label>
          <p v-if="formError" class="schedule-form-error" role="alert">{{ formError }}</p>
          <footer class="schedule-form-actions">
            <button v-if="isEditing" type="button" class="schedule-delete-button" :disabled="formSaving" @click="deleteEvent">删除日程</button>
            <span v-else></span>
            <div><button type="button" class="button button-secondary" :disabled="formSaving" @click="closeModal">取消</button><button type="submit" class="button button-primary" :disabled="formSaving">{{ formSaving ? '正在保存…' : isEditing ? '保存修改' : '保存日程' }}</button></div>
          </footer>
        </form>
      </section>
    </div>
  </main>
</template>

<style scoped>
.calendar-day-heading { gap: 6px; }
.calendar-day-task-count { min-width: 15px; height: 15px; display: inline-grid; place-items: center; padding: 0 3px; border-radius: 6px; color: #6584ae; background: #edf3fc; font-size: 8px; font-weight: 600; }
.calendar-month-task-count { margin-right: auto; color: #6889b5; font-size: 7px; white-space: nowrap; }
.calendar-unscheduled { margin: 10px 0 0; padding: 10px 12px; border: 1px solid #edf0ed; border-radius: 10px; background: #fbfcfb; }
.calendar-unscheduled summary { display: flex; align-items: center; justify-content: space-between; color: #697789; font-size: 10px; cursor: pointer; list-style-position: inside; }
.calendar-unscheduled summary span { color: #929eac; font-size: 9px; }
.calendar-unscheduled ul { display: grid; gap: 2px; margin: 8px 0 0; padding: 0; list-style: none; }
.calendar-unscheduled li { display: flex; align-items: center; justify-content: space-between; gap: 10px; min-height: 34px; border-top: 1px solid #edf0ed; }
.calendar-unscheduled li > span { min-width: 0; overflow: hidden; color: #5d6b7d; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.calendar-unscheduled li button { flex: 0 0 auto; padding: 6px 8px; border: 0; border-radius: 7px; color: #5e82b3; background: #f0f5fc; font: inherit; font-size: 9px; cursor: pointer; }
.calendar-unscheduled li button:disabled { opacity: .5; cursor: not-allowed; }
.calendar-footnote--warning { color: #b96e63; }
.calendar-footnote--warning .live-dot { background: #cf8a7f; }
.calendar-day-heading > button:first-of-type { width: 25px; height: 25px; display: grid; place-items: center; padding: 0; border: 0; border-radius: 50%; color: #586577; background: transparent; font-size: 10px; font-weight: 550; cursor: pointer; }
.calendar-day-heading--today > button:first-of-type { color: #fff; background: #4c87ea; box-shadow: 0 3px 8px rgba(67,127,226,.2); }
.calendar-day-heading--selected:not(.calendar-day-heading--today) > button:first-of-type { color: #4b83d9; background: #eaf2ff; }
.calendar-day-heading .calendar-day-add { display: none; width: 20px; height: 20px; place-items: center; padding: 0; border: 0; border-radius: 6px; color: #7c8ba0; background: #f2f5f8; cursor: pointer; }
.calendar-day-heading:hover .calendar-day-add, .calendar-day-add:focus-visible { display: grid; }
.calendar-time-column { grid-template-rows: repeat(28, 30px); }
.calendar-time-column span { grid-row: span 2; }
.calendar-days-grid, .calendar-day-column { grid-template-rows: repeat(28, 30px); }
.calendar-event { width: auto; display: block; border: 0; border-left: 2px solid #76a2df; text-align: left; cursor: pointer; }
.calendar-event--blue { border-left-color: #76a2df; background: #eef4fd; }
.calendar-event--blue strong { color: #5577a5; }
.calendar-event--blue span { color: #8697ae; }
.calendar-event--blue:hover, .calendar-event--lavender:hover, .calendar-event--mint:hover, .calendar-event--peach:hover { filter: brightness(.98); }
.calendar-month-panel { padding: 0; overflow: auto; }
.calendar-month-grid { min-width: 760px; display: grid; grid-template-columns: repeat(7, minmax(90px, 1fr)); grid-template-rows: 38px repeat(6, minmax(108px, auto)); }
.calendar-month-weekday { display: grid; place-items: center; border-bottom: 1px solid #edf0f3; color: #929baa; font-size: 9px; }
.calendar-month-day { min-width: 0; min-height: 108px; padding: 7px 6px 6px; border-right: 1px solid #f0f2f5; border-bottom: 1px solid #f0f2f5; background: rgba(255,255,255,.7); }
.calendar-month-day:nth-child(7n) { border-right: 0; }
.calendar-month-day.is-outside-month { background: #fafbfc; }
.calendar-month-day.is-selected { background: #f7faff; box-shadow: inset 0 0 0 1px rgba(89,139,218,.13); }
.calendar-month-day-top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 5px; }
.calendar-month-date, .calendar-month-add { border: 0; cursor: pointer; }
.calendar-month-date { width: 23px; height: 23px; display: grid; place-items: center; border-radius: 50%; color: #5d6878; background: transparent; font-size: 9px; }
.calendar-month-date.is-today { color: white; background: #4c87ea; }
.is-outside-month .calendar-month-date { color: #b5bcc6; }
.calendar-month-add { width: 21px; height: 21px; display: grid; place-items: center; border-radius: 6px; color: #9aa5b4; background: transparent; opacity: .55; }
.calendar-month-day:hover .calendar-month-add, .calendar-month-add:focus-visible { background: #f0f4f9; opacity: 1; }
.calendar-month-event { width: 100%; min-width: 0; display: flex; align-items: center; gap: 4px; margin-top: 3px; padding: 4px 5px; overflow: hidden; border: 0; border-radius: 5px; text-align: left; cursor: pointer; }
.calendar-month-event time { flex: 0 0 auto; font-size: 7px; opacity: .78; }
.calendar-month-event span { overflow: hidden; font-size: 8px; text-overflow: ellipsis; white-space: nowrap; }
.calendar-month-event--blue { color: #5577a5; background: #eef4fd; }
.calendar-month-event--lavender { color: #8176b4; background: #f2f0fa; }
.calendar-month-event--mint { color: #5e907d; background: #eef6f1; }
.calendar-month-event--peach { color: #ad8064; background: #fbf2eb; }
.calendar-month-more { display: block; width: 100%; padding: 4px 5px 0; border: 0; color: #7186a3; background: transparent; font: inherit; font-size: 7px; text-align: left; cursor: pointer; }
.calendar-month-more:hover { color: #426da8; text-decoration: underline; text-underline-offset: 2px; }
.schedule-modal-backdrop { position: fixed; z-index: 100; inset: 0; display: grid; place-items: center; padding: 20px; background: rgba(28,37,51,.26); backdrop-filter: blur(7px); }
.schedule-modal { width: min(100%, 460px); max-height: min(92vh, 720px); overflow: auto; padding: 22px; border: 1px solid rgba(255,255,255,.9); border-radius: 18px; background: #fff; box-shadow: 0 24px 72px rgba(35,48,68,.2); }
.schedule-modal-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 20px; }
.schedule-modal-header h2 { margin: 6px 0 0; color: #303949; font-size: 19px; font-weight: 620; letter-spacing: -.03em; }
.schedule-modal-header .section-kicker { font-size: 9px; }
.schedule-form { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px 12px; }
.schedule-field { min-width: 0; display: grid; gap: 6px; color: #667284; font-size: 10px; font-weight: 550; }
.schedule-field--full { grid-column: 1 / -1; }
.schedule-field small { margin-left: 4px; color: #a4acb8; font-size: 9px; font-weight: 400; }
.schedule-field input, .schedule-field select { width: 100%; height: 39px; padding: 0 11px; border: 1px solid #e7ebf0; border-radius: 9px; color: #3e4a5c; background: #fbfcfd; font: inherit; font-size: 11px; }
.schedule-field input:focus, .schedule-field select:focus { border-color: #a9c6f3; outline: 3px solid rgba(75,134,238,.12); }
.schedule-form-error { grid-column: 1 / -1; margin: -3px 0 0; color: #bf6c61; font-size: 10px; }
.schedule-form-actions { grid-column: 1 / -1; display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 7px; padding-top: 16px; border-top: 1px solid #edf0f3; }
.schedule-form-actions > div { display: flex; align-items: center; gap: 8px; }
.schedule-form-actions .button { min-height: 35px; font-size: 10px; }
.schedule-delete-button { padding: 7px 0; border: 0; color: #c26e65; background: transparent; font-size: 10px; cursor: pointer; }
.schedule-delete-button:hover { color: #a94f45; }

@media (max-width: 640px) {
  .calendar-week-panel { overflow: auto; }
  .calendar-month-grid { min-width: 680px; grid-template-columns: repeat(7, minmax(80px, 1fr)); grid-template-rows: 34px repeat(6, minmax(96px, auto)); }
  .calendar-month-day { min-height: 96px; padding: 5px 4px; }
  .calendar-month-event time { display: none; }
  .calendar-month-event { padding: 4px; }
  .calendar-month-event span { font-size: 7px; }
  .schedule-modal-backdrop { align-items: end; padding: 0; }
  .schedule-modal { width: 100%; max-height: 92vh; padding: 20px 18px max(20px, env(safe-area-inset-bottom)); border-radius: 19px 19px 0 0; }
}
.calendar-task-panel { margin-top: 14px; padding: 18px 20px; }
.calendar-task-heading { display: flex; align-items: center; justify-content: space-between; gap: 14px; }
.calendar-task-heading h2 { margin: 5px 0 0; color: #354155; font-size: 15px; font-weight: 620; letter-spacing: -.02em; }
.calendar-task-progress { color: #8190a2; font-size: 10px; white-space: nowrap; }
.calendar-task-list { display: grid; gap: 2px; margin: 12px 0 0; padding: 0; list-style: none; }
.calendar-task-row { min-height: 42px; display: flex; align-items: center; gap: 10px; border-top: 1px solid #edf0ed; }
.calendar-task-toggle { width: 20px; height: 20px; flex: 0 0 20px; display: grid; place-items: center; border: 1px solid #cfd7dd; border-radius: 6px; color: #fff; background: #fff; cursor: pointer; }
.calendar-task-row.is-done .calendar-task-toggle { border-color: #78a28a; background: #78a28a; }
.calendar-task-toggle:disabled, .calendar-task-delete:disabled { opacity: .55; cursor: wait; }
.calendar-task-title { min-width: 0; flex: 1; overflow-wrap: anywhere; color: #566477; font-size: 11px; line-height: 1.55; }
.calendar-task-row.is-done .calendar-task-title { color: #9ba5af; text-decoration: line-through; }
.calendar-task-delete { width: 30px; height: 30px; display: grid; place-items: center; border: 0; border-radius: 8px; color: #a3abb5; background: transparent; cursor: pointer; }
.calendar-task-delete:hover { color: #b36862; background: #fbf2f1; }
.calendar-task-edit { width: 30px; height: 30px; display: grid; place-items: center; border: 0; border-radius: 8px; color: #99a4b2; background: transparent; cursor: pointer; }
.calendar-task-edit:hover { color: #5d82b7; background: #f1f5fb; }
.calendar-task-edit:disabled { opacity: .55; cursor: wait; }
.calendar-task-empty { margin: 12px 0; color: #8491a0; font-size: 11px; }
.calendar-task-form { display: flex; gap: 8px; margin-top: 12px; padding-top: 12px; border-top: 1px solid #edf0ed; }
.calendar-task-form input { min-width: 0; min-height: 38px; flex: 1; padding: 0 11px; border: 1px solid #e5e9e5; border-radius: 10px; outline: 0; color: #4c5a6d; background: #fcfdfb; font: inherit; font-size: 11px; }
.calendar-task-form input:focus { border-color: #a9c1df; box-shadow: 0 0 0 3px rgba(87,137,211,.1); }
.calendar-task-form select { width: 64px; flex: 0 0 64px; min-height: 38px; padding: 0 6px; border: 1px solid #e5e9e5; border-radius: 9px; color: #637184; background: #fcfdfb; font: inherit; font-size: 10px; }
.calendar-task-form select:disabled { opacity: .55; }
.calendar-task-priority { flex: 0 0 48px; min-height: 27px; padding: 0 2px; border: 1px solid transparent; border-radius: 6px; color: #7e8997; background: transparent; font: inherit; font-size: 9px; cursor: pointer; }
.calendar-task-priority:focus-visible { border-color: #dce5f1; outline: 2px solid rgba(89,139,218,.12); }
.calendar-task-priority:disabled { opacity: .55; cursor: wait; }
.calendar-task-form button { min-height: 38px; display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 0 12px; border: 0; border-radius: 10px; color: #fff; background: #5e89c4; font: inherit; font-size: 10px; font-weight: 600; cursor: pointer; }
.calendar-task-form button:disabled { opacity: .5; cursor: not-allowed; }
.calendar-task-error { margin: 10px 0; color: #b65f58; font-size: 10px; }
@media (max-width: 640px) { .calendar-task-panel { padding: 15px; } .calendar-task-heading h2 { font-size: 13px; } .calendar-task-title { font-size: 10px; } .calendar-task-form button { padding: 0 9px; font-size: 9px; } }
</style>
