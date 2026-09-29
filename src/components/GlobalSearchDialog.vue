<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import Icon from './Icon.vue'
import { getLocalRecords } from '../services/localDataStore.js'

const props = defineProps({ open: { type: Boolean, default: false }, books: { type: Array, default: () => [] } })
const emit = defineEmits(['update:open', 'open-book', 'open-note', 'open-page'])
const query = ref('')
const searchTerm = ref('')
const activeIndex = ref(0)
const field = ref(null)
const dialog = ref(null)
const previousFocus = ref(null)
const restoreFocus = ref(true)
let searchTimer = null

watch(query, (value) => {
  if (searchTimer) window.clearTimeout(searchTimer)
  searchTimer = window.setTimeout(() => {
    searchTerm.value = value.trim().toLocaleLowerCase('zh-CN')
  }, 90)
})
watch(() => props.open, async (isOpen) => {
  if (isOpen) {
    restoreFocus.value = true
    previousFocus.value = document.activeElement
    query.value = ''
    searchTerm.value = ''
    activeIndex.value = 0
    await nextTick()
    field.value?.focus()
    return
  }
  query.value = ''
  searchTerm.value = ''
  if (restoreFocus.value) {
    await nextTick()
    if (previousFocus.value?.isConnected) previousFocus.value.focus()
  } else restoreFocus.value = true
})
onBeforeUnmount(() => { if (searchTimer) window.clearTimeout(searchTimer) })

