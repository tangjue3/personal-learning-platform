<script setup>
import { computed } from 'vue'
import Icon from './Icon.vue'
import { isReviewDue } from '../services/reviewSchedule.js'
import { getLocalRecords } from '../services/localDataStore.js'

const props = defineProps({ books: { type: Array, default: () => [] } })
const emit = defineEmits(['open-book'])

const themeColors = {
  blue: '#6e98d4', sand: '#c2a878', night: '#3f4a63', sky: '#7fb3d8',
  peach: '#d9a08a', mist: '#9db4c4', forest: '#7ba184',
}

function dateKey(date) {
  return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0')
}

/** 汇总每天的活跃类型（阅读 / 复习 / 笔记），热力图和总览都从这里取数。 */
const activityByDay = computed(() => {
  const activity = new Map()
  const mark = (day, type) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day || ''))) return
    if (!activity.has(day)) activity.set(day, new Set())
    activity.get(day).add(type)
  }
  for (const record of getLocalRecords('reader')) {
    for (const day of (Array.isArray(record.readDays) ? record.readDays : [])) mark(day, 'read')
  }
  for (const record of getLocalRecords('preference')) {
    if (/^review-stats-\d{4}-\d{2}-\d{2}$/.test(String(record.id || '')) && Number(record.total) > 0) {
      mark(record.date || String(record.id).slice('review-stats-'.length), 'review')
    }
    if (/^reading-time-\d{4}-\d{2}-\d{2}$/.test(String(record.id || '')) && Number(record.totalSeconds) > 0) {
      mark(String(record.id).slice('reading-time-'.length), 'read')
    }
  }
  for (const note of getLocalRecords('note')) mark(String(note.createdAt || '').slice(0, 10), 'note')
  return activity
})

const heatmap = computed(() => {
  const today = new Date()
  today.setHours(12, 0, 0, 0)
  const end = new Date(today)
  end.setDate(end.getDate() + ((7 - ((end.getDay() + 6) % 7)) % 7))
  const start = new Date(end)
  start.setDate(start.getDate() - 26 * 7)
  const weeks = []
  for (let week = 0; week < 26; week += 1) {
    const days = []
    for (let day = 0; day < 7; day += 1) {
      const date = new Date(start)
      date.setDate(start.getDate() + week * 7 + day)
      const key = dateKey(date)
      days.push({
        key,
        level: date <= today ? Math.min(3, activityByDay.value.get(key)?.size || 0) : -1,
        isToday: key === dateKey(today),
      })
    }
    weeks.push(days)
  }
  return weeks
})

const activeDays = computed(() => activityByDay.value.size)

const studyStreak = computed(() => {
  const cursor = new Date()
  cursor.setHours(12, 0, 0, 0)
  if (!activityByDay.value.has(dateKey(cursor))) cursor.setDate(cursor.getDate() - 1)
  let count = 0
  while (activityByDay.value.has(dateKey(cursor)) && count < 365) {
    count += 1
    cursor.setDate(cursor.getDate() - 1)
  }
  return count
})

const cards = computed(() => getLocalRecords('review'))
const dueCards = computed(() => cards.value.filter((card) => isReviewDue(card)))
const notes = computed(() => getLocalRecords('note'))

const reviewDailyStats = computed(() => {
  const today = currentDateKey()
  let todayTotal = 0
  let todayRemembered = 0
  for (const record of getLocalRecords('preference')) {
    if (String(record.id || '') !== `review-stats-${today}`) continue
    todayTotal = Number(record.total) || 0
    todayRemembered = (Number(record.counts?.good) || 0) + (Number(record.counts?.easy) || 0)
  }
  return { todayTotal, accuracy: todayTotal ? Math.round((todayRemembered / todayTotal) * 100) : null }
})

function currentDateKey() {
  return dateKey(new Date())
}

const DAY_MS = 24 * 60 * 60 * 1000

/** reading-time-日期 记录由阅读器心跳写入：totalSeconds + byBook + byHour。 */
const readingTimeByDay = computed(() => {
  const map = new Map()
  for (const record of getLocalRecords('preference')) {
    if (!/^reading-time-\d{4}-\d{2}-\d{2}$/.test(String(record.id || ''))) continue
    const day = String(record.id).slice('reading-time-'.length)
    map.set(day, {
      totalSeconds: Number(record.totalSeconds) || 0,
      byBook: record.byBook && typeof record.byBook === 'object' ? record.byBook : {},
      byHour: record.byHour && typeof record.byHour === 'object' ? record.byHour : {},
    })
  }
  return map
})

