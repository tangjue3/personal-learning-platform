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
        <header class="stats-panel-heading"><div><span class="section-kicker">书籍投入</span><h2>{{ bookRows.length }} 本在学习</h2></div></header>
        <div v-if="bookRows.length" class="stats-book-list">
          <button v-for="row in bookRows" :key="row.id" type="button" class="stats-book-row" @click="emit('open-book', props.books.find((book) => book.id === row.id))">
            <span class="stats-book-spine" :style="{ background: row.color }"></span>
            <span class="stats-book-copy"><strong>{{ row.title }}</strong><small>{{ bookMeta(row) }}</small><span class="progress-track"><i :style="{ width: `${row.progress}%` }"></i></span></span>
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
          <div class="stats-review-item"><strong>{{ dueCards.length }}</strong><span>等待复习</span></div>
          <div class="stats-review-item"><strong>{{ cards.length }}</strong><span>卡片总数</span></div>
        </div>
        <p class="stats-panel-note">记得率按「记得 + 简单」占今日评分的比例计算。</p>
      </section>
    </div>
  </main>
</template>

<style scoped>
.stats-heading { align-items: center; }
.stats-heading h1 { margin-top: 7px; }
.stats-overview { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.stats-metric { display: grid; gap: 6px; padding: 16px 17px; }
.stats-metric strong { color: #2f3c4f; font-size: 26px; font-weight: 650; letter-spacing: -.03em; }
.stats-metric small { color: #7d8b9e; font-size: 12px; font-weight: 500; }
.stats-metric-note { color: #97a1ad; font-size: 11px; }
.stats-panel { padding: 17px 18px; }
.stats-panel-heading { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
.stats-panel-heading h2 { margin: 5px 0 0; color: #39465a; font-size: 14px; font-weight: 620; }
.stats-heatmap-legend { display: flex; align-items: center; gap: 4px; color: #9aa4b0; font-size: 10px; }
.stats-heatmap-legend i { width: 11px; height: 11px; border-radius: 3px; }
.stats-heatmap { display: flex; gap: 6px; overflow-x: auto; padding-bottom: 4px; }
.stats-heatmap-days { display: grid; grid-template-rows: repeat(7, 15px); gap: 3px; padding-top: 1px; color: #9aa4b0; font-size: 9px; text-align: right; }
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
.stats-book-copy strong { overflow: hidden; color: #46536a; font-size: 12px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.stats-book-copy small { color: #929ca8; font-size: 10px; }
.stats-book-copy .progress-track { height: 4px; }
.stats-book-progress { flex: 0 0 auto; color: #8b95a1; font-size: 11px; font-variant-numeric: tabular-nums; }
.stats-review-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 9px; }
.stats-review-item { display: grid; gap: 4px; padding: 11px 12px; border: 1px solid #edf0ec; border-radius: 11px; background: #fbfcfa; }
.stats-review-item strong { color: #2f3c4f; font-size: 19px; font-weight: 650; letter-spacing: -.02em; }
.stats-review-item span { color: #97a1ad; font-size: 10px; }
.stats-panel-empty, .stats-panel-note { margin: 0; color: #9aa4b0; font-size: 11px; line-height: 1.65; }
@media (max-width: 980px) {
  .stats-overview { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .stats-columns { grid-template-columns: minmax(0, 1fr); }
}
@media (max-width: 520px) {
  .stats-overview { grid-template-columns: minmax(0, 1fr); }
  .stats-metric strong { font-size: 23px; }
}
</style>
