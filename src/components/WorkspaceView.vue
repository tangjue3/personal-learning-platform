<script setup>
import { computed, nextTick, ref } from 'vue'
import Icon from './Icon.vue'
import { deleteLocalRecord, getLocalRecords, saveLocalRecord } from '../services/localDataStore.js'

const props = defineProps({ kind: { type: String, required: true }, books: { type: Array, default: () => [] } })
const emit = defineEmits(['open-note'])
const editorOpen = ref(false)
const editorError = ref('')
const noteActionError = ref('')
const noteActionNotice = ref('')
const editorBusy = ref(false)
const searchText = ref('')
const selectedTag = ref('')
const reviewError = ref('')
const reviewBusy = ref(false)
const noteDraft = ref(emptyNote())
let noteDraftBaseline = ''
const cardDraft = ref(emptyCard())
let cardDraftBaseline = JSON.stringify(cardDraft.value)
const reviewStage = ref('question')
const sessionIds = ref([])
const sessionPosition = ref(0)
const reviewClock = ref(Date.now())
const cardFrontField = ref(null)

function emptyNote() { return { id: '', title: '', content: '', excerpt: '', tags: '', bookId: '', chapterId: '', chapterTitle: '', anchor: null, format: '', color: 'yellow', createdAt: '' } }
function normalizeTags(value) {
  return [...new Set(String(value || '').split(/[,，\n]/).map((tag) => tag.trim().replace(/^#+/, '').slice(0, 24)).filter(Boolean))].slice(0, 8)
}
function emptyCard() { return { id: '', front: '', back: '', bookId: '', chapterId: '', dueAt: new Date().toISOString(), intervalDays: 0, repetitions: 0, easeFactor: 2.5 } }
function makeId() { return window.crypto?.randomUUID?.() || String(Date.now()) + '-' + Math.random().toString(36).slice(2) }

const notes = computed(() => getLocalRecords('note'))
const cards = computed(() => getLocalRecords('review'))
const noteTagOptions = computed(() => {
  const counts = new Map()
  for (const note of notes.value) {
    for (const tag of Array.isArray(note.tags) ? note.tags : []) counts.set(tag, (counts.get(tag) || 0) + 1)
  }
  return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b, 'zh-CN')).map(([tag, count]) => ({ tag, count }))
})
const visibleNotes = computed(() => {
  const query = searchText.value.trim().toLocaleLowerCase()
  return notes.value.filter((note) => {
    const tags = Array.isArray(note.tags) ? note.tags : []
    const searchable = [note.title, note.content, note.excerpt, tags.join(' ')].join(' ').toLocaleLowerCase()
    return (!query || searchable.includes(query)) && (!selectedTag.value || tags.includes(selectedTag.value))
  })
})
const dueCards = computed(() => {
  reviewClock.value
  return cards.value.filter((card) => !card.dueAt || new Date(card.dueAt).getTime() <= Date.now())
})
const activeCard = computed(() => cards.value.find((card) => card.id === sessionIds.value[sessionPosition.value]) || null)
const sessionDone = computed(() => sessionIds.value.length > 0 && sessionPosition.value >= sessionIds.value.length)
const noteChapters = computed(() => props.books.find((book) => book.id === noteDraft.value.bookId)?.documents || [])
const cardChapters = computed(() => props.books.find((book) => book.id === cardDraft.value.bookId)?.documents || [])
const cardDraftDirty = computed(() => JSON.stringify(cardDraft.value) !== cardDraftBaseline)
const isEditingCard = computed(() => Boolean(cardDraft.value.id))

function openNewNote() {
  noteDraft.value = emptyNote()
  noteDraftBaseline = JSON.stringify(noteDraft.value)
  editorError.value = ''
  editorOpen.value = true
}
function editNote(note) {
  noteDraft.value = { ...emptyNote(), ...note, tags: Array.isArray(note.tags) ? note.tags.join(', ') : '' }
  noteDraftBaseline = JSON.stringify(noteDraft.value)
  editorError.value = ''
  editorOpen.value = true
}
function closeEditor() {
  if (editorBusy.value) return
  if (JSON.stringify(noteDraft.value) !== noteDraftBaseline && !window.confirm('这条笔记有未保存的修改，确定丢弃吗？')) return
  editorOpen.value = false
}
function canOpenNote(note) { return Boolean(note.bookId && (note.anchor || note.chapterId) && props.books.some((book) => book.id === note.bookId)) }
function openNoteSource(note) { emit('open-note', note) }
async function saveNote() {
  if (!noteDraft.value.title.trim() || (!noteDraft.value.content.trim() && !noteDraft.value.excerpt.trim())) { editorError.value = '请填写标题，并写下笔记内容或保留摘录。'; return }
  editorBusy.value = true
  editorError.value = ''
  const id = noteDraft.value.id || makeId()
  try {
    await saveLocalRecord('note', id, {
      title: noteDraft.value.title.trim().slice(0, 120),
      content: noteDraft.value.content.trim(),
      tags: normalizeTags(noteDraft.value.tags),
      excerpt: noteDraft.value.excerpt.trim(),
      bookId: noteDraft.value.bookId,
      chapterId: noteDraft.value.chapterId,
      chapterTitle: noteDraft.value.chapterTitle,
      anchor: noteDraft.value.anchor,
      format: noteDraft.value.format,
      color: noteDraft.value.color,
      createdAt: noteDraft.value.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    editorOpen.value = false
  } catch (error) { editorError.value = error.message }
  finally { editorBusy.value = false }
}
async function removeNote() {
  if (!noteDraft.value.id || editorBusy.value || !window.confirm('确定删除这条笔记吗？删除后可以从本机快照恢复。')) return
  editorBusy.value = true
  try { await deleteLocalRecord('note', noteDraft.value.id); editorOpen.value = false }
  catch (error) { editorError.value = error.message }
  finally { editorBusy.value = false }
}
async function createCardFromNote(note) {
  noteActionError.value = ''
  noteActionNotice.value = ''
  try {
    await saveLocalRecord('review', makeId(), {
      ...emptyCard(), front: note.title, back: [note.excerpt ? '摘录：\n' + note.excerpt : '', note.content || ''].filter(Boolean).join('\n\n'), bookId: note.bookId || '',
      chapterId: note.chapterId || '', dueAt: new Date().toISOString(), createdAt: new Date().toISOString(),
    })
    noteActionNotice.value = '已从笔记创建一张待复习卡片。'
  } catch (error) { noteActionError.value = error.message }
}
function exportVisibleNotes() {
  if (!visibleNotes.value.length) return
  const markdown = visibleNotes.value.map((note) => {
    const tags = Array.isArray(note.tags) ? note.tags : []
    const source = note.bookId ? `> 来源：${bookName(note.bookId)}${note.chapterTitle || chapterName(note.bookId, note.chapterId) ? ` · ${note.chapterTitle || chapterName(note.bookId, note.chapterId)}` : ''}` : ''
    const tagLine = tags.length ? `> 标签：${tags.map((tag) => `#${tag}`).join(' ')}` : ''
    const excerpt = note.excerpt ? `> ${note.excerpt.replace(/\r?\n/g, '\n> ')}` : ''
    return [`## ${note.title}`, source, tagLine, excerpt, note.content || ''].filter(Boolean).join('\n\n')
  }).join('\n\n---\n\n')
  const blob = new Blob([`# 知序学习笔记\n\n${markdown}\n`], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  const now = new Date()
  const fileDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  link.href = url
  link.download = `知序笔记-${fileDate}.md`
  document.body.append(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  noteActionError.value = ''
  noteActionNotice.value = `已导出当前列表中的 ${visibleNotes.value.length} 条笔记。`
}
function startReview() { reviewClock.value = Date.now(); reviewError.value = ''; sessionIds.value = dueCards.value.map((card) => card.id); sessionPosition.value = 0; reviewStage.value = 'question' }
function scheduleAfterRating(card, rating) {
  const now = new Date()
  const next = { ...card, repetitions: Number(card.repetitions) || 0, intervalDays: Number(card.intervalDays) || 0, easeFactor: Number(card.easeFactor) || 2.5 }
  if (rating === 'again') {
    next.repetitions = 0; next.intervalDays = 0
    next.dueAt = new Date(now.getTime() + 10 * 60 * 1000).toISOString()
  } else {
    next.repetitions += 1
    if (rating === 'hard') next.intervalDays = Math.max(1, Math.round((next.intervalDays || 1) * 1.2))
    else if (rating === 'easy') next.intervalDays = Math.max(4, Math.round((next.intervalDays || 1) * next.easeFactor * 1.3))
    else next.intervalDays = next.intervalDays ? Math.max(1, Math.round(next.intervalDays * next.easeFactor)) : 1
    if (rating === 'easy') next.easeFactor = Math.min(3.2, next.easeFactor + 0.15)
    if (rating === 'hard') next.easeFactor = Math.max(1.3, next.easeFactor - 0.15)
    next.dueAt = new Date(now.getTime() + next.intervalDays * 24 * 60 * 60 * 1000).toISOString()
  }
  next.lastReviewedAt = now.toISOString()
  return next
}
async function rateCard(rating) {
  if (!activeCard.value) return
  reviewBusy.value = true; reviewError.value = ''
  const { id, updatedAt, ...data } = scheduleAfterRating(activeCard.value, rating)
  try { await saveLocalRecord('review', id, data); sessionPosition.value += 1; reviewStage.value = 'question' }
  catch (error) { reviewError.value = error.message }
  finally { reviewBusy.value = false }
}
function replaceCardDraft(next = emptyCard()) {
  cardDraft.value = next
  cardDraftBaseline = JSON.stringify(next)
}
function startNewCard() {
  if (reviewBusy.value) return
  if (cardDraftDirty.value && !window.confirm('当前卡片有未保存的修改，确定放弃并新建吗？')) return
  replaceCardDraft()
  reviewError.value = ''
  nextTick(() => cardFrontField.value?.focus())
}
function editCard(card) {
  if (reviewBusy.value) return
  if (cardDraftDirty.value && !window.confirm('当前卡片有未保存的修改，确定切换到这张卡片吗？')) return
  replaceCardDraft({ ...emptyCard(), ...card })
  reviewError.value = ''
  nextTick(() => cardFrontField.value?.focus())
}
function cancelCardEdit() {
  if (reviewBusy.value) return
  if (cardDraftDirty.value && !window.confirm('确定放弃这张卡片的未保存修改吗？')) return
  replaceCardDraft()
  reviewError.value = ''
}
async function saveCard() {
  if (reviewBusy.value) return
  if (!cardDraft.value.front.trim() || !cardDraft.value.back.trim()) { reviewError.value = '请填写问题和答案。'; return }
  reviewBusy.value = true; reviewError.value = ''
  const id = cardDraft.value.id || makeId()
  const { id: ignoredId, updatedAt: ignoredUpdatedAt, ...data } = cardDraft.value
  const latestCard = cards.value.find((card) => card.id === id)
  const latestSchedule = latestCard ? {
    dueAt: latestCard.dueAt,
    intervalDays: latestCard.intervalDays,
    repetitions: latestCard.repetitions,
    easeFactor: latestCard.easeFactor,
    lastReviewedAt: latestCard.lastReviewedAt,
  } : {}
  try {
    await saveLocalRecord('review', id, {
      ...data,
      ...latestSchedule,
      front: data.front.trim(),
      back: data.back.trim(),
      createdAt: data.createdAt || new Date().toISOString(),
    })
    replaceCardDraft()
  } catch (error) { reviewError.value = error.message }
  finally { reviewBusy.value = false }
}
async function removeCard(card) {
  if (reviewBusy.value) return
  const editingThisCard = isEditingCard.value && cardDraft.value.id === card.id
  const warning = editingThisCard && cardDraftDirty.value
    ? '这张卡片有未保存的修改。确定连同修改一起删除吗？'
    : '确定删除这张复习卡片吗？'
  if (!window.confirm(warning)) return
  reviewBusy.value = true
  reviewError.value = ''
  try {
    await deleteLocalRecord('review', card.id)
    if (editingThisCard) replaceCardDraft()
  } catch (error) { reviewError.value = error.message }
  finally { reviewBusy.value = false }
}
function bookName(bookId) { return props.books.find((book) => book.id === bookId)?.title || '' }
function chapterName(bookId, chapterId) {
  return props.books.find((book) => book.id === bookId)?.documents?.find((chapter) => chapter.id === chapterId)?.title || ''
}
function formatDate(value) {
  if (!value) return '现在'
  return new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric' }).format(new Date(value))
}

defineExpose({ startReview, focusNewCard: startNewCard })
</script>

<template>
  <main class="page-content workspace-page">
    <header class="page-heading">
      <div><span class="eyebrow-label"><span class="eyebrow-line"></span>{{ kind === 'notes' ? '学习中的每个发现' : '用回忆巩固理解' }}</span><h1>{{ kind === 'notes' ? '我的笔记' : '复习计划' }}</h1><p>{{ kind === 'notes' ? '把课程中的想法和重点，整理成自己的知识。' : '按间隔复习知识卡片，记住真正重要的内容。' }}</p></div>
      <button v-if="kind === 'notes'" class="button button-primary" @click="openNewNote"><Icon name="plus" size="17" /> 新建笔记</button>
      <button v-else class="button button-primary" :disabled="reviewBusy" @click="startNewCard"><Icon name="plus" size="17" /> 新建卡片</button>
    </header>
    <template v-if="kind === 'notes'">
            <section class="notes-toolbar surface-card">
        <div><span class="section-kicker">私人知识库</span><strong>{{ notes.length }} 条笔记</strong></div>
        <div class="notes-toolbar-actions">
          <label class="search-field"><Icon name="search" size="16" /><input v-model="searchText" type="search" placeholder="搜索标题、内容或标签" /></label>
          <button type="button" class="button button-secondary notes-export-button" :disabled="!visibleNotes.length" title="将当前筛选结果下载为本机 Markdown 文件" @click="exportVisibleNotes"><Icon name="download" size="15" /> 导出 Markdown</button>
        </div>
      </section>
      <div v-if="noteTagOptions.length" class="notes-tag-bar" role="group" aria-label="按标签筛选笔记">
        <button type="button" class="note-tag-filter" :class="{ 'is-active': !selectedTag }" :aria-pressed="!selectedTag" @click="selectedTag = ''">全部 <span>{{ notes.length }}</span></button>
        <button v-for="item in noteTagOptions" :key="item.tag" type="button" class="note-tag-filter" :class="{ 'is-active': selectedTag === item.tag }" :aria-pressed="selectedTag === item.tag" @click="selectedTag = selectedTag === item.tag ? '' : item.tag">{{ item.tag }} <span>{{ item.count }}</span></button>
      </div>
      <p v-if="noteActionError" class="workspace-error" role="alert">{{ noteActionError }}</p><p v-if="noteActionNotice" class="workspace-notice" role="status">{{ noteActionNotice }}</p>
      <section v-if="visibleNotes.length" class="real-notes-grid">
        <article v-for="note in visibleNotes" :key="note.id" class="real-note-card surface-card">
          <button class="real-note-open" @click="editNote(note)"><span v-if="note.bookId" class="real-note-source">{{ bookName(note.bookId) }}<template v-if="note.chapterTitle || chapterName(note.bookId, note.chapterId)"> · {{ note.chapterTitle || chapterName(note.bookId, note.chapterId) }}</template></span><div v-if="note.tags?.length" class="real-note-tags"><span v-for="tag in note.tags" :key="tag">{{ tag }}</span></div><h2>{{ note.title }}</h2><blockquote v-if="note.excerpt" class="real-note-excerpt">{{ note.excerpt }}</blockquote><p v-if="note.content">{{ note.content }}</p><span class="real-note-date">更新于 {{ formatDate(note.updatedAt) }}</span></button>
          <footer><div class="real-note-actions"><button class="text-button" @click="createCardFromNote(note)"><Icon name="review" size="14" /> 制作复习卡</button><button v-if="canOpenNote(note)" class="text-button" @click="openNoteSource(note)"><Icon name="arrowRight" size="14" /> 阅读原文</button></div><button class="icon-button" aria-label="编辑笔记" @click="editNote(note)"><Icon name="edit" size="15" /></button></footer>
        </article>
      </section>
      <div v-else class="workspace-empty surface-card"><span class="overview-icon"><Icon name="notes" size="20" /></span><h2>{{ searchText || selectedTag ? '没有找到符合条件的笔记' : '从第一条笔记开始' }}</h2><p>{{ searchText || selectedTag ? '清除搜索或标签筛选试试。' : '阅读时记录重点、问题和自己的理解。笔记只保存在本机，不会同步到 GitHub。' }}</p><button v-if="!searchText && !selectedTag" class="button button-primary" @click="openNewNote"><Icon name="plus" size="15" /> 新建第一条笔记</button><button v-else class="text-button" @click="searchText = ''; selectedTag = ''">清除筛选</button></div>
    </template>

    <template v-else>
      <section class="real-review-grid">
        <article class="review-focus-card surface-card">
          <span class="section-kicker">今日待复习</span>
          <template v-if="activeCard">
            <span class="review-session-count">{{ sessionPosition + 1 }} / {{ sessionIds.length }}</span>
            <h2>{{ activeCard.front }}</h2>
            <p v-if="activeCard.bookId" class="review-source">{{ bookName(activeCard.bookId) }}<template v-if="chapterName(activeCard.bookId, activeCard.chapterId)"> · {{ chapterName(activeCard.bookId, activeCard.chapterId) }}</template></p>
            <div v-if="reviewStage === 'answer'" class="review-answer">{{ activeCard.back }}</div>
            <button v-if="reviewStage === 'question'" class="button button-primary" @click="reviewStage = 'answer'">显示答案</button>
            <div v-else class="review-ratings"><button :disabled="reviewBusy" @click="rateCard('again')">重来 <small>10 分钟</small></button><button :disabled="reviewBusy" @click="rateCard('hard')">困难 <small>约 1 天</small></button><button :disabled="reviewBusy" @click="rateCard('good')">记得 <small>间隔复习</small></button><button :disabled="reviewBusy" @click="rateCard('easy')">简单 <small>延长间隔</small></button></div>
          </template>
          <template v-else-if="sessionDone"><h2>这一轮复习完成</h2><p>记录已保存。再次进入复习时会按计划出现。</p><button class="button button-secondary" @click="startReview">检查新到期卡片</button></template>
          <template v-else><h2>{{ dueCards.length ? '准备好开始了吗？' : '今天没有到期卡片' }}</h2><p>{{ dueCards.length ? '有 ' + dueCards.length + ' 张卡片等你回忆。' : cards.length ? '共有 ' + cards.length + ' 张卡片，下一次复习时间：' + formatDate(cards.reduce((earliest, card) => !earliest || card.dueAt < earliest ? card.dueAt : earliest, '')) + '。' : '从课程笔记创建卡片，或手动制作一张。' }}</p><button v-if="dueCards.length" class="button button-primary" @click="startReview"><Icon name="play" size="15" /> 开始复习</button></template>
        </article>
        <article class="review-count-card surface-card"><span class="section-kicker">知识卡片</span><div class="review-count-number">{{ dueCards.length }}<span> 张待复习</span></div><div class="review-summary"><span>总卡片数</span><strong>{{ cards.length }}</strong></div><div class="review-summary"><span>已安排后续复习</span><strong>{{ cards.filter((card) => card.dueAt && new Date(card.dueAt).getTime() > Date.now()).length }} 张</strong></div></article>
      </section>
      <p v-if="reviewError" class="workspace-error" role="alert">{{ reviewError }}</p>
      <section class="card-editor surface-card">
        <div class="section-heading-row"><div><span class="section-kicker">{{ isEditingCard ? '编辑知识卡片' : '新建知识卡片' }}</span><h2>{{ isEditingCard ? '修改问题与答案' : '问题与答案' }}</h2></div><span v-if="isEditingCard" class="card-edit-hint">修改题面不会重置复习安排</span></div>
        <div class="card-editor-fields"><label><span>正面 · 回忆问题</span><textarea ref="cardFrontField" v-model="cardDraft.front" rows="2" :disabled="reviewBusy" placeholder="例如：RAG 中重排解决什么问题？"></textarea></label><label><span>背面 · 参考答案</span><textarea v-model="cardDraft.back" rows="3" :disabled="reviewBusy" placeholder="写下关键概念或自己的解释"></textarea></label><label><span>关联书籍</span><select v-model="cardDraft.bookId" :disabled="reviewBusy"><option value="">不关联书籍</option><option v-for="book in books" :key="book.id" :value="book.id">{{ book.title }}</option></select></label><label v-if="cardChapters.length"><span>章节</span><select v-model="cardDraft.chapterId" :disabled="reviewBusy"><option value="">未指定章节</option><option v-for="chapter in cardChapters" :key="chapter.id" :value="chapter.id">{{ chapter.title }}</option></select></label></div>
        <div class="card-editor-actions"><button v-if="isEditingCard" type="button" class="button button-secondary" :disabled="reviewBusy" @click="cancelCardEdit">取消修改</button><button class="button button-primary" :disabled="reviewBusy" @click="saveCard"><Icon :name="isEditingCard ? 'check' : 'plus'" size="15" /> {{ reviewBusy ? '正在保存…' : isEditingCard ? '保存修改' : '添加卡片' }}</button></div>
      </section>
      <section v-if="cards.length" class="review-card-list"><div class="section-heading-row"><div><span class="section-kicker">全部卡片</span><h2>复习队列</h2></div></div><article v-for="card in cards" :key="card.id" class="review-list-row surface-card"><div><strong>{{ card.front }}</strong><span>{{ bookName(card.bookId) || '未关联书籍' }}<template v-if="chapterName(card.bookId, card.chapterId)"> · {{ chapterName(card.bookId, card.chapterId) }}</template></span></div><span class="review-due-pill" :class="{ 'is-due': !card.dueAt || new Date(card.dueAt).getTime() <= Date.now() }">{{ !card.dueAt || new Date(card.dueAt).getTime() <= Date.now() ? '待复习' : formatDate(card.dueAt) }}</span><button class="icon-button" :aria-label="`编辑复习卡片：${card.front}`" :disabled="reviewBusy" @click="editCard(card)"><Icon name="edit" size="15" /></button><button class="icon-button" :aria-label="`删除复习卡片：${card.front}`" :disabled="reviewBusy" @click="removeCard(card)"><Icon name="trash" size="15" /></button></article></section>
    </template>

    <div v-if="editorOpen" class="workspace-modal-backdrop" @click.self="closeEditor">
      <form class="workspace-modal" @submit.prevent="saveNote"><header><div><span class="section-kicker">私人笔记</span><h2>{{ noteDraft.id ? '编辑笔记' : '新建笔记' }}</h2></div><button type="button" class="icon-button" aria-label="关闭" :disabled="editorBusy" @click="closeEditor"><Icon name="close" size="17" /></button></header><label class="workspace-field"><span>标题</span><input v-model="noteDraft.title" maxlength="120" required placeholder="给这条笔记起个名字" /></label><label class="workspace-field"><span>摘录原文 · 可选</span><textarea v-model="noteDraft.excerpt" rows="3" maxlength="3000" placeholder="保存的原文摘录"></textarea></label><label class="workspace-field"><span>标签 · 逗号分隔</span><input v-model="noteDraft.tags" maxlength="240" placeholder="例如：RAG，面试重点，待验证" /></label><label class="workspace-field"><span>我的笔记 · 支持 Markdown</span><textarea v-model="noteDraft.content" rows="7" placeholder="记录理解、疑问或下一步行动"></textarea></label><div class="workspace-form-row"><label class="workspace-field"><span>关联书籍</span><select v-model="noteDraft.bookId"><option value="">不关联书籍</option><option v-for="book in books" :key="book.id" :value="book.id">{{ book.title }}</option></select></label><label v-if="noteChapters.length" class="workspace-field"><span>章节</span><select v-model="noteDraft.chapterId"><option value="">未指定章节</option><option v-for="chapter in noteChapters" :key="chapter.id" :value="chapter.id">{{ chapter.title }}</option></select></label></div><p v-if="editorError" class="workspace-error" role="alert">{{ editorError }}</p><footer><button v-if="noteDraft.id" type="button" class="workspace-delete-button" :disabled="editorBusy" @click="removeNote">删除笔记</button><span v-else></span><div><button type="button" class="button button-secondary" :disabled="editorBusy" @click="closeEditor">取消</button><button type="submit" class="button button-primary" :disabled="editorBusy">{{ editorBusy ? '保存中…' : '保存笔记' }}</button></div></footer></form>
    </div>
  </main>
</template>

<style scoped>
.workspace-empty { min-height: 230px; display: grid; justify-items: center; align-content: center; padding: 28px; text-align: center; }
.workspace-empty h2 { margin: 12px 0 7px; color: #39475b; font-size: 16px; }
.workspace-empty p { max-width: 430px; margin: 0 0 16px; color: #8792a1; font-size: 11px; line-height: 1.75; }
.notes-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 14px; margin-bottom: 13px; padding: 13px 17px; }
.notes-toolbar > div { display: flex; align-items: center; gap: 11px; }
.notes-toolbar > div strong { color: #718096; font-size: 10px; font-weight: 550; }
.notes-toolbar .search-field { width: min(100%, 260px); }
.notes-toolbar .search-field input { border: 0; outline: 0; background: transparent; font: inherit; }
.real-notes-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.real-note-excerpt { display: -webkit-box; margin: 10px 0 7px; padding: 9px 11px; overflow: hidden; border-left: 2px solid #d5c481; border-radius: 0 7px 7px 0; color: #78735f; background: #fbf8ee; font-size: 10px; line-height: 1.65; text-align: left; -webkit-box-orient: vertical; -webkit-line-clamp: 3; }
.real-note-card { min-width: 0; padding: 16px 17px 10px; }
.real-note-open { width: 100%; display: block; padding: 0; border: 0; color: inherit; background: transparent; text-align: left; cursor: pointer; }
.real-note-source { display: block; overflow: hidden; color: #7390b8; font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }
.real-note-card h2 { margin: 9px 0 7px; color: #39475b; font-size: 13px; font-weight: 620; }
.real-note-card p { display: -webkit-box; min-height: 55px; margin: 0; overflow: hidden; color: #8792a1; font-size: 10px; line-height: 1.7; white-space: pre-wrap; overflow-wrap: anywhere; -webkit-box-orient: vertical; -webkit-line-clamp: 3; }
.real-note-date { display: block; margin-top: 11px; color: #a2aab5; font-size: 8px; }
.real-note-card footer { display: flex; align-items: center; justify-content: space-between; margin-top: 10px; padding-top: 7px; border-top: 1px solid #f0f2f5; }
.real-note-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 7px 12px; }
.real-note-card footer .text-button { display: inline-flex; align-items: center; gap: 5px; font-size: 9px; }
.real-review-grid { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(200px, .8fr); gap: 14px; }
.review-focus-card { position: relative; }
.review-session-count { float: right; color: #9aa4b1; font-size: 10px; }
.review-focus-card h2 { max-width: 650px; font-size: 19px; line-height: 1.55; }
.review-source { color: #8b98a9; font-size: 9px; }
.review-answer { margin: 18px 0; padding: 14px; border: 1px solid #e5ebf2; border-radius: 10px; color: #657386; background: #f8fafc; font-size: 11px; line-height: 1.8; white-space: pre-wrap; overflow-wrap: anywhere; }
.review-ratings { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 7px; margin-top: 18px; }
.review-ratings button { display: grid; justify-items: center; gap: 4px; min-height: 43px; border: 1px solid #e7ebf0; border-radius: 9px; color: #647286; background: #fff; font: inherit; font-size: 10px; cursor: pointer; }
.review-ratings button:hover { border-color: #c8d8ed; background: #f8fbff; }
.review-ratings button small { color: #9aa4b1; font-size: 8px; }
.review-ratings button:disabled { opacity: .5; cursor: wait; }
.review-count-card { display: grid; align-content: start; gap: 13px; }
.review-count-card .review-count-number { margin: 5px 0; }
.review-summary { display: flex; justify-content: space-between; padding-top: 10px; border-top: 1px solid #eff1f4; color: #909aaa; font-size: 9px; }
.review-summary strong { color: #65758a; font-weight: 600; }
.card-editor { margin-top: 14px; padding: 18px; }
.card-editor .section-heading-row { margin-bottom: 14px; }
.card-editor .section-heading-row h2, .review-card-list .section-heading-row h2 { margin: 5px 0 0; color: #39475b; font-size: 14px; }
.card-edit-hint { color: #8b98a8; font-size: 9px; }
.card-editor-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
.card-editor-actions .button:disabled { opacity: .55; cursor: wait; }
.card-editor-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 11px; margin-bottom: 13px; }
.card-editor-fields label, .workspace-field { display: grid; gap: 6px; color: #687589; font-size: 9px; font-weight: 600; }
.card-editor-fields textarea, .card-editor-fields select, .workspace-field input, .workspace-field textarea, .workspace-field select { width: 100%; box-sizing: border-box; padding: 9px 10px; border: 1px solid #e5e9ee; border-radius: 8px; outline: 0; color: #47566a; background: #fff; font: inherit; font-size: 10px; line-height: 1.6; resize: vertical; }
.card-editor-fields textarea:focus, .workspace-field input:focus, .workspace-field textarea:focus, .workspace-field select:focus { border-color: #a8c3eb; box-shadow: 0 0 0 3px rgba(87,137,211,.1); }
.review-card-list { margin-top: 20px; }
.review-card-list .section-heading-row { margin-bottom: 9px; }
.review-list-row { display: flex; align-items: center; gap: 12px; margin-top: 7px; padding: 10px 12px; }
.review-list-row > div { min-width: 0; display: grid; flex: 1; gap: 4px; }
.review-list-row > .icon-button:disabled { opacity: .45; cursor: wait; }
.review-list-row > div strong { overflow: hidden; color: #586679; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.review-list-row > div span { color: #9aa4b1; font-size: 8px; }
.review-due-pill { padding: 5px 7px; border-radius: 7px; color: #8995a5; background: #f2f4f7; font-size: 8px; white-space: nowrap; }
.review-due-pill.is-due { color: #9b7550; background: #faf3e8; }
.workspace-error { margin: 10px 0; color: #b65f58; font-size: 10px; }
.workspace-notice { margin: 10px 0; color: #5a8d6a; font-size: 10px; }
.workspace-modal-backdrop { position: fixed; z-index: 80; inset: 0; display: grid; place-items: center; padding: 18px; background: rgba(25,36,51,.3); backdrop-filter: blur(6px); }
.workspace-modal { width: min(100%, 550px); max-height: min(90vh, 760px); display: grid; gap: 12px; overflow: auto; padding: 22px; border: 1px solid rgba(255,255,255,.8); border-radius: 17px; background: #fff; box-shadow: 0 22px 70px rgba(26,44,70,.18); }
.workspace-modal header, .workspace-modal footer { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.workspace-modal header h2 { margin: 5px 0 2px; color: #354155; font-size: 17px; }
.workspace-modal footer { margin-top: 3px; padding-top: 12px; border-top: 1px solid #edf0f3; }
.workspace-modal footer > div { display: flex; gap: 7px; }
.workspace-form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.workspace-delete-button { border: 0; color: #b36862; background: transparent; font: inherit; font-size: 9px; cursor: pointer; }
.workspace-modal .button { min-height: 34px; font-size: 9px; }
@media (max-width: 640px) { .real-notes-grid, .real-review-grid, .card-editor-fields, .workspace-form-row { grid-template-columns: 1fr; } .notes-toolbar { align-items: stretch; flex-direction: column; } .notes-toolbar .search-field { width: 100%; box-sizing: border-box; } .review-ratings { grid-template-columns: repeat(2, minmax(0, 1fr)); } .workspace-modal-backdrop { align-items: end; padding: 0; } .workspace-modal { width: 100%; max-height: 88vh; box-sizing: border-box; border-radius: 17px 17px 0 0; } }
.notes-toolbar-actions { min-width: 0; display: flex; align-items: center; gap: 9px; }
.notes-toolbar-actions .search-field { min-height: 38px; }
.notes-export-button { min-height: 38px; padding: 0 11px; font-size: 10px; white-space: nowrap; }
.notes-tag-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; margin: -4px 0 15px; }
.note-tag-filter { min-height: 30px; display: inline-flex; align-items: center; gap: 7px; padding: 0 10px; border: 1px solid #e5e9e5; border-radius: 999px; color: #778496; background: rgba(255,255,255,.75); font: inherit; font-size: 10px; cursor: pointer; transition: border-color .18s ease, background .18s ease, color .18s ease; }
.note-tag-filter span { color: #a0a9b4; font-size: 9px; }
.note-tag-filter:hover, .note-tag-filter.is-active { border-color: #d6e2ef; color: #4e79b4; background: #f0f5fb; }
.note-tag-filter.is-active span { color: #6c8fb8; }
.real-note-tags { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 8px; }
.real-note-tags span { padding: 4px 7px; border-radius: 6px; color: #6d829d; background: #eef3f8; font-size: 9px; line-height: 1.2; }
@media (max-width: 640px) { .notes-toolbar-actions { width: 100%; align-items: stretch; } .notes-toolbar-actions .search-field { width: auto; min-width: 0; flex: 1; } .notes-export-button { flex: 0 0 auto; padding: 0 8px; font-size: 9px; } }
</style>
