<script setup>
import Icon from './Icon.vue'

defineProps({ kind: { type: String, required: true } })

const notes = [
  { title: 'RAG 的检索与重排', source: 'RAG 工程学习手册 · 第 8 章', updated: '今天 09:42', color: 'blue' },
  { title: '向量数据库选型要点', source: 'RAG 工程学习手册 · 第 5 章', updated: '昨天 18:20', color: 'mint' },
  { title: '模型评估指标对照', source: '机器学习基础 · 第 3 章', updated: '周三 14:05', color: 'peach' },
]
</script>

<template>
  <main class="page-content workspace-page">
    <header class="page-heading"><div><span class="eyebrow-label"><span class="eyebrow-line"></span> 学习中的每个发现</span><h1>{{ kind === 'notes' ? '我的笔记' : '复习计划' }}</h1><p>{{ kind === 'notes' ? '让值得记住的内容，都能在需要时再次出现。' : '用合适的节奏，把学过的内容留在脑海里。' }}</p></div><button class="button button-primary"><Icon name="plus" size="17" />{{ kind === 'notes' ? '新建笔记' : '开始复习' }}</button></header>
    <section v-if="kind === 'notes'" class="notes-layout">
      <article class="notes-overview surface-card"><span class="overview-icon"><Icon name="notes" size="20" /></span><span class="section-kicker">最近整理</span><strong>24</strong><span>条学习笔记</span><div class="overview-foot"><span>本周新增</span><strong>+6</strong></div></article>
      <div class="notes-list surface-card"><div class="section-heading-row"><div><span class="section-kicker">最近更新</span><h2>继续整理思路</h2></div><button class="icon-button"><Icon name="filter" size="18" /></button></div><button v-for="note in notes" :key="note.title" class="note-row"><span class="note-color-dot" :class="`tone-${note.color}`"></span><span class="note-row-copy"><strong>{{ note.title }}</strong><span>{{ note.source }}</span></span><span class="note-updated">{{ note.updated }}</span><Icon name="chevronRight" size="16" /></button></div>
    </section>
    <section v-else class="review-overview-grid"><article class="review-focus-card surface-card"><span class="section-kicker">今天的复习</span><h2>保持轻盈，循序渐进。</h2><p>今天有 8 个知识点等你回顾，预计 12 分钟完成。</p><div class="review-progress"><span class="progress-track"><i style="width: 28%"></i></span><strong>2 / 8</strong></div><button class="button button-primary"><Icon name="play" size="16" /> 继续复习</button></article><article class="review-count-card surface-card"><span class="section-kicker">待复习内容</span><div class="review-count-number">08<span> 个知识点</span></div><div class="review-count-tags"><span><i class="tone-blue"></i> RAG 检索 <b>4</b></span><span><i class="tone-mint"></i> 机器学习 <b>3</b></span><span><i class="tone-peach"></i> 产品设计 <b>1</b></span></div></article></section>
  </main>
</template>
