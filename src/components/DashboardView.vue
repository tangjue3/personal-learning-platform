<script setup>
import BookCover from './BookCover.vue'
import Icon from './Icon.vue'

defineEmits(['open-reader', 'open-calendar', 'open-shelf'])

const featuredBook = {
  id: 'rag-engineering',
  title: 'RAG 工程学习手册',
  coverTitle: 'RAG\n工程学习手册',
  subtitle: '从原理到实践',
  theme: 'blue',
  chapters: 18,
  progress: 44,
  currentChapter: '第 8 章 · 检索策略与重排',
}

const week = [
  { label: '一', done: true },
  { label: '二', done: true },
  { label: '三', done: true },
  { label: '四', done: true },
  { label: '五', done: true },
  { label: '六', done: false },
  { label: '日', done: false, current: true },
]

const events = [
  { time: '09:00', end: '10:30', title: 'RAG 工程学习手册', detail: '第 8 章 · 检索策略与重排', tone: 'blue', state: '进行中' },
  { time: '14:00', end: '15:00', title: '机器学习基础', detail: '第 3 章 · 模型评估与调优', tone: 'violet', state: '待开始' },
  { time: '16:00', end: '17:00', title: '阅读与笔记整理', detail: '整理本周学习摘录', tone: 'mint', state: '待开始' },
]

const tasks = [
  { title: '完成 RAG 笔记整理', done: false },
  { title: '阅读一篇行业论文', done: false },
  { title: '回复导师的邮件', done: true },
  { title: '晚上复习本周内容', done: false },
]

const books = [
  { id: 'rag-engineering', title: 'RAG 工程学习手册', coverTitle: 'RAG\n工程学习手册', subtitle: '从原理到实践', theme: 'blue', chapters: 18, progress: 44 },
  { id: 'ml-basics', title: '机器学习基础', coverTitle: '机器学习\n基础', subtitle: '核心算法与实践', theme: 'mist', chapters: 12, progress: 35 },
  { id: 'deep-learning', title: '深度学习入门', coverTitle: '深度学习\n入门', subtitle: '从基础到应用', theme: 'night', chapters: 16, progress: 28 },
]

const todayLabel = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }).format(new Date())
</script>

<template>
  <main class="page-content dashboard-page">
    <header class="page-heading dashboard-heading">
      <div>
        <div class="eyebrow-label"><Icon name="sun" size="15" /> 星期日，早上好</div>
        <h1>今天</h1>
        <p>专注当下，积累每一次小小的进步。</p>
      </div>
      <div class="heading-side">
        <span class="date-label">{{ todayLabel }}</span>
        <button class="avatar-button" aria-label="个人资料">林</button>
      </div>
    </header>

    <section class="dashboard-top-grid">
      <article class="continue-card surface-card">
        <div class="continue-cover-wrap"><BookCover :book="featuredBook" compact /></div>
        <div class="continue-copy">
          <span class="section-kicker"><span class="live-dot"></span> 继续阅读</span>
          <div class="continue-title-row">
            <div>
              <h2>{{ featuredBook.title }}</h2>
              <p class="subtle-copy">{{ featuredBook.subtitle }} · {{ featuredBook.currentChapter }}</p>
            </div>
            <button class="icon-button bookmark-action" aria-label="收藏"><Icon name="bookmark" size="18" /></button>
          </div>
          <div class="progress-label-row"><span>阅读进度</span><strong>{{ featuredBook.progress }}%</strong></div>
          <div class="progress-track"><span :style="{ width: `${featuredBook.progress}%` }"></span></div>
          <div class="continue-actions">
            <button class="button button-primary" @click="$emit('open-reader', featuredBook)">接着读 <Icon name="arrowRight" size="16" /></button>
            <button class="button button-secondary" @click="$emit('open-shelf')"><Icon name="list" size="16" /> 查看目录</button>
          </div>
        </div>
      </article>

      <article class="week-card surface-card">
        <div class="card-heading-inline"><div><span class="section-kicker">学习节奏</span><h2>本周学习</h2></div><span class="streak-pill"><Icon name="sparkles" size="14" /> 连续 5 天</span></div>
        <div class="week-days">
          <div v-for="day in week" :key="day.label" class="week-day" :class="{ 'is-complete': day.done, 'is-current': day.current }">
            <span class="week-check"><Icon v-if="day.done" name="check" size="15" /></span>
            <span>{{ day.label }}</span>
          </div>
        </div>
        <div class="week-note"><span class="note-quote">“</span><p>学习不是一蹴而就，<br />而是让优秀成为一种习惯。</p></div>
        <div class="week-footer"><span>已完成 5 / 7 天</span><span class="tiny-link">查看学习统计 <Icon name="chevronRight" size="14" /></span></div>
      </article>
    </section>

    <section class="dashboard-middle-grid">
      <article class="agenda-card surface-card">
        <div class="section-heading-row"><div><span class="section-kicker">安排与日程</span><h2>今天的安排</h2></div><button class="text-button" @click="$emit('open-calendar')">查看日历 <Icon name="chevronRight" size="16" /></button></div>
        <div class="agenda-list">
          <div v-for="event in events" :key="event.time" class="agenda-row">
            <div class="agenda-time"><strong>{{ event.time }}</strong><span>{{ event.end }}</span></div>
            <span class="agenda-marker" :class="`tone-${event.tone}`"></span>
            <div class="agenda-copy"><strong>{{ event.title }}</strong><span>{{ event.detail }}</span></div>
            <span class="status-pill" :class="{ 'status-active': event.state === '进行中' }">{{ event.state }}</span>
          </div>
        </div>
      </article>

      <article class="task-card surface-card">
        <div class="section-heading-row"><div><span class="section-kicker">轻轻推进</span><h2>重要事项</h2></div><button class="icon-button" aria-label="添加事项"><Icon name="plus" size="19" /></button></div>
        <ul class="task-list">
          <li v-for="task in tasks" :key="task.title" :class="{ 'task-done': task.done }"><span class="task-checkbox"><Icon v-if="task.done" name="check" size="13" /></span><span>{{ task.title }}</span></li>
        </ul>
        <button class="add-task-button"><Icon name="plus" size="15" /> 添加一个事项</button>
      </article>
    </section>

    <section class="book-preview-section">
      <div class="section-heading-row book-preview-heading"><div><span class="section-kicker">正在学习</span><h2>我的课程与书籍</h2></div><button class="text-button" @click="$emit('open-shelf')">前往书架 <Icon name="chevronRight" size="16" /></button></div>
      <div class="mini-book-row">
        <button v-for="book in books" :key="book.id" class="mini-book" @click="$emit('open-reader', book)">
          <div class="mini-cover"><BookCover :book="book" compact /></div>
          <div class="mini-book-info"><strong>{{ book.title }}</strong><span>{{ book.subtitle }}</span><div class="mini-progress"><span class="progress-track"><i :style="{ width: `${book.progress}%` }"></i></span><small>{{ book.progress }}%</small></div></div>
        </button>
        <button class="discover-book" @click="$emit('open-shelf')"><span class="discover-plus"><Icon name="plus" size="20" /></span><span>发现更多书籍</span></button>
      </div>
    </section>
  </main>
</template>