const reviewStatsByDay = computed(() => {
  const map = new Map()
  for (const record of getLocalRecords('preference')) {
    if (!/^review-stats-\d{4}-\d{2}-\d{2}$/.test(String(record.id || ''))) continue
    map.set(String(record.id).slice('review-stats-'.length), {
      total: Number(record.total) || 0,
      remembered: (Number(record.counts?.good) || 0) + (Number(record.counts?.easy) || 0),
    })
  }
  return map
})

const todayReadingMinutes = computed(() => Math.round((readingTimeByDay.value.get(currentDateKey())?.totalSeconds || 0) / 60))
const weekReadingSeconds = computed(() => {
  const cutoff = dateKey(new Date(Date.now() - 6 * DAY_MS))
  let total = 0
  for (const [day, data] of readingTimeByDay.value) {
    if (day >= cutoff) total += data.totalSeconds
  }
  return total
})

const readingTrend = computed(() => {
  const days = []
  for (let index = 13; index >= 0; index -= 1) {
    const key = dateKey(new Date(Date.now() - index * DAY_MS))
    days.push({
      key,
      minutes: Math.round((readingTimeByDay.value.get(key)?.totalSeconds || 0) / 60),
      label: `${Number(key.slice(5, 7))}/${Number(key.slice(8, 10))}`,
    })
  }
  return days
})
const readingTrendPeak = computed(() => Math.max(30, ...readingTrend.value.map((day) => day.minutes)))

const timeBuckets = computed(() => {
  const ranges = [
    { label: '凌晨 0-5', from: 0, to: 5 },
    { label: '早晨 6-8', from: 6, to: 8 },
    { label: '上午 9-11', from: 9, to: 11 },
    { label: '中午 12-13', from: 12, to: 13 },
    { label: '下午 14-17', from: 14, to: 17 },
    { label: '傍晚 18-19', from: 18, to: 19 },
    { label: '晚上 20-22', from: 20, to: 22 },
    { label: '深夜 23', from: 23, to: 23 },
  ]
  const byHour = new Map()
  for (const data of readingTimeByDay.value.values()) {
    for (const [hour, seconds] of Object.entries(data.byHour)) byHour.set(hour, (byHour.get(hour) || 0) + seconds)
  }
  const secondsIn = (range) => {
    let sum = 0
    for (let hour = range.from; hour <= range.to; hour += 1) sum += byHour.get(String(hour)) || 0
    return sum
  }
  const peak = Math.max(1, ...ranges.map(secondsIn))
  return ranges.map((range) => {
    const seconds = secondsIn(range)
    return { label: range.label, minutes: Math.round(seconds / 60), percent: Math.round((seconds / peak) * 100) }
  })
})

const bookReadingMinutes = computed(() => {
  const cutoff = dateKey(new Date(Date.now() - 29 * DAY_MS))
  const totals = new Map()
  for (const [day, data] of readingTimeByDay.value) {
    if (day < cutoff) continue
    for (const [bookId, seconds] of Object.entries(data.byBook)) {
      totals.set(bookId, (totals.get(bookId) || 0) + seconds)
    }
  }
  return totals
})

const reviewWeekStats = computed(() => {
  const cutoff = dateKey(new Date(Date.now() - 6 * DAY_MS))
  let total = 0
  let remembered = 0
  for (const [day, data] of reviewStatsByDay.value) {
    if (day < cutoff) continue
    total += data.total
    remembered += data.remembered
  }
  return { total, accuracy: total ? Math.round((remembered / total) * 100) : null }
})

function formatMinutes(minutes) {
  if (!minutes) return '0 分钟'
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (!hours) return `${minutes} 分钟`
  return rest ? `${hours} 小时 ${rest} 分` : `${hours} 小时`
}

const bookRows = computed(() => [...props.books]
  .sort((a, b) => String(b.lastReadAt || '').localeCompare(String(a.lastReadAt || '')) || a.title.localeCompare(b.title, 'zh-CN'))
  .map((book) => {
    const chapters = Array.isArray(book.documents) ? book.documents.length : Number(book.chapters) || 0
    const record = getLocalRecords('reader').find((item) => item.id === String(book.id))
    const completed = Array.isArray(record?.completedChapterIds) ? record.completedChapterIds.length : null
    return {
      id: book.id,
      title: book.title,
      color: themeColors[book.theme] || themeColors.blue,
      format: book.format || 'markdown',
      progress: Math.min(100, Math.max(0, Number(book.progress) || 0)),
      chapters,
      completed,
      lastReadAt: book.lastReadAt || '',
      minutes: Math.round((bookReadingMinutes.value.get(String(book.id)) || 0) / 60),
    }
  }))

