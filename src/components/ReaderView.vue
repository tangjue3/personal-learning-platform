<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import Icon from './Icon.vue'

const props = defineProps({ book: { type: Object, required: true } })
const emit = defineEmits(['back'])

const demoChapters = [
  '从 RAG 到知识应用', '大语言模型与知识增强', '数据准备与文档处理', '向量化与索引构建',
  '检索系统基础', '评估方法与指标', '检索质量分析', '检索策略与重排', '提示工程与生成控制',
  'RAG 应用开发实践', '系统优化与工程化', '真实场景与案例分析', '安全与合规', '进阶主题',
  '工具生态与资源', '常见问题与排查', '项目实战', '未来展望',
]

const storageKey = computed(() => `zhixu-reader:v1:${encodeURIComponent(String(props.book.id || props.book.title || 'untitled'))}`)
const chapters = computed(() => {
  const documents = Array.isArray(props.book.documents) ? props.book.documents : []
  if (!documents.length) return demoChapters.map((title, index) => ({ id: `demo-${index + 1}`, title, content: '', order: index }))

  return documents
    .map((document, index) => ({
      id: String(document?.id ?? `document-${index + 1}`),
      title: String(document?.title || `第 ${index + 1} 章`),
      content: String(document?.content ?? ''),
      order: Number.isFinite(Number(document?.order)) ? Number(document.order) : index,
      sourceIndex: index,
    }))
    .sort((a, b) => a.order - b.order || a.sourceIndex - b.sourceIndex)
})
const hasDocuments = computed(() => Array.isArray(props.book.documents) && props.book.documents.length > 0)

function readSavedState() {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey.value) || 'null')
    if (!saved || typeof saved !== 'object') return null
    return {
      chapterId: typeof saved.chapterId === 'string' ? saved.chapterId : null,
      chapterPositions: saved.chapterPositions && typeof saved.chapterPositions === 'object' ? saved.chapterPositions : {},
      bookmarks: Array.isArray(saved.bookmarks) ? saved.bookmarks.filter((item) => item && typeof item.chapterId === 'string') : [],
      theme: saved.theme === 'sepia' ? 'sepia' : 'light',
      fontSize: Math.min(22, Math.max(16, Number(saved.fontSize) || 18)),
    }
  } catch {
    return null
  }
}

const initialSavedState = readSavedState()
const readerState = ref(initialSavedState || {
  chapterId: null,
  chapterPositions: {},
  bookmarks: [],
  theme: 'light',
  fontSize: 18,
})
const startingChapterIndex = (() => {
  const savedIndex = chapters.value.findIndex((chapter) => chapter.id === initialSavedState?.chapterId)
  if (savedIndex >= 0) return savedIndex
  const progress = Math.min(100, Math.max(0, Number(props.book.progress) || 0))
  return Math.max(0, Math.min(chapters.value.length - 1, Math.round((progress / 100) * chapters.value.length) - 1))
})()
const activeChapter = ref(startingChapterIndex)
const readerTheme = ref(readerState.value.theme)
const fontSize = ref(readerState.value.fontSize)
const isTocCollapsed = ref(false)
const readerRoot = ref(null)
const chapterName = computed(() => chapters.value[activeChapter.value]?.title || chapters.value[0]?.title || '')
const activeDocument = computed(() => chapters.value[activeChapter.value])
const readingProgress = computed(() => chapters.value.length ? Math.round(((activeChapter.value + 1) / chapters.value.length) * 100) : 0)
const isCurrentChapterBookmarked = computed(() => isChapterBookmarked(activeDocument.value?.id))
const renderedDocument = computed(() => renderMarkdown(activeDocument.value?.content || '', chapterName.value))

function isChapterBookmarked(chapterId) {
  return Boolean(chapterId && readerState.value.bookmarks.some((bookmark) => bookmark.chapterId === chapterId))
}

function persistState() {
  const chapter = chapters.value[activeChapter.value]
  readerState.value.chapterId = chapter?.id || null
  readerState.value.theme = readerTheme.value
  readerState.value.fontSize = fontSize.value
  try {
    localStorage.setItem(storageKey.value, JSON.stringify(readerState.value))
  } catch {
    // The reader remains usable when browser storage is disabled or full.
  }
}