function snippet(text, index, term) {
  const source = String(text || '')
  const from = Math.max(0, index - 42)
  const to = Math.min(source.length, Math.max(index, 0) + term.length + 70)
  return (from ? '…' : '') + source.slice(from, to).replace(/[#>*_~\[\]]/g, ' ').replace(/\s+/g, ' ').trim() + (to < source.length ? '…' : '')
}
const results = computed(() => {
  const term = searchTerm.value
  if (!term) return []
  const matches = []
  const add = (result) => matches.push(result)

  for (const book of props.books) {
    const metadata = [book.title, book.subtitle, book.category, book.author].filter(Boolean).join(' ')
    if (metadata.toLocaleLowerCase('zh-CN').includes(term)) {
      add({ key: 'book:' + book.id, type: 'book', title: book.title, source: book.category || '书籍', excerpt: book.subtitle || book.author || '打开这本书', rank: 0, book })
    }
    for (const [index, chapter] of (book.documents || []).entries()) {
      const title = String(chapter.title || '第 ' + (index + 1) + ' 章')
      const content = String(chapter.content || '')
      const titleIndex = title.toLocaleLowerCase('zh-CN').indexOf(term)
      const contentIndex = content.toLocaleLowerCase('zh-CN').indexOf(term)
      if (titleIndex < 0 && contentIndex < 0) continue
      const anchor = { format: 'markdown', chapterId: String(chapter.id ?? 'document-' + (index + 1)) }
      if (contentIndex >= 0) {
        const exact = content.slice(contentIndex, contentIndex + term.length)
        Object.assign(anchor, {
          start: contentIndex,
          end: contentIndex + exact.length,
          exact,
          prefix: content.slice(Math.max(0, contentIndex - 36), contentIndex),
          suffix: content.slice(contentIndex + exact.length, contentIndex + exact.length + 36),
        })
      }
      add({
        key: 'chapter:' + book.id + ':' + anchor.chapterId,
        type: 'chapter',
        title,
        source: book.title,
        excerpt: contentIndex >= 0 ? snippet(content, contentIndex, term) : '章节标题匹配',
        rank: titleIndex >= 0 ? 1 : 2,
        book,
        anchor,
      })
    }
  }

  for (const note of getLocalRecords('note')) {
    const content = [note.title, note.excerpt, note.content, ...(Array.isArray(note.tags) ? note.tags : [])].filter(Boolean).join(' ')
    const index = content.toLocaleLowerCase('zh-CN').indexOf(term)
    if (index < 0) continue
    const book = props.books.find((item) => item.id === note.bookId)
    add({
      key: 'note:' + note.id,
      type: 'note',
      title: note.title || '未命名笔记',
      source: book?.title || '私人笔记',
      excerpt: snippet(content, index, term),
      rank: String(note.title || '').toLocaleLowerCase('zh-CN').includes(term) ? 1 : 2,
      note,
    })
  }

  for (const page of getLocalRecords('workspace')) {
    const content = [page.title, page.body].filter(Boolean).join(' ')
    const index = content.toLocaleLowerCase('zh-CN').indexOf(term)
    if (index < 0) continue
    add({
      key: 'page:' + page.id,
      type: 'page',
      title: page.title || '无标题页面',
      source: '工作台',
      excerpt: snippet(content, index, term),
      rank: String(page.title || '').toLocaleLowerCase('zh-CN').includes(term) ? 1 : 2,
      pageId: page.id,
    })
  }

  return matches.sort((a, b) => a.rank - b.rank).slice(0, 12)
})
watch(results, () => { activeIndex.value = 0 })

function close() { restoreFocus.value = true; emit('update:open', false) }
function moveSelection(amount) {
  if (!results.value.length) return
  activeIndex.value = (activeIndex.value + amount + results.value.length) % results.value.length
}
function choose(result) {
  restoreFocus.value = false
  emit('update:open', false)
  if (result.type === 'book' || result.type === 'chapter') emit('open-book', result.book, result.anchor || null)
  else if (result.type === 'note') emit('open-note', result.note)
  else emit('open-page', result.pageId)
}
function chooseActive() {
  const result = results.value[activeIndex.value]
  if (result) choose(result)
}
function trapTab(event) {
  if (event.key !== 'Tab' || !dialog.value) return
  const targets = [...dialog.value.querySelectorAll('input:not(:disabled), button:not(:disabled)')]
  if (!targets.length) return
  const first = targets[0]
  const last = targets[targets.length - 1]
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
}
function iconName(result) {
  return ({ book: 'shelf', chapter: 'notes', note: 'notes', page: 'grid' })[result.type] || 'search'
}
function kindLabel(result) {
  return ({ book: '书籍', chapter: '章节', note: '笔记', page: '页面' })[result.type] || ''
}
</script>

<template>
  <div v-if="open" class="global-search-backdrop" @click.self="close">
    <section ref="dialog" class="global-search-dialog" role="dialog" aria-modal="true" aria-label="全局搜索" @keydown.esc.stop.prevent="close" @keydown="trapTab">
      <header class="global-search-header">
        <Icon name="search" size="21" />
        <input ref="field" v-model="query" type="search" placeholder="搜索书名、章节、笔记和工作台页面…" aria-label="搜索书籍、章节、笔记和工作台页面" autocomplete="off" @keydown.down.prevent="moveSelection(1)" @keydown.up.prevent="moveSelection(-1)" @keydown.enter.prevent="chooseActive" />
        <button type="button" class="global-search-close" aria-label="关闭搜索" @click="close"><kbd>Esc</kbd><Icon name="close" size="16" /></button>
      </header>
      <div v-if="searchTerm && results.length" class="global-search-results" role="listbox" aria-label="搜索结果" :aria-activedescendant="'global-result-' + activeIndex">
        <button v-for="(result, index) in results" :id="'global-result-' + index" :key="result.key" type="button" role="option" class="global-search-result" :class="{ 'is-active': index === activeIndex }" :aria-selected="index === activeIndex" @mouseenter="activeIndex = index" @click="choose(result)">
          <span class="global-result-icon"><Icon :name="iconName(result)" size="17" /></span>
          <span class="global-result-copy"><span class="global-result-title">{{ result.title }}</span><span class="global-result-source">{{ kindLabel(result) }}<span> · </span>{{ result.source }}</span><span v-if="result.excerpt" class="global-result-excerpt">{{ result.excerpt }}</span></span>
          <Icon name="arrowRight" size="15" />
        </button>
      </div>
      <div v-else-if="searchTerm" class="global-search-empty"><span><Icon name="search" size="18" /></span><strong>没有找到匹配内容</strong><p>试试书名、章节标题或笔记里的关键词。</p></div>
      <div v-else class="global-search-hint"><span class="global-search-hint-icon"><Icon name="sparkles" size="18" /></span><div><strong>从一个关键词开始</strong><p>搜索课程章节、私人笔记和工作台页面。内容只在本机查找。</p></div><kbd>↑ ↓ 选择 · Enter 打开</kbd></div>
      <footer class="global-search-footer"><span>知序 · 全局搜索</span><span>{{ results.length ? '共显示 ' + results.length + ' 条' : 'Esc 关闭' }}</span></footer>
    </section>
  </div>
</template>

<style scoped>
.global-search-backdrop { position:fixed; z-index:120; inset:0; display:flex; justify-content:center; align-items:flex-start; padding: min(14vh,120px) 18px 20px; background:rgba(27,36,50,.28); backdrop-filter:blur(7px); }
.global-search-dialog { width:min(100%,680px); max-height:min(74vh,720px); display:flex; flex-direction:column; overflow:hidden; border:1px solid rgba(255,255,255,.85); border-radius:18px; background:rgba(255,255,255,.97); box-shadow:0 28px 90px rgba(19,31,48,.22); }
.global-search-header { min-height:62px; display:flex; align-items:center; gap:13px; padding:0 17px; border-bottom:1px solid #ecefea; color:#8794a3; }
.global-search-header input { width:100%; min-width:0; height:60px; border:0; outline:0; color:#334154; background:transparent; font:inherit; font-size:15px; }
.global-search-header input::placeholder { color:#a0a9b4; }
.global-search-close { flex:0 0 auto; display:flex; align-items:center; gap:8px; padding:7px; border:0; border-radius:8px; color:#8994a1; background:transparent; cursor:pointer; }
.global-search-close:hover { color:#536980; background:#f3f5f3; }
.global-search-close kbd,.global-search-footer kbd { padding:3px 5px; border:1px solid #e5e8e5; border-radius:5px; color:#929ca6; background:#fafbf9; font:11px -apple-system,BlinkMacSystemFont,sans-serif; }
.global-search-results { overflow:auto; padding:7px; }
.global-search-result { width:100%; min-width:0; display:grid; grid-template-columns:34px minmax(0,1fr) 16px; align-items:center; gap:11px; padding:10px; border:0; border-radius:10px; color:#98a1ac; background:transparent; text-align:left; cursor:pointer; }
.global-search-result:hover,.global-search-result.is-active { color:#5d82b0; background:#f1f5f7; }
.global-result-icon { width:32px; height:32px; display:grid; place-items:center; border:1px solid #e8ece8; border-radius:9px; color:#7790aa; background:white; }
.global-search-result.is-active .global-result-icon { border-color:#dce6ef; color:#5a7da4; background:#fff; }
.global-result-copy { min-width:0; display:grid; gap:3px; }
.global-result-title,.global-result-source,.global-result-excerpt { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.global-result-title { color:#3f4d60; font-size:13.5px; font-weight:600; }
.global-result-source { color:#8190a1; font-size:12px; }
.global-result-excerpt { color:#929ca7; font-size:12px; }
.global-search-empty { min-height:190px; display:grid; justify-items:center; align-content:center; padding:20px; color:#93a0ad; text-align:center; }
.global-search-empty>span { width:36px; height:36px; display:grid; place-items:center; border-radius:11px; background:#f2f5f4; }
.global-search-empty strong { margin-top:10px; color:#566477; font-size:13.5px; }
.global-search-empty p { margin:5px 0 0; font-size:12px; }
.global-search-hint { min-height:128px; display:flex; align-items:center; gap:12px; padding:20px; }
.global-search-hint-icon { width:36px; height:36px; flex:0 0 36px; display:grid; place-items:center; border-radius:11px; color:#6887aa; background:#eef3f6; }
.global-search-hint>div { min-width:0; flex:1; }
.global-search-hint strong { color:#4b596b; font-size:13.5px; }
.global-search-hint p { margin:5px 0 0; color:#8995a3; font-size:12px; line-height:1.6; }
.global-search-hint>kbd { color:#929ca6; font:11px -apple-system,BlinkMacSystemFont,sans-serif; white-space:nowrap; }
.global-search-footer { min-height:35px; display:flex; align-items:center; justify-content:space-between; padding:0 15px; border-top:1px solid #eef0ed; color:#9aa3ad; background:#fbfcfa; font-size:11px; }
@media(max-width:640px) {
  .global-search-backdrop { padding:8vh 11px 12px; }
  .global-search-dialog { max-height:82svh; border-radius:16px; }
  .global-search-header { min-height:55px; gap:9px; padding:0 12px; }
  .global-search-header input { height:54px; font-size:13px; }
  .global-search-close { gap:3px; padding:5px; }
  .global-search-close kbd { display:none; }
  .global-result-excerpt { font-size:11px; }
  .global-search-hint { align-items:flex-start; flex-wrap:wrap; padding:16px; }
  .global-search-hint>kbd { margin-left:48px; }
}
</style>