function formatDay(value) {
  if (!value) return '还没开始'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '还没开始'
  return new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric' }).format(date)
}

function bookMeta(row) {
  if (row.format === 'pdf') return `${row.progress}% · 最近 ${formatDay(row.lastReadAt)}`
  if (row.format === 'epub') return `${row.progress}% · 最近 ${formatDay(row.lastReadAt)}`
  return row.chapters
    ? `已读 ${row.completed ?? 0} / ${row.chapters} 章 · 最近 ${formatDay(row.lastReadAt)}`
    : `最近 ${formatDay(row.lastReadAt)}`
}
</script>

<template>
  <main class="page-content stats-page">
    <header class="page-heading stats-heading">
      <div><span class="eyebrow-label"><Icon name="trend" size="15" /> 看得见的积累</span><h1>学习统计</h1><p>所有数据都来自这台电脑上的真实学习记录。</p></div>
    </header>

    <section class="stats-overview">
      <article class="surface-card stats-metric"><span class="section-kicker">今日阅读</span><strong>{{ todayReadingMinutes }}<small> 分钟</small></strong><span class="stats-metric-note">打开阅读器并停留的时间</span></article>
      <article class="surface-card stats-metric"><span class="section-kicker">本周阅读</span><strong>{{ formatMinutes(Math.round(weekReadingSeconds / 60)) }}</strong><span class="stats-metric-note">最近 7 天的真实投入</span></article>
      <article class="surface-card stats-metric"><span class="section-kicker">累计学习</span><strong>{{ activeDays }}<small> 天</small></strong><span class="stats-metric-note">阅读、复习或记笔记的日子</span></article>
      <article class="surface-card stats-metric"><span class="section-kicker">连续打卡</span><strong>{{ studyStreak }}<small> 天</small></strong><span class="stats-metric-note">今天读一点就能延续</span></article>
      <article class="surface-card stats-metric"><span class="section-kicker">私人笔记</span><strong>{{ notes.length }}<small> 条</small></strong><span class="stats-metric-note">只保存在本机</span></article>
      <article class="surface-card stats-metric"><span class="section-kicker">待复习</span><strong>{{ dueCards.length }}<small> 张</small></strong><span class="stats-metric-note">共 {{ cards.length }} 张知识卡片</span></article>
    </section>

    <section class="surface-card stats-panel">
      <header class="stats-panel-heading"><div><span class="section-kicker">学习热力图</span><h2>最近 26 周</h2></div><div class="stats-heatmap-legend"><span>少</span><i class="level-0"></i><i class="level-1"></i><i class="level-2"></i><i class="level-3"></i><span>多</span></div></header>
      <div class="stats-heatmap" role="img" aria-label="最近 26 周的学习热力图">
        <div class="stats-heatmap-days" aria-hidden="true"><span>一</span><span></span><span>三</span><span></span><span>五</span><span></span><span>日</span></div>
        <div class="stats-heatmap-grid">
          <div v-for="(week, weekIndex) in heatmap" :key="weekIndex" class="stats-heatmap-week">
            <i v-for="day in week" :key="day.key" class="stats-heatmap-cell" :class="[`level-${day.level}`, { 'is-today': day.isToday }]" :title="day.key"></i>
          </div>
        </div>
      </div>
    </section>

    <div class="stats-columns">
      <section class="surface-card stats-panel">
        <header class="stats-panel-heading"><div><span class="section-kicker">阅读投入</span><h2>最近 14 天的阅读时长</h2></div></header>
        <div class="stats-bar-chart" role="img" aria-label="最近 14 天每天的阅读分钟数">
          <div v-for="day in readingTrend" :key="day.key" class="stats-bar-column">
            <span class="stats-bar-value">{{ day.minutes || '' }}</span>
            <i :style="{ height: `${Math.max(day.minutes ? 4 : 2, Math.round((day.minutes / readingTrendPeak) * 100))}%` }" :class="{ 'is-empty': !day.minutes }"></i>
            <span class="stats-bar-label">{{ day.label }}</span>
          </div>
        </div>
      </section>

      <section class="surface-card stats-panel">
        <header class="stats-panel-heading"><div><span class="section-kicker">学习时段</span><h2>你习惯什么时候读</h2></div></header>
        <div class="stats-hour-rows">
          <div v-for="bucket in timeBuckets" :key="bucket.label" class="stats-hour-row">
            <span class="stats-hour-label">{{ bucket.label }}</span>
            <span class="stats-hour-track"><i :style="{ width: `${bucket.percent}%` }"></i></span>
            <strong>{{ bucket.minutes ? formatMinutes(bucket.minutes) : '—' }}</strong>
          </div>
        </div>
      </section>
    </div>

    <div class="stats-columns">
      <section class="surface-card stats-panel">
        <header class="stats-panel-heading"><div><span class="section-kicker">书籍投入</span><h2>{{ bookRows.length }} 本在学习</h2></div></header>
        <div v-if="bookRows.length" class="stats-book-list">
          <button v-for="row in bookRows" :key="row.id" type="button" class="stats-book-row" @click="emit('open-book', props.books.find((book) => book.id === row.id))">
            <span class="stats-book-spine" :style="{ background: row.color }"></span>
            <span class="stats-book-copy"><strong>{{ row.title }}</strong><small>{{ bookMeta(row) }}</small><span class="progress-track"><i :style="{ width: `${row.progress}%` }"></i></span></span>
            <span class="stats-book-side"><strong>{{ row.minutes ? formatMinutes(row.minutes) : '—' }}</strong><span>近 30 天</span></span>
            <span class="stats-book-progress">{{ row.progress }}%</span>
          </button>
        </div>
        <p v-else class="stats-panel-empty">书架里还没有书，先去导入一门课程吧。</p>
      </section>

      <section class="surface-card stats-panel">
        <header class="stats-panel-heading"><div><span class="section-kicker">复习情况</span><h2>今天回顾了吗</h2></div></header>
        <div class="stats-review-grid">
          <div class="stats-review-item"><strong>{{ reviewDailyStats.todayTotal }}</strong><span>今日已复习</span></div>
          <div class="stats-review-item"><strong>{{ reviewDailyStats.accuracy === null ? '—' : reviewDailyStats.accuracy + '%' }}</strong><span>今日记得率</span></div>
          <div class="stats-review-item"><strong>{{ reviewWeekStats.total }}</strong><span>近 7 天复习</span></div>
          <div class="stats-review-item"><strong>{{ reviewWeekStats.accuracy === null ? '—' : reviewWeekStats.accuracy + '%' }}</strong><span>近 7 天记得率</span></div>
          <div class="stats-review-item"><strong>{{ dueCards.length }}</strong><span>等待复习</span></div>
          <div class="stats-review-item"><strong>{{ cards.length }}</strong><span>卡片总数</span></div>
        </div>
        <p class="stats-panel-note">记得率按「记得 + 简单」占评分的比例计算；阅读时长来自阅读器心跳，离开页面或长时间无操作会自动暂停。</p>
      </section>
    </div>
  </main>