function currentScrollPosition() {
  const container = readerRoot.value?.closest('.app-shell--reader')
  return container ? Math.max(0, container.scrollTop) : 0
}

function setScrollPosition(position) {
  const container = readerRoot.value?.closest('.app-shell--reader')
  if (container) container.scrollTop = Math.max(0, Number(position) || 0)
}

function rememberCurrentPosition() {
  const chapter = chapters.value[activeChapter.value]
  if (!chapter) return
  readerState.value.chapterPositions[chapter.id] = currentScrollPosition()
  persistState()
}

let scrollContainer = null
let saveTimer = null
let restoringScroll = false

function handleScroll() {
  if (restoringScroll) return
  const chapter = chapters.value[activeChapter.value]
  if (!chapter) return
  readerState.value.chapterPositions[chapter.id] = currentScrollPosition()
  readerState.value.chapterId = chapter.id
  if (saveTimer) window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => {
    persistState()
    saveTimer = null
  }, 250)
}

function restorePosition(chapterId) {
  restoringScroll = true
  const position = readerState.value.chapterPositions[chapterId] || 0
  setScrollPosition(position)
  window.setTimeout(() => { restoringScroll = false }, 80)
}

function selectChapter(index) {
  if (index < 0 || index >= chapters.value.length || index === activeChapter.value) return
  rememberCurrentPosition()
  activeChapter.value = index
  const chapter = chapters.value[index]
  readerState.value.chapterId = chapter.id
  persistState()
  nextTick(() => restorePosition(chapter.id))
}

function moveChapter(direction) {
  selectChapter(activeChapter.value + direction)
}

function toggleBookmark() {
  const chapter = activeDocument.value
  if (!chapter) return
  const existingIndex = readerState.value.bookmarks.findIndex((bookmark) => bookmark.chapterId === chapter.id)
  if (existingIndex >= 0) readerState.value.bookmarks.splice(existingIndex, 1)
  else readerState.value.bookmarks.push({ chapterId: chapter.id, position: currentScrollPosition() })
  persistState()
}

function changeFontSize(amount) {
  fontSize.value = Math.min(22, Math.max(16, fontSize.value + amount))
  persistState()
}

function toggleTheme() {
  readerTheme.value = readerTheme.value === 'light' ? 'sepia' : 'light'
  persistState()
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character])
}

