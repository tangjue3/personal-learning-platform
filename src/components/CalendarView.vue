<script setup>
import { computed, ref, watch } from 'vue'
import Icon from './Icon.vue'
import { getLocalRecords, localDataState, saveLocalRecord, deleteLocalRecord } from '../services/localDataStore.js'

const props = defineProps({ books: { type: Array, default: () => [] } })
const mode = ref('周')
const focusDate = ref(new Date())
const today = new Date()
const modalOpen = ref(false)
const formError = ref('')
const draft = ref(createEmptyDraft())
const storageStatus = ref('')

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
    if (!saved) return []
    const payload = JSON.parse(saved)
    if (payload?.version !== 1 || !Array.isArray(payload.events)) {
      throw new Error('日历数据格式不受支持。')
    }

    return payload.events.map(normalizeStoredEvent).filter((event) => event && !String(event.id).startsWith('demo-'))
  } catch (error) {
    console.warn('无法迁移旧版本地日程。', error)
    storageStatus.value = '旧版本地日程无法迁移，请先导出或检查浏览器数据。'
    return []
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
    if (legacyEvents.length) {
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
const startOfVisibleWeek = computed(() => startOfWeek(focusDate.value))
const weekDays = computed(() => Array.from({ length: 7 }, (_, index) => {
  const date = new Date(startOfVisibleWeek.value)
  date.setDate(date.getDate() + index)
  return {
    date,
    key: toDateKey(date),
    label: ['一', '二', '三', '四', '五', '六', '日'][index],
    isToday: toDateKey(date) === toDateKey(today),
    events: sortedEvents.value.filter((event) => event.date === toDateKey(date)),
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
    return {
      date,
      key,
      inMonth: date.getMonth() === focusDate.value.getMonth(),
      isToday: key === toDateKey(today),
      isSelected: key === toDateKey(focusDate.value),
      events: sortedEvents.value.filter((event) => event.date === key),
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
  focusDate.value = new Date(today)
}

function openNewEvent(date = focusDate.value) {
  draft.value = createEmptyDraft(date)
  formError.value = ''
  modalOpen.value = true
}

function openEditEvent(event) {
  draft.value = { ...event }
  formError.value = ''
  modalOpen.value = true
}

function closeModal() {
  modalOpen.value = false
  formError.value = ''
}

async function saveEvent() {
  if (draft.value.end <= draft.value.start) {
    formError.value = '结束时间需要晚于开始时间。'
    return
  }

  const event = { ...draft.value, id: draft.value.id || createEventId() }
  const { id, ...data } = event
  try {
    await saveLocalRecord('calendar', String(id), data)
    calendarEvents.value = getLocalRecords('calendar').map(normalizeStoredEvent).filter(Boolean)
    focusDate.value = fromDateKey(event.date)
    closeModal()
  } catch (error) {
    formError.value = error.message
  }
}

async function deleteEvent() {
  try {
    await deleteLocalRecord('calendar', String(draft.value.id))
    calendarEvents.value = getLocalRecords('calendar').map(normalizeStoredEvent).filter(Boolean)
    closeModal()
  } catch (error) {
    formError.value = error.message
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
            <button class="calendar-month-add" :aria-label="`在 ${day.key} 新建日程`" @click="openNewEvent(day.date)"><Icon name="plus" size="13" /></button>
          </div>
          <button v-for="event in day.events.slice(0, 3)" :key="event.id" class="calendar-month-event" :class="`calendar-month-event--${categoryTone(event.category)}`" :title="`${event.start} ${event.title}`" @click="openEditEvent(event)">
            <time>{{ event.start }}</time><span>{{ event.title }}</span>
          </button>
          <span v-if="day.events.length > 3" class="calendar-month-more">还有 {{ day.events.length - 3 }} 项</span>
        </article>
      </div>
    </section>

    <div class="calendar-footnote" :class="{ 'calendar-footnote--warning': storageStatus }"><span class="live-dot"></span> {{ storageStatus || '日程保存在本机，不会同步到 GitHub。' }}</div>

    <div v-if="modalOpen" class="schedule-modal-backdrop" @click.self="closeModal" @keydown.esc.stop.prevent="closeModal">
      <section class="schedule-modal" role="dialog" aria-modal="true" :aria-labelledby="'schedule-modal-title'">
        <header class="schedule-modal-header">
          <div><span class="section-kicker">日历 · {{ isEditing ? '编辑安排' : '添加安排' }}</span><h2 id="schedule-modal-title">{{ isEditing ? '编辑日程' : '新建日程' }}</h2></div>
          <button class="icon-button" aria-label="关闭" @click="closeModal"><Icon name="close" size="18" /></button>
        </header>
        <form class="schedule-form" @submit.prevent="saveEvent">
          <label class="schedule-field schedule-field--full"><span>日程标题</span><input v-model.trim="draft.title" autofocus required maxlength="80" placeholder="例如：阅读 RAG 工程学习手册" /></label>
          <label class="schedule-field schedule-field--full"><span>日期</span><input v-model="draft.date" required type="date" /></label>
          <label class="schedule-field"><span>开始时间</span><input v-model="draft.start" required type="time" step="1800" /></label>
          <label class="schedule-field"><span>结束时间</span><input v-model="draft.end" required type="time" step="1800" /></label>
          <label class="schedule-field schedule-field--full"><span>分类</span><select v-model="draft.category"><option v-for="category in categories" :key="category.label" :value="category.label">{{ category.label }}</option></select></label>
          <label class="schedule-field schedule-field--full"><span>关联学习书籍 <small>可选</small></span><select v-model="draft.bookId"><option value="">暂不关联</option><option v-for="book in books" :key="book.id" :value="book.id">{{ book.title }}</option></select></label>
          <p v-if="formError" class="schedule-form-error" role="alert">{{ formError }}</p>
          <footer class="schedule-form-actions">
            <button v-if="isEditing" type="button" class="schedule-delete-button" @click="deleteEvent">删除日程</button>
            <span v-else></span>
            <div><button type="button" class="button button-secondary" @click="closeModal">取消</button><button type="submit" class="button button-primary">{{ isEditing ? '保存修改' : '保存日程' }}</button></div>
          </footer>
        </form>
      </section>
    </div>
  </main>
</template>

<style scoped>
.calendar-day-heading { gap: 6px; }
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
.calendar-month-more { display: block; padding: 4px 5px 0; color: #9aa3af; font-size: 7px; }
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
</style>