</template>

<style scoped>
.stats-heading { align-items: center; }
.stats-heading h1 { margin-top: 7px; }
.stats-overview { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 12px; }
.stats-metric { display: grid; gap: 6px; padding: 16px 15px; }
.stats-metric strong { color: #2f3c4f; font-size: 22px; font-weight: 650; letter-spacing: -.03em; }
.stats-metric small { color: #7d8b9e; font-size: 12.5px; font-weight: 500; }
.stats-metric-note { color: #97a1ad; font-size: 11.5px; line-height: 1.5; }
.stats-bar-chart { display: grid; grid-template-columns: repeat(14, minmax(0, 1fr)); gap: 7px; align-items: end; min-height: 168px; padding-top: 6px; }
.stats-bar-column { display: grid; grid-template-rows: 1fr auto auto; justify-items: center; align-items: end; gap: 5px; height: 100%; }
.stats-bar-column i { width: 100%; max-width: 26px; border-radius: 5px 5px 2px 2px; background: linear-gradient(180deg, #79a8dc, #5b8cc4); min-height: 2px; }
.stats-bar-column i.is-empty { background: #edf0f4; }
.stats-bar-value { color: #7d8b9e; font-size: 10px; line-height: 1; min-height: 12px; }
.stats-bar-label { color: #9aa4b0; font-size: 10px; white-space: nowrap; }
.stats-hour-rows { display: grid; gap: 9px; align-content: start; }
.stats-hour-row { display: grid; grid-template-columns: 74px minmax(0, 1fr) auto; align-items: center; gap: 10px; }
.stats-hour-label { color: #8b97a6; font-size: 11.5px; white-space: nowrap; }
.stats-hour-track { height: 9px; border-radius: 5px; background: #eef1f5; overflow: hidden; }
.stats-hour-track i { display: block; height: 100%; border-radius: 5px; background: linear-gradient(90deg, #9cc0e8, #6b9fd6); }
.stats-hour-row strong { color: #5b6b80; font-size: 11.5px; font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }
.stats-book-side { display: grid; flex: 0 0 auto; gap: 3px; justify-items: end; }
.stats-book-side strong { color: #46536a; font-size: 12.5px; font-weight: 620; font-variant-numeric: tabular-nums; }
.stats-book-side span { color: #a2abb6; font-size: 10px; }
.stats-panel { padding: 17px 18px; }
.stats-panel-heading { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
.stats-panel-heading h2 { margin: 5px 0 0; color: #39465a; font-size: 14px; font-weight: 620; }
.stats-heatmap-legend { display: flex; align-items: center; gap: 4px; color: #9aa4b0; font-size: 12px; }
.stats-heatmap-legend i { width: 11px; height: 11px; border-radius: 3px; }
.stats-heatmap { display: flex; gap: 6px; overflow-x: auto; padding-bottom: 4px; }
.stats-heatmap-days { display: grid; grid-template-rows: repeat(7, 15px); gap: 3px; padding-top: 1px; color: #9aa4b0; font-size: 11px; text-align: right; }
.stats-heatmap-grid { display: flex; gap: 3px; }
.stats-heatmap-week { display: grid; grid-template-rows: repeat(7, 15px); gap: 3px; }
.stats-heatmap-cell { width: 15px; height: 15px; border-radius: 3px; background: #eef1ee; }
.stats-heatmap-cell.level-0 { background: #eef1ee; }
.stats-heatmap-cell.level-1 { background: #c9ddf3; }
.stats-heatmap-cell.level-2 { background: #9cc0e8; }
.stats-heatmap-cell.level-3 { background: #6b9fd6; }
.stats-heatmap-cell.level--1 { background: transparent; }
.stats-heatmap-cell.is-today { box-shadow: inset 0 0 0 1.5px #4c87ea; }
.stats-columns { display: grid; grid-template-columns: minmax(0, 1.5fr) minmax(220px, 1fr); gap: 12px; margin-top: 12px; }
.stats-book-list { display: grid; gap: 4px; }
.stats-book-row { width: 100%; display: flex; align-items: center; gap: 11px; padding: 8px 7px; border: 0; border-radius: 10px; background: transparent; text-align: left; cursor: pointer; }
.stats-book-row:hover { background: #f4f6f3; }
.stats-book-spine { width: 7px; height: 38px; flex: 0 0 7px; border-radius: 3px; }
.stats-book-copy { min-width: 0; flex: 1; display: grid; gap: 4px; }
.stats-book-copy strong { overflow: hidden; color: #46536a; font-size: 13.5px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.stats-book-copy small { color: #929ca8; font-size: 12px; }
.stats-book-copy .progress-track { height: 4px; }
.stats-book-progress { flex: 0 0 auto; color: #8b95a1; font-size: 12.5px; font-variant-numeric: tabular-nums; }
.stats-review-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 9px; }
.stats-review-item { display: grid; gap: 4px; padding: 11px 12px; border: 1px solid #edf0ec; border-radius: 11px; background: #fbfcfa; }
.stats-review-item strong { color: #2f3c4f; font-size: 19px; font-weight: 650; letter-spacing: -.02em; }
.stats-review-item span { color: #97a1ad; font-size: 12px; }
.stats-panel-empty, .stats-panel-note { margin: 0; color: #9aa4b0; font-size: 12.5px; line-height: 1.65; }
@media (max-width: 980px) {
  .stats-overview { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .stats-columns { grid-template-columns: minmax(0, 1fr); }
}
@media (max-width: 640px) {
  .stats-overview { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .stats-bar-chart { gap: 4px; }
  .stats-bar-label { font-size: 9px; }
}
@media (max-width: 520px) {
  .stats-overview { grid-template-columns: minmax(0, 1fr); }
  .stats-metric strong { font-size: 23px; }
}
</style>