function renderInline(value) {
  const tokenized = []
  let text = String(value).replace(/`([^`]+)`/g, (_, code) => {
    const token = `\u0000${tokenized.length}\u0000`
    tokenized.push(`<code>${escapeHtml(code)}</code>`)
    return token
  })
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => {
    const token = `\u0000${tokenized.length}\u0000`
    tokenized.push(`<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`)
    return token
  })
  text = escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__(.+?)__/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/_(.+?)_/g, '<em>$1</em>')
    .replace(/~~(.+?)~~/g, '<del>$1</del>')
  return text.replace(/\u0000(\d+)\u0000/g, (_, index) => tokenized[Number(index)] || '')
}

function renderMarkdown(markdown, title = '') {
  const lines = String(markdown).replace(/\r\n?/g, '\n').split('\n')
  const output = []
  let paragraph = []
  let listType = ''
  let codeLines = null
  let codeLanguage = ''
  let skippedTitle = false

  const flushParagraph = () => {
    if (!paragraph.length) return
    const text = paragraph.join('\n').trim()
    const headingMatch = text.match(/^#\s+(.+)$/)
    if (!(headingMatch && !skippedTitle && headingMatch[1].trim().toLocaleLowerCase() === title.trim().toLocaleLowerCase())) {
      output.push(`<p>${paragraph.map((line) => renderInline(line)).join('<br>')}</p>`)
    }
    if (headingMatch) skippedTitle = true
    paragraph = []
  }
  const closeList = () => {
    if (!listType) return
    output.push(`</${listType}>`)
    listType = ''
  }
  const isTableSeparator = (line) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line)
  const cellsFrom = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim())

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const fence = line.match(/^\s*```([\w+-]*)\s*$/)
    if (fence) {
      flushParagraph()
      closeList()
      if (codeLines) {
        output.push(`<pre><code${codeLanguage ? ` class="language-${escapeHtml(codeLanguage)}"` : ''}>${escapeHtml(codeLines.join('\n'))}</code></pre>`)
        codeLines = null
        codeLanguage = ''
      } else {
        codeLines = []
        codeLanguage = fence[1]
      }
      continue
    }
    if (codeLines) {
      codeLines.push(line)
      continue
    }

    if (index + 1 < lines.length && line.includes('|') && isTableSeparator(lines[index + 1])) {
      flushParagraph()
      closeList()
      const headers = cellsFrom(line)
      index += 2
      const rows = []
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        rows.push(cellsFrom(lines[index]))
        index += 1
      }
      index -= 1
      output.push(`<div class="reader-table-wrap"><table><thead><tr>${headers.map((cell) => `<th>${renderInline(cell)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${headers.map((_, cellIndex) => `<td>${renderInline(row[cellIndex] || '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`)
      continue
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/)
    if (heading) {
      flushParagraph()
      closeList()
      const level = Math.min(3, Number(heading[1].length) + 1)
      const isTitle = !skippedTitle && heading[1].length === 1 && heading[2].trim().toLocaleLowerCase() === title.trim().toLocaleLowerCase()
      if (!isTitle) output.push(`<h${level}>${renderInline(heading[2])}</h${level}>`)
      if (heading[1].length === 1) skippedTitle = true
      continue
    }
    if (/^\s*(---+|___+|\*\*\*+)\s*$/.test(line)) {
      flushParagraph()
      closeList()
      output.push('<hr>')
      continue
    }
    const listItem = line.match(/^\s*(?:([-+*])|(\d+)\.)\s+(.+)$/)
    if (listItem) {
      flushParagraph()
      const nextType = listItem[2] ? 'ol' : 'ul'
      if (listType && listType !== nextType) closeList()
      if (!listType) {
        listType = nextType
        output.push(`<${listType}>`)
      }
      output.push(`<li>${renderInline(listItem[3])}</li>`)
      continue
    }
    if (/^\s*>\s?/.test(line)) {
      flushParagraph()
      closeList()
      output.push(`<blockquote><p>${renderInline(line.replace(/^\s*>\s?/, ''))}</p></blockquote>`)
      continue
    }
    if (!line.trim()) {
      flushParagraph()
      closeList()
      continue
    }
    paragraph.push(line)
  }
  flushParagraph()
  closeList()
  if (codeLines) output.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`)
  return output.join('\n') || '<p>这个章节还没有内容。</p>'
}

const codeSnippet = `from typing import List, Tuple\n\ndef rerank(query: str, candidates: List[str]):\n    """对候选文档进行重排，返回相关性分数。"""\n    pairs = [(query, doc) for doc in candidates]\n    scores = model.predict(pairs)\n    ranked = sorted(zip(candidates, scores), reverse=True)\n    return ranked`

onMounted(() => {
  scrollContainer = readerRoot.value?.closest('.app-shell--reader') || null
  scrollContainer?.addEventListener('scroll', handleScroll, { passive: true })
  nextTick(() => restorePosition(activeDocument.value?.id))
})

onBeforeUnmount(() => {
  if (scrollContainer) scrollContainer.removeEventListener('scroll', handleScroll)
  if (saveTimer) window.clearTimeout(saveTimer)
  rememberCurrentPosition()
})
</script>

<template>
  <main ref="readerRoot" class="reader-page" :class="{ 'reader-page--sepia': readerTheme === 'sepia' }">
    <header class="reader-topbar">
      <button class="reader-book-back" @click="emit('back')"><Icon name="arrowLeft" size="18" /><span>返回书架</span></button>
      <div class="reader-book-name"><span class="reader-book-icon"><Icon name="shelf" size="17" /></span><strong>{{ book.title }}</strong><span class="reader-divider"></span><span class="reader-progress-text">阅读进度 {{ activeChapter + 1 }} / {{ chapters.length }}</span><span class="reader-progress-track"><i :style="{ width: `${readingProgress}%` }"></i></span><b>{{ readingProgress }}%</b></div>
      <div class="reader-tools"><button class="icon-button" aria-label="缩小字号" :disabled="fontSize <= 16" @click="changeFontSize(-1)"><span class="font-small">A</span></button><button class="icon-button" aria-label="放大字号" :disabled="fontSize >= 22" @click="changeFontSize(1)"><span class="font-large">A</span></button><button class="icon-button" :aria-label="isCurrentChapterBookmarked ? '取消本章书签' : '为本章添加书签'" :aria-pressed="isCurrentChapterBookmarked" @click="toggleBookmark"><Icon name="bookmark" size="18" :class="{ 'is-bookmarked': isCurrentChapterBookmarked }" /></button><button class="icon-button" :aria-label="readerTheme === 'light' ? '切换到护眼纸色' : '切换到浅色主题'" @click="toggleTheme"><Icon name="moon" size="18" /></button></div>
    </header>

    <div class="reader-layout" :class="{ 'reader-layout--toc-collapsed': isTocCollapsed }">
      <aside class="reader-toc"><div class="toc-header"><span class="section-kicker">本书目录</span><button class="icon-button toc-collapse" :aria-label="isTocCollapsed ? '展开目录' : '收起目录'" :aria-expanded="!isTocCollapsed" @click="isTocCollapsed = !isTocCollapsed"><Icon name="list" size="17" /></button></div><div class="toc-book-title">{{ book.title }}</div><nav class="toc-list" aria-label="章节目录"><button v-for="(chapter, index) in chapters" :key="chapter.id" :class="{ 'toc-item--active': activeChapter === index }" :aria-current="activeChapter === index ? 'page' : undefined" @click="selectChapter(index)"><span class="toc-number">{{ String(index + 1).padStart(2, '0') }}</span><span>{{ chapter.title }}</span><Icon v-if="isChapterBookmarked(chapter.id)" name="bookmark" size="13" class="toc-bookmark-mark" /></button></nav><div class="toc-bottom"><span class="toc-progress-copy">本书阅读进度</span><div class="progress-track"><span :style="{ width: `${readingProgress}%` }"></span></div><strong>{{ readingProgress }}%</strong></div></aside>

      <article class="reading-canvas" :style="{ '--reader-font-size': `${fontSize}px` }">
        <div class="reading-width">
          <div class="chapter-eyebrow"><span>第 {{ String(activeChapter + 1).padStart(2, '0') }} 章</span><span class="chapter-dot"></span><span>{{ hasDocuments ? `${book.documents.length} 个章节` : '预计阅读 8 分钟' }}</span></div>
          <h1>{{ chapterName }}</h1>

          <div v-if="hasDocuments" class="reader-markdown" v-html="renderedDocument"></div>
          <template v-else>
            <p class="chapter-lead">通过合理的检索策略与重排方法，提升召回结果的相关性与准确性，是构建高质量 RAG 系统的关键环节。</p>
            <div class="reading-rule"></div>
            <h2>{{ activeChapter + 1 }}.1 为什么需要重排</h2>
            <p>在实际应用中，向量检索通常只能提供一个初步的候选集合。由于语义表示的局限性，检索结果中可能包含与问题不够相关的内容，或者缺少真正有用的信息。</p>
            <p>通过引入重排（Rerank）模型，我们可以在候选集合的基础上，进一步评估每个文档与查询的相关性，从而得到更精准的排序结果。把它想成一位细心的编辑：先快速找到相关资料，再逐篇判断哪些内容最值得呈现。</p>
            <div class="code-card"><div class="code-card-heading"><span>示例：使用重排模型进行二次排序</span><span class="code-language">Python</span></div><pre><code>{{ codeSnippet }}</code></pre></div>
            <aside class="reader-insight"><span class="insight-icon"><Icon name="sparkles" size="17" /></span><div><strong>小提示</strong><p>重排模型可以是交叉编码器（Cross-Encoder），也可以是基于大语言模型的打分方法。需要根据准确性要求、计算成本和延迟进行权衡。</p></div><button class="icon-button" aria-label="收藏提示"><Icon name="bookmark" size="16" /></button></aside>
          </template>

          <div class="reader-chapter-controls"><button class="button button-secondary" :disabled="activeChapter === 0" @click="moveChapter(-1)"><Icon name="arrowLeft" size="16" /> 上一章</button><span>第 {{ activeChapter + 1 }} / {{ chapters.length }} 章</span><button class="button button-primary" :disabled="activeChapter === chapters.length - 1" @click="moveChapter(1)">下一章 <Icon name="arrowRight" size="16" /></button></div>
        </div>
      </article>
    </div>
  </main>
</template>

<style scoped>
.reader-layout--toc-collapsed { grid-template-columns: 0 minmax(0, 1fr); }
.reader-layout--toc-collapsed .reader-toc { display: none; }
.toc-bookmark-mark { flex: 0 0 auto; margin-left: auto; color: #6592d2; fill: #a8c3eb; }
.reader-markdown { color: #66717f; font-size: var(--reader-font-size); line-height: 1.9; letter-spacing: .01em; overflow-wrap: anywhere; }
.reader-markdown :deep(p) { margin: 0 0 15px; }
.reader-markdown :deep(h2), .reader-markdown :deep(h3), .reader-markdown :deep(h4) { margin: 27px 0 12px; color: #354050; font-weight: 640; letter-spacing: -.03em; line-height: 1.45; }
.reader-markdown :deep(h2) { font-size: calc(var(--reader-font-size) * 1.24); }
.reader-markdown :deep(h3) { font-size: calc(var(--reader-font-size) * 1.12); }
.reader-markdown :deep(h4) { font-size: var(--reader-font-size); }
.reader-markdown :deep(ul), .reader-markdown :deep(ol) { margin: 0 0 17px; padding-left: 1.5em; }
.reader-markdown :deep(li) { padding-left: .25em; }
.reader-markdown :deep(li + li) { margin-top: 5px; }
.reader-markdown :deep(blockquote) { margin: 18px 0; padding: 8px 16px; border-left: 3px solid #b5cbea; color: #758196; background: rgba(232, 240, 251, .55); }
.reader-markdown :deep(blockquote p) { margin: 0; }
.reader-markdown :deep(pre) { margin: 18px 0; padding: 16px 18px; overflow: auto; border: 1px solid #e7eaee; border-radius: 10px; color: #596577; background: #f5f6f8; font: 13px/1.75 'SFMono-Regular', Consolas, 'Liberation Mono', monospace; }
.reader-markdown :deep(:not(pre) > code) { padding: .12em .38em; border-radius: 5px; color: #52627a; background: #edf1f6; font: .88em 'SFMono-Regular', Consolas, monospace; }
.reader-markdown :deep(a) { color: #4b83d9; text-decoration: none; }
.reader-markdown :deep(a:hover) { text-decoration: underline; }
.reader-markdown :deep(hr) { height: 1px; margin: 25px 0; border: 0; background: #e9ebed; }
.reader-table-wrap { margin: 19px 0; overflow-x: auto; border: 1px solid #e8ebef; border-radius: 9px; }
.reader-markdown :deep(table) { width: 100%; border-collapse: collapse; font-size: .88em; }
.reader-markdown :deep(th), .reader-markdown :deep(td) { min-width: 90px; padding: 9px 12px; border-bottom: 1px solid #e8ebef; text-align: left; vertical-align: top; }
.reader-markdown :deep(th) { color: #526176; background: #f4f6f8; font-weight: 620; }
.reader-markdown :deep(tr:last-child td) { border-bottom: 0; }
.reader-page--sepia .reader-markdown :deep(pre), .reader-page--sepia .reader-markdown :deep(th) { background: #eee8dc; }
.reader-page--sepia .reader-markdown :deep(blockquote) { background: rgba(231, 222, 206, .58); }
@media (max-width: 720px) {
  .reader-layout--toc-collapsed { grid-template-columns: 1fr; }
  .reader-markdown { font-size: max(14px, var(--reader-font-size)); }
}
</style>
