<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Icon from './Icon.vue'
import SelectionCardDialog from './SelectionCardDialog.vue'
import { getLocalRecord, getLocalRecords, localDataState, saveLocalRecord } from '../services/localDataStore.js'
import { highlightToHtml } from '../services/codeHighlight.js'
import { createHighlight, createReviewCardFromQuote, highlightColor } from '../services/readingCaptures.js'
import { startReadingSession, stopReadingSession } from '../services/readingTimeTracker.js'

const props = defineProps({
  book: { type: Object, required: true },
  initialAnchor: { type: Object, default: null },
})
const emit = defineEmits(['back', 'progress'])

const legacyStorageKey = computed(() => `zhixu-reader:v1:${encodeURIComponent(String(props.book.id || props.book.title || 'untitled'))}`)
const chapters = computed(() => {
  const documents = Array.isArray(props.book.documents) ? props.book.documents : []
  return documents
    .map((document, index) => ({
      id: String(document?.id ?? `document-${index + 1}`),
      title: String(document?.title || `第 ${index + 1} 章`),
      content: String(document?.content ?? ''),
      file: String(document?.file || ''),
      order: Number.isFinite(Number(document?.order)) ? Number(document.order) : index,
      sourceIndex: index,
    }))
    .sort((a, b) => a.order - b.order || a.sourceIndex - b.sourceIndex)
})
const hasDocuments = computed(() => Array.isArray(props.book.documents) && props.book.documents.length > 0)

function readLegacyBrowserState() {
  try {
    const saved = JSON.parse(localStorage.getItem(legacyStorageKey.value) || 'null')
    if (!saved || typeof saved !== 'object') return null
    return {
      chapterId: typeof saved.chapterId === 'string' ? saved.chapterId : null,
      chapterPositions: saved.chapterPositions && typeof saved.chapterPositions === 'object' ? saved.chapterPositions : {},
      bookmarks: Array.isArray(saved.bookmarks) ? saved.bookmarks.filter((item) => item && typeof item.chapterId === 'string') : [],
      completedChapterIds: Array.isArray(saved.completedChapterIds) ? saved.completedChapterIds.filter((id) => typeof id === 'string') : [],
      theme: saved.theme === 'sepia' ? 'sepia' : 'light',
      fontSize: Math.min(22, Math.max(16, Number(saved.fontSize) || 18)),
      readDays: Array.isArray(saved.readDays) ? saved.readDays.filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(day)) : [],
      lastReadAt: typeof saved.lastReadAt === 'string' ? saved.lastReadAt : '',
    }
  } catch {
    return null
  }
}

const initialSavedState = readLegacyBrowserState()
const readerState = ref({
  chapterId: null,
  chapterPositions: {},
  bookmarks: [],
  completedChapterIds: [],
  theme: 'light',
  fontSize: 18,
  readDays: [],
  lastReadAt: '',
})
const activeChapter = ref(0)
const readerTheme = ref(readerState.value.theme)
const fontSize = ref(readerState.value.fontSize)
const isTocCollapsed = ref(window.matchMedia('(max-width: 720px)').matches)
const isBookmarkPanelOpen = ref(false)
const readerRoot = ref(null)
const storageHint = ref('')
const selectionAction = ref({ visible: false, top: 0, left: 0, placement: 'above' })
const selectedQuote = ref('')
const selectedAnchor = ref(null)
const isNoteDialogOpen = ref(false)
const noteDraft = ref({ title: '', body: '' })
const noteError = ref('')
const noteBusy = ref(false)
let noteDraftBaseline = ''
const isCardDialogOpen = ref(false)
const cardError = ref('')
const chapterHighlights = computed(() => getLocalRecords('note').filter((note) => note.type === 'highlight'
  && String(note.bookId) === String(props.book.id)
  && String(note.anchor?.chapterId || note.chapterId || '') === String(activeDocument.value?.id || '')))
const chapterName = computed(() => chapters.value[activeChapter.value]?.title || chapters.value[0]?.title || '')
const activeDocument = computed(() => chapters.value[activeChapter.value])
const readingProgress = computed(() => chapters.value.length
  ? Math.round(new Set(readerState.value.completedChapterIds).size / chapters.value.length * 100)
  : 0)
const isCurrentChapterBookmarked = computed(() => isChapterBookmarked(activeDocument.value?.id))
const savedBookmarks = computed(() => readerState.value.bookmarks
  .map((bookmark) => {
    const index = chapters.value.findIndex((chapter) => chapter.id === bookmark.chapterId)
    return index < 0 ? null : { ...bookmark, index, title: chapters.value[index].title }
  })
  .filter(Boolean)
  .sort((a, b) => a.index - b.index || Number(a.position || 0) - Number(b.position || 0)))
const renderedDocument = computed(() => renderMarkdown(activeDocument.value?.content || '', chapterName.value, {
  bookId: props.book.id,
  file: activeDocument.value?.file || '',
  chapters: chapters.value,
}))
const tocGroups = computed(() => {
  const groups = []
  for (const [index, chapter] of chapters.value.entries()) {
    const parts = chapter.file.split('/').filter(Boolean)
    const folder = parts.length > 1 ? parts.slice(0, -1).join(' / ') : ''
    let group = groups.find((item) => item.folder === folder)
    if (!group) { group = { folder, chapters: [] }; groups.push(group) }
    group.chapters.push({ chapter, index })
  }
  return groups
})

let isHydrating = false
let isSavingRecord = false
let lastSavedPayload = ''
let legacyState = null
let hasUnpersistedChanges = false
let scrollContainer = null
let saveTimer = null
let restoringScroll = false
let selectionTimer = null
let ignoreSelectionChange = false
let isReaderUnmounted = false
let isLeavingAfterFlush = false

function isChapterBookmarked(chapterId) {
  return Boolean(chapterId && readerState.value.bookmarks.some((bookmark) => bookmark.chapterId === chapterId))
}

function currentDateKey() {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

function applyReaderState(saved) {
  const validPositions = saved.chapterPositions && typeof saved.chapterPositions === 'object' && !Array.isArray(saved.chapterPositions)
    ? saved.chapterPositions
    : {}
  readerState.value = {
    chapterId: typeof saved.chapterId === 'string' ? saved.chapterId : null,
    chapterPositions: validPositions,
    bookmarks: Array.isArray(saved.bookmarks) ? saved.bookmarks.filter((item) => item && typeof item.chapterId === 'string') : [],
    completedChapterIds: Array.isArray(saved.completedChapterIds)
      ? [...new Set(saved.completedChapterIds.filter((id) => chapters.value.some((chapter) => chapter.id === id)))]
      : [],
    theme: saved.theme === 'sepia' ? 'sepia' : 'light',
    fontSize: Math.min(22, Math.max(16, Number(saved.fontSize) || 18)),
    readDays: Array.isArray(saved.readDays) ? [...new Set(saved.readDays.filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(day)))].slice(-180) : [],
    lastReadAt: typeof saved.lastReadAt === 'string' ? saved.lastReadAt : '',
  }
  readerTheme.value = readerState.value.theme
  fontSize.value = readerState.value.fontSize
  const savedIndex = chapters.value.findIndex((chapter) => chapter.id === readerState.value.chapterId)
  activeChapter.value = savedIndex >= 0 ? savedIndex : 0
  nextTick(() => restorePosition(activeDocument.value?.id))
}

async function hydrateReaderState() {
  if (isSavingRecord) return
  let shouldMigrateLegacy = false
  isHydrating = true
  try {
    const saved = getLocalRecord('reader', String(props.book.id))
    if (saved) {
      applyReaderState(saved)
      lastSavedPayload = JSON.stringify(readerState.value)
      hasUnpersistedChanges = false
      legacyState = null
      try { localStorage.removeItem(legacyStorageKey.value) } catch { /* Old data cleanup is best effort after local-file migration. */ }
    } else if (legacyState) {
      applyReaderState(legacyState)
      shouldMigrateLegacy = true
    }
    storageHint.value = ''
  } catch (error) {
    storageHint.value = error.message || '读取本机阅读进度失败。'
  } finally {
    isHydrating = false
  }
  if (shouldMigrateLegacy) persistState()
}

function persistState() {
  const chapter = chapters.value[activeChapter.value]
  readerState.value.chapterId = chapter?.id || null
  readerState.value.theme = readerTheme.value
  readerState.value.fontSize = fontSize.value
  readerState.value.completedChapterIds = [...new Set((readerState.value.completedChapterIds || [])
    .filter((id) => chapters.value.some((item) => item.id === id)))]
  readerState.value.lastReadAt = new Date().toISOString()
  readerState.value.readDays = [...new Set([...(readerState.value.readDays || []), currentDateKey()])].slice(-180)
  emit('progress', { bookId: props.book.id, progress: readingProgress.value, chapterTitle: chapter?.title })
  if (isHydrating) return
  hasUnpersistedChanges = true
  if (saveTimer) window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => { void flushState() }, 900)
}

async function flushState() {
  if (saveTimer) window.clearTimeout(saveTimer)
  saveTimer = null
  if (!chapters.value.length || isHydrating) return
  const payload = {
    chapterId: readerState.value.chapterId,
    chapterPositions: readerState.value.chapterPositions,
    bookmarks: readerState.value.bookmarks,
    completedChapterIds: readerState.value.completedChapterIds,
    theme: readerTheme.value,
    fontSize: fontSize.value,
    readDays: readerState.value.readDays,
    lastReadAt: readerState.value.lastReadAt,
  }
  const serialized = JSON.stringify(payload)
  if (serialized === lastSavedPayload) {
    hasUnpersistedChanges = false
    return
  }
  isSavingRecord = true
  try {
    await saveLocalRecord('reader', String(props.book.id), payload)
    lastSavedPayload = serialized
    hasUnpersistedChanges = false
    storageHint.value = ''
    try { localStorage.removeItem(legacyStorageKey.value) } catch { /* Old data cleanup is best effort after local-file migration. */ }
  } catch (error) {
    hasUnpersistedChanges = true
    storageHint.value = `${error.message || '无法保存阅读进度。'} 当前修改尚未写入本机文件，暂时只留在此页面；服务恢复后会自动重试。`
    if (localDataState.serviceAvailable && !isReaderUnmounted) {
      saveTimer = window.setTimeout(() => { void flushState() }, 5000)
    }
  } finally {
    isSavingRecord = false
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

async function requestBack() {
  rememberCurrentPosition()
  await flushState()
  if ((hasUnpersistedChanges || isNoteDialogOpen.value)
    && !window.confirm('阅读进度或摘录笔记还没有写入本机目录。现在离开会丢失未保存的修改，仍要离开吗？')) return
  isLeavingAfterFlush = true
  emit('back')
}

function protectUnsavedProgress(event) {
  if (!hasUnpersistedChanges && !isNoteDialogOpen.value) return
  event.preventDefault()
  event.returnValue = ''
}

function handleScroll() {
  if (restoringScroll) return
  selectionAction.value.visible = false
  const chapter = chapters.value[activeChapter.value]
  if (!chapter) return
  readerState.value.chapterPositions[chapter.id] = currentScrollPosition()
  readerState.value.chapterId = chapter.id
  if (scrollContainer && scrollContainer.scrollTop + scrollContainer.clientHeight >= scrollContainer.scrollHeight - 24
    && !readerState.value.completedChapterIds.includes(chapter.id)) {
    readerState.value.completedChapterIds.push(chapter.id)
  }
  if (saveTimer) window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => {
    persistState()
    saveTimer = null
  }, 900)
}

function restorePosition(chapterId) {
  restoringScroll = true
  const position = readerState.value.chapterPositions[chapterId] || 0
  setScrollPosition(position)
  window.setTimeout(() => { restoringScroll = false }, 80)
}

function selectChapter(index) {
  selectionAction.value.visible = false
  if (window.matchMedia('(max-width: 720px)').matches) isTocCollapsed.value = true
  if (index < 0 || index >= chapters.value.length || index === activeChapter.value) return
  rememberCurrentPosition()
  activeChapter.value = index
  const chapter = chapters.value[index]
  readerState.value.chapterId = chapter.id
  persistState()
  nextTick(() => restorePosition(chapter.id))
}

function toggleChapterCompletion() {
  const chapterId = activeDocument.value?.id
  if (!chapterId) return
  const completed = readerState.value.completedChapterIds.includes(chapterId)
  readerState.value.completedChapterIds = completed
    ? readerState.value.completedChapterIds.filter((id) => id !== chapterId)
    : [...readerState.value.completedChapterIds, chapterId]
  persistState()
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

function jumpToBookmark(bookmark) {
  selectChapter(bookmark.index)
  nextTick(() => {
    setScrollPosition(bookmark.position)
    isBookmarkPanelOpen.value = false
    persistState()
  })
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

let activeRenderContext = {}

function imageSource(path, context) {
  if (!path || /^https?:\/\//i.test(path) || path.startsWith('/') || path.startsWith('//')) return ''
  let decoded
  try { decoded = decodeURIComponent(path.split(/[?#]/, 1)[0]) } catch { return '' }
  const segments = String(context.file || '').replace(/\\/g, '/').split('/').slice(0, -1).filter(Boolean)
  for (const segment of decoded.replace(/\\/g, '/').split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (!segments.length) return ''
      segments.pop()
    } else {
      segments.push(segment)
    }
  }
  if (!segments.length) return ''
  const encoded = segments.map((segment) => encodeURIComponent(segment)).join('/')
  return '/api/books/' + encodeURIComponent(String(context.bookId)) + '/assets/' + encoded
}

function resolveMarkdownChapter(path, context) {
  if (!path || path.startsWith('/') || /^https?:\/\//i.test(path)) return null
  let decoded
  try { decoded = decodeURIComponent(path.split(/[?#]/, 1)[0]) } catch { return null }
  const segments = String(context.file || '').replace(/\\/g, '/').split('/').slice(0, -1).filter(Boolean)
  for (const segment of decoded.replace(/\\/g, '/').split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (!segments.length) return null
      segments.pop()
    } else segments.push(segment)
  }
  const file = segments.join('/')
  if (!/\.(md|markdown)$/i.test(file)) return null
  return context.chapters?.find((chapter) => chapter.file.toLocaleLowerCase() === file.toLocaleLowerCase()) || null
}

function renderInline(value) {
  const tokenized = []
  let text = String(value).replace(/`([^`]+)`/g, (_, code) => {
    const token = `\u0000${tokenized.length}\u0000`
    tokenized.push(`<code>${escapeHtml(code)}</code>`)
    return token
  })
  text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g, (_, alt, path) => {
    const token = String.fromCharCode(0) + tokenized.length + String.fromCharCode(0)
    const source = imageSource(path, activeRenderContext)
    tokenized.push(source
      ? '<img src="' + escapeHtml(source) + '" alt="' + escapeHtml(alt) + '" loading="lazy" decoding="async" referrerpolicy="no-referrer">'
      : '<span class="reader-image-missing">' + escapeHtml(alt || '图片无法显示') + '</span>')
    return token
  })
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g, (_, label, url) => {
    const token = String.fromCharCode(0) + tokenized.length + String.fromCharCode(0)
    if (/^https?:\/\//i.test(url)) {
      tokenized.push(`<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`)
    } else {
      const chapter = resolveMarkdownChapter(url, activeRenderContext)
      tokenized.push(chapter
        ? `<a href="#" data-chapter-id="${escapeHtml(chapter.id)}">${escapeHtml(label)}</a>`
        : `<span class="reader-link-unavailable" title="目标章节不在这本书里">${escapeHtml(label)}</span>`)
    }
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

function renderMarkdown(markdown, title = '', context = {}) {
  activeRenderContext = context
  const lines = String(markdown).replace(/\r\n?/g, '\n').split('\n')
  const output = []
  let paragraph = []
  let listType = ''
  let quoteLines = []
  let codeLines = null
  let codeLanguage = ''
  let fenceMark = ''
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
  const flushQuote = () => {
    if (!quoteLines.length) return
    const calloutTypes = {
      NOTE: ['note', '说明'],
      TIP: ['tip', '建议'],
      IMPORTANT: ['important', '重点'],
      WARNING: ['warning', '注意'],
      CAUTION: ['caution', '警示'],
    }
    const match = quoteLines[0].match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$/i)
    let lines = quoteLines
    let wrapper = 'blockquote'
    let className = ''
    let heading = ''
    if (match) {
      const [type, label] = calloutTypes[match[1].toUpperCase()]
      wrapper = 'aside'
      className = ` class="reader-callout reader-callout--${type}"`
      heading = `<strong>${label}</strong>`
      lines = [match[2], ...quoteLines.slice(1)]
    }
    const paragraphs = []
    let current = []
    const flushCurrent = () => {
      if (current.length) paragraphs.push(`<p>${current.map((line) => renderInline(line)).join('<br>')}</p>`)
      current = []
    }
    for (const line of lines) {
      if (!line.trim()) flushCurrent()
      else current.push(line)
    }
    flushCurrent()
    output.push(`<${wrapper}${className}>${heading}${paragraphs.join('')}</${wrapper}>`)
    quoteLines = []
  }
  const isTableSeparator = (line) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line)
  const cellsFrom = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim())

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    // 支持反引号与波浪线两种围栏；闭合必须使用同一种标记，
    // 避免正文里的 `~~~` 被当成代码块边界。
    const fence = codeLines
      ? line.match(/^\s*(`{3,}|~{3,})\s*$/)
      : line.match(/^\s*(`{3,}|~{3,})([\w+-]*)\s*$/)
    if (fence && (!codeLines || fence[1][0] === fenceMark)) {
      flushQuote()
      flushParagraph()
      closeList()
      if (codeLines) {
        const code = codeLines.join('\n')
        const highlighted = highlightToHtml(code, codeLanguage)
        output.push(`<pre><code class="${highlighted ? 'hljs ' : ''}${codeLanguage ? `language-${escapeHtml(codeLanguage)}` : ''}">${highlighted || escapeHtml(code)}</code></pre>`)
        codeLines = null
        codeLanguage = ''
        fenceMark = ''
      } else {
        codeLines = []
        codeLanguage = fence[2]
        fenceMark = fence[1][0]
      }
      continue
    }
    if (codeLines) {
      codeLines.push(line)
      continue
    }

    if (index + 1 < lines.length && line.includes('|') && isTableSeparator(lines[index + 1])) {
      flushQuote()
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
      flushQuote()
      flushParagraph()
      closeList()
      const level = Math.min(3, Number(heading[1].length) + 1)
      const isTitle = !skippedTitle && heading[1].length === 1 && heading[2].trim().toLocaleLowerCase() === title.trim().toLocaleLowerCase()
      if (!isTitle) output.push(`<h${level}>${renderInline(heading[2])}</h${level}>`)
      if (heading[1].length === 1) skippedTitle = true
      continue
    }
    if (/^\s*(---+|___+|\*\*\*+)\s*$/.test(line)) {
      flushQuote()
      flushParagraph()
      closeList()
      output.push('<hr>')
      continue
    }
    const listItem = line.match(/^\s*(?:([-+*])|(\d+)\.)\s+(.+)$/)
    if (listItem) {
      flushQuote()
      flushParagraph()
      const nextType = listItem[2] ? 'ol' : 'ul'
      if (listType && listType !== nextType) closeList()
      if (!listType) {
        listType = nextType
        output.push(`<${listType}>`)
      }
      const task = listItem[3].match(/^\[([ xX])\]\s*(.*)$/)
      if (task) {
        const checked = task[1].toLocaleLowerCase() === 'x'
        const label = checked ? '已完成' : '未完成'
        output.push(`<li class="reader-task-item"><input class="reader-task-checkbox" type="checkbox" disabled${checked ? ' checked' : ''} aria-label="${label}"><span>${renderInline(task[2])}</span></li>`)
      } else output.push(`<li>${renderInline(listItem[3])}</li>`)
      continue
    }
    if (/^\s*>\s?/.test(line)) {
      flushParagraph()
      closeList()
      quoteLines.push(line.replace(/^\s*>\s?/, ''))
      continue
    }
    if (!line.trim()) {
      flushQuote()
      flushParagraph()
      closeList()
      continue
    }
    flushQuote()
    paragraph.push(line)
  }
  flushQuote()
  flushParagraph()
  closeList()
  if (codeLines) {
    const code = codeLines.join('\n')
    const highlighted = highlightToHtml(code, codeLanguage)
    output.push(`<pre><code class="${highlighted ? 'hljs' : ''}">${highlighted || escapeHtml(code)}</code></pre>`)
    codeLines = null
    codeLanguage = ''
    fenceMark = ''
  }
  return output.join('\n') || '<p>这个章节还没有内容。</p>'
}

function handleReaderClick(event) {
  const link = event.target.closest?.('a[data-chapter-id]')
  if (!link) return
  event.preventDefault()
  const index = chapters.value.findIndex((chapter) => chapter.id === link.getAttribute('data-chapter-id'))
  if (index >= 0) selectChapter(index)
}

function updateSelectionAction() {
  if (ignoreSelectionChange) return
  const selection = window.getSelection()
  const text = selection?.toString().trim() || ''
  const content = readerRoot.value?.querySelector('.reader-markdown')
  if (!selection || selection.isCollapsed || !text || !content
    || !content.contains(selection.anchorNode) || !content.contains(selection.focusNode)) {
    selectionAction.value.visible = false
    return
  }
  if (text.length > 8000) {
    selectionAction.value.visible = false
    storageHint.value = '一次最多摘录 8,000 字，请选择更短的一段。'
    return
  }

  const range = selection.getRangeAt(0)
  const rect = range.getBoundingClientRect()
  if (!rect.width && !rect.height) return
  selectedQuote.value = text
  selectedAnchor.value = createMarkdownAnchor(content, range, text)
  const placement = rect.top > 58 ? 'above' : 'below'
  selectionAction.value = {
    visible: true,
    left: Math.min(window.innerWidth - 92, Math.max(92, rect.left + rect.width / 2)),
    top: placement === 'above' ? rect.top - 46 : rect.bottom + 10,
    placement,
  }
}

function createMarkdownAnchor(container, range, exact) {
  try {
    const beforeRange = document.createRange()
    beforeRange.selectNodeContents(container)
    beforeRange.setEnd(range.startContainer, range.startOffset)
    const raw = range.toString()
    const leadingSpace = raw.length - raw.trimStart().length
    const start = beforeRange.toString().length + leadingSpace
    const end = start + exact.length
    const fullText = container.textContent || ''
    return {
      format: 'markdown',
      chapterId: String(activeDocument.value?.id || ''),
      start,
      end,
      exact,
      prefix: fullText.slice(Math.max(0, start - 64), start),
      suffix: fullText.slice(end, end + 64),
    }
  } catch {
    return { format: 'markdown', chapterId: String(activeDocument.value?.id || ''), exact }
  }
}

/** 章节渲染后把本书划线重绘成 <mark>：先清掉旧标记还原纯文本，
 *  再按锚点在 textContent 里的偏移逐段包一层，偏移全程保持有效。 */
function paintChapterHighlights() {
  const content = readerRoot.value?.querySelector('.reader-markdown')
  if (!content) return
  content.querySelectorAll('mark.reader-highlight-mark').forEach((mark) => {
    const parent = mark.parentNode
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark)
    mark.remove()
    parent.normalize()
  })
  if (!chapterHighlights.value.length) return
  const fullText = content.textContent || ''
  for (const highlight of chapterHighlights.value) {
    const anchor = highlight.anchor || {}
    const exact = String(anchor.exact || '').trim()
    let start = findAnchorOffset(fullText, anchor)
    if (start === null && exact) start = fullText.indexOf(exact)
    if (start === null || start < 0) continue
    const length = Number.isFinite(Number(anchor.end)) && Number(anchor.end) > start
      ? Math.min(Number(anchor.end) - start, exact.length || Number(anchor.end) - start)
      : exact.length
    wrapTextOffsetWithMark(content, start, start + (length > 0 ? length : 0), highlightColor(highlight.color))
  }
}

function wrapTextOffsetWithMark(container, start, end, color) {
  if (!(end > start)) return
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  const segments = []
  let offset = 0
  let node = walker.nextNode()
  while (node) {
    const length = node.textContent.length
    if (offset < end && offset + length > start) {
      segments.push({ node, from: Math.max(0, start - offset), to: Math.min(length, end - offset) })
    }
    offset += length
    node = walker.nextNode()
  }
  for (const segment of segments.reverse()) {
    let target = segment.node
    try {
      if (segment.to < target.textContent.length) target.splitText(segment.to)
      if (segment.from > 0) target = target.splitText(segment.from)
    } catch { /* 节点可能已被相邻划线拆分，跳过这一段。 */ }
    if (!target.parentNode) continue
    const mark = document.createElement('mark')
    mark.className = 'reader-highlight-mark'
    mark.style.background = color
    target.parentNode.insertBefore(mark, target)
    mark.appendChild(target)
  }
}

// 用签名而不是数组本身做监听：心跳落盘会让 records 事件数组变化，
// 若直接 watch 数组，每分钟都会无谓地拆装一次高亮 DOM，打断用户选词。
const chapterHighlightSignature = computed(() => chapterHighlights.value
  .map((item) => `${item.id}:${item.color}`)
  .join('|'))
watch([chapterHighlightSignature, renderedDocument], () => { nextTick(paintChapterHighlights) })

function findAnchorOffset(fullText, anchor) {  const exact = String(anchor.exact || '').trim()
  if (!exact) return null
  const expected = Math.max(0, Number(anchor.start) || 0)
  const prefix = String(anchor.prefix || '').slice(-48)
  const suffix = String(anchor.suffix || '').slice(0, 48)
  const candidates = []
  let cursor = 0
  while (cursor <= fullText.length) {
    const position = fullText.indexOf(exact, cursor)
    if (position < 0) break
    const before = fullText.slice(Math.max(0, position - prefix.length), position)
    const after = fullText.slice(position + exact.length, position + exact.length + suffix.length)
    const contextScore = Number(Boolean(prefix) && before.endsWith(prefix)) + Number(Boolean(suffix) && after.startsWith(suffix))
    candidates.push({ position, contextScore, distance: Math.abs(position - expected) })
    cursor = position + Math.max(1, exact.length)
  }
  candidates.sort((left, right) => right.contextScore - left.contextScore || left.distance - right.distance)
  return candidates[0]?.position ?? null
}

function textPointAt(container, offset) {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  let remaining = Math.max(0, offset)
  let lastNode = null
  let node = walker.nextNode()
  while (node) {
    lastNode = node
    if (remaining <= node.textContent.length) return { node, offset: remaining }
    remaining -= node.textContent.length
    node = walker.nextNode()
  }
  return lastNode ? { node: lastNode, offset: lastNode.textContent.length } : null
}

async function applyInitialAnchor(anchor) {
  if (!anchor || !chapters.value.length) return
  const chapterId = String(anchor.chapterId || '')
  const targetIndex = chapters.value.findIndex((chapter) => chapter.id === chapterId)
  if (targetIndex >= 0) {
    activeChapter.value = targetIndex
    readerState.value.chapterId = chapterId
  }
  await nextTick()
  const markdownRoot = readerRoot.value?.querySelector('.reader-markdown')
  const fullText = markdownRoot?.textContent || ''
  const start = findAnchorOffset(fullText, anchor)
  const exact = String(anchor.exact || '').trim()
  const startPoint = start === null ? null : textPointAt(markdownRoot, start)
  const endPoint = startPoint ? textPointAt(markdownRoot, start + exact.length) : null
  if (startPoint && endPoint) {
    const range = document.createRange()
    range.setStart(startPoint.node, startPoint.offset)
    range.setEnd(endPoint.node, endPoint.offset)
    const rect = range.getBoundingClientRect()
    const selection = window.getSelection()
    ignoreSelectionChange = true
    selection?.removeAllRanges()
    selection?.addRange(range)
    setScrollPosition(currentScrollPosition() + rect.top - 150)
    storageHint.value = '已定位到这条笔记的原文摘录。'
    window.setTimeout(() => { ignoreSelectionChange = false }, 180)
  } else {
    setScrollPosition(0)
    storageHint.value = exact
      ? '课程内容可能已更新，已打开关联章节，请在附近查找原文。'
      : '已打开这条笔记关联的章节。'
  }
  const activeChapterId = chapters.value[activeChapter.value]?.id || null
  readerState.value.chapterId = activeChapterId
  if (activeChapterId) readerState.value.chapterPositions[activeChapterId] = currentScrollPosition()
  persistState()
  await flushState()
}

function scheduleSelectionAction() {
  if (ignoreSelectionChange) return
  if (selectionTimer) window.clearTimeout(selectionTimer)
  selectionTimer = window.setTimeout(updateSelectionAction, 30)
}

function openNoteFromSelection() {
  selectionAction.value.visible = false
  noteDraft.value = { title: `${chapterName.value} · 摘录`.slice(0, 120), body: '' }
  noteDraftBaseline = JSON.stringify(noteDraft.value)
  noteError.value = ''
  isNoteDialogOpen.value = true
}

async function highlightFromSelection() {
  selectionAction.value.visible = false
  try {
    await createHighlight({
      bookId: String(props.book.id),
      chapterId: String(activeDocument.value?.id || ''),
      chapterTitle: chapterName.value,
      excerpt: selectedQuote.value,
      anchor: selectedAnchor.value,
      format: 'markdown',
    })
    storageHint.value = '已划线，这段文字会一直高亮显示。'
  } catch (error) {
    storageHint.value = error.message || '划线没有保存成功，请稍后重试。'
  }
}

function openCardFromSelection() {
  selectionAction.value.visible = false
  cardError.value = ''
  isCardDialogOpen.value = true
}

async function saveSelectionCard({ front, back, resolve, reject }) {
  try {
    await createReviewCardFromQuote({
      bookId: String(props.book.id),
      chapterId: String(activeDocument.value?.id || ''),
      front,
      back,
    })
    storageHint.value = '复习卡已生成，到期会出现在复习队列里。'
    resolve()
  } catch (error) {
    cardError.value = error.message || '卡片没有保存成功，请稍后重试。'
    reject(error)
  }
}

function closeNoteDialog() {
  if (noteBusy.value) return
  const hasDraft = JSON.stringify(noteDraft.value) !== noteDraftBaseline
  if ((hasDraft || noteError.value) && !window.confirm('这条摘录笔记尚未保存，确定丢弃吗？')) return
  isNoteDialogOpen.value = false
  noteError.value = ''
}

async function saveReadingNote() {
  if (!selectedQuote.value || noteBusy.value) return
  noteBusy.value = true
  noteError.value = ''
  const now = new Date().toISOString()
  const id = window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const body = noteDraft.value.body.trim()
  try {
    await saveLocalRecord('note', id, {
      title: noteDraft.value.title.trim().slice(0, 120) || `${chapterName.value} · 摘录`.slice(0, 120),
      content: body,
      excerpt: selectedQuote.value,
      bookId: String(props.book.id),
      chapterId: String(activeDocument.value?.id || ''),
      chapterTitle: chapterName.value,
      format: 'markdown',
      anchor: selectedAnchor.value,
      color: 'yellow',
      createdAt: now,
      updatedAt: now,
    })
    isNoteDialogOpen.value = false
    storageHint.value = '这段摘录已保存到关联本书与章节的私人笔记。'
  } catch (error) {
    noteError.value = error.message || '笔记暂时没有保存成功，请稍后重试。'
  } finally {
    noteBusy.value = false
  }
}

const codeSnippet = `from typing import List, Tuple\n\ndef rerank(query: str, candidates: List[str]):\n    """对候选文档进行重排，返回相关性分数。"""\n    pairs = [(query, doc) for doc in candidates]\n    scores = model.predict(pairs)\n    ranked = sorted(zip(candidates, scores), reverse=True)\n    return ranked`

watch(
  () => `${localDataState.serviceAvailable ? 'online' : 'offline'}|${localDataState.events
    .filter((event) => event.kind === 'reader' && event.entityId === String(props.book.id))
    .map((event) => event.id)
    .join('|')}`,
  () => {
    if (isSavingRecord) return
    if (hasUnpersistedChanges) {
      if (localDataState.serviceAvailable) void flushState()
      return
    }
    void hydrateReaderState()
  },
)

onMounted(async () => {
  legacyState = initialSavedState
  startReadingSession(props.book.id)
  scrollContainer = readerRoot.value?.closest('.app-shell--reader') || null
  scrollContainer?.addEventListener('scroll', handleScroll, { passive: true })
  document.addEventListener('selectionchange', scheduleSelectionAction)
  await hydrateReaderState()
  if (props.initialAnchor) await applyInitialAnchor(props.initialAnchor)
  else if (chapters.value.length && (localDataState.serviceAvailable || legacyState)) persistState()
  window.addEventListener('beforeunload', protectUnsavedProgress)
  nextTick(() => restorePosition(activeDocument.value?.id))
})

onBeforeUnmount(() => {
  isReaderUnmounted = true
  stopReadingSession()
  window.removeEventListener('beforeunload', protectUnsavedProgress)
  document.removeEventListener('selectionchange', scheduleSelectionAction)
  if (selectionTimer) window.clearTimeout(selectionTimer)
  if (scrollContainer) scrollContainer.removeEventListener('scroll', handleScroll)
  if (saveTimer) window.clearTimeout(saveTimer)
  if (!isLeavingAfterFlush) {
    rememberCurrentPosition()
    if (hasUnpersistedChanges || localDataState.serviceAvailable) void flushState()
  }
})
</script>

<template>
  <main ref="readerRoot" class="reader-page" :class="{ 'reader-page--sepia': readerTheme === 'sepia' }">
    <header class="reader-topbar">
      <button class="reader-book-back" @click="requestBack"><Icon name="arrowLeft" size="18" /><span>返回</span></button>
      <div class="reader-book-name"><span class="reader-book-icon"><Icon name="shelf" size="17" /></span><strong>{{ book.title }}</strong><span class="reader-divider"></span><span v-if="chapters.length" class="reader-progress-text">阅读进度 {{ activeChapter + 1 }} / {{ chapters.length }}</span><span v-else class="reader-progress-text">还没有章节</span><span class="reader-progress-track"><i :style="{ width: `${readingProgress}%` }"></i></span><b>{{ readingProgress }}%</b></div>
      <div class="reader-tools"><button class="icon-button" aria-label="缩小字号" :disabled="fontSize <= 16" @click="changeFontSize(-1)"><span class="font-small">A</span></button><button class="icon-button" aria-label="放大字号" :disabled="fontSize >= 22" @click="changeFontSize(1)"><span class="font-large">A</span></button><button class="icon-button" :aria-label="isCurrentChapterBookmarked ? '取消本章书签' : '为本章添加书签'" :aria-pressed="isCurrentChapterBookmarked" @click="toggleBookmark"><Icon name="bookmark" size="18" :class="{ 'is-bookmarked': isCurrentChapterBookmarked }" /></button><button class="icon-button reader-toc-toggle" :aria-label="isTocCollapsed ? '展开章节目录' : '收起章节目录'" :aria-expanded="!isTocCollapsed" @click="isTocCollapsed = !isTocCollapsed"><Icon name="list" size="18" /></button><div class="reader-bookmark-control"><button class="icon-button" aria-label="查看书签" :aria-expanded="isBookmarkPanelOpen" @click="isBookmarkPanelOpen = !isBookmarkPanelOpen"><Icon name="bookmark" size="18" /><span v-if="savedBookmarks.length" class="reader-bookmark-count">{{ savedBookmarks.length }}</span></button><div v-if="isBookmarkPanelOpen" class="reader-bookmark-panel"><div class="reader-bookmark-heading"><strong>本书书签</strong><span>{{ savedBookmarks.length }}</span></div><button v-for="bookmark in savedBookmarks" :key="bookmark.chapterId" class="reader-bookmark-item" @click="jumpToBookmark(bookmark)"><span><small>第 {{ bookmark.index + 1 }} 章</small><strong>{{ bookmark.title }}</strong></span><Icon name="arrowRight" size="15" /></button><p v-if="!savedBookmarks.length" class="reader-bookmark-empty">阅读时点击书签图标，保存当前章节位置。</p></div></div><button class="icon-button" :aria-label="readerTheme === 'light' ? '切换到护眼纸色' : '切换到浅色主题'" @click="toggleTheme"><Icon name="moon" size="18" /></button></div>
    </header>

    <div class="reader-layout" :class="{ 'reader-layout--toc-collapsed': isTocCollapsed }">
      <button v-if="!isTocCollapsed" class="reader-toc-backdrop" aria-label="关闭章节目录" @click="isTocCollapsed = true"></button>
      <aside class="reader-toc"><div class="toc-header"><span class="section-kicker">本书目录</span><button class="icon-button toc-collapse" :aria-label="isTocCollapsed ? '展开目录' : '收起目录'" :aria-expanded="!isTocCollapsed" @click="isTocCollapsed = !isTocCollapsed"><Icon name="list" size="17" /></button></div><div class="toc-book-title">{{ book.title }}</div><nav class="toc-list" aria-label="章节目录"><section v-for="group in tocGroups" :key="group.folder || 'root'" class="toc-section"><span v-if="group.folder" class="toc-folder">{{ group.folder }}</span><button v-for="{ chapter, index } in group.chapters" :key="chapter.id" :class="{ 'toc-item--active': activeChapter === index }" :aria-current="activeChapter === index ? 'page' : undefined" @click="selectChapter(index)"><span class="toc-number">{{ String(index + 1).padStart(2, '0') }}</span><span>{{ chapter.title }}</span><Icon v-if="isChapterBookmarked(chapter.id)" name="bookmark" size="13" class="toc-bookmark-mark" /></button></section></nav><div class="toc-bottom"><span class="toc-progress-copy">本书阅读进度</span><div class="progress-track"><span :style="{ width: `${readingProgress}%` }"></span></div><strong>{{ readingProgress }}%</strong></div></aside>

      <article class="reading-canvas" :style="{ '--reader-font-size': `${fontSize}px` }">
        <div class="reading-width">
          <p v-if="storageHint" class="reader-storage-hint" role="status">{{ storageHint }}</p>
          <p v-if="!hasDocuments" class="reader-storage-hint" role="status">这本书还没有 Markdown 章节内容。</p>
          <div v-if="chapters.length" class="chapter-eyebrow"><span>第 {{ String(activeChapter + 1).padStart(2, '0') }} 章</span><span class="chapter-dot"></span><span>{{ book.documents.length }} 个章节</span></div>
          <h1>{{ chapters.length ? chapterName : '这本书还没有章节' }}</h1>

          <div v-if="hasDocuments" class="reader-markdown" v-html="renderedDocument" @click="handleReaderClick"></div>

          <div v-if="chapters.length" class="reader-chapter-controls"><button class="button button-secondary" :disabled="activeChapter === 0" @click="moveChapter(-1)"><Icon name="arrowLeft" size="16" /> 上一章</button><button class="chapter-completion-button" :class="{ 'is-complete': readerState.completedChapterIds.includes(activeDocument?.id) }" :aria-pressed="readerState.completedChapterIds.includes(activeDocument?.id)" @click="toggleChapterCompletion"><Icon :name="readerState.completedChapterIds.includes(activeDocument?.id) ? 'check' : 'circle'" size="15" />{{ readerState.completedChapterIds.includes(activeDocument?.id) ? '已读' : '标记本章已读' }}</button><span>第 {{ activeChapter + 1 }} / {{ chapters.length }} 章</span><button class="button button-primary" :disabled="activeChapter === chapters.length - 1" @click="moveChapter(1)">下一章 <Icon name="arrowRight" size="16" /></button></div>
        </div>
      </article>
    </div>

    <div v-if="selectionAction.visible" class="reader-selection-action" :class="{ 'is-below': selectionAction.placement === 'below' }" :style="{ top: `${selectionAction.top}px`, left: `${selectionAction.left}px` }" @mousedown.prevent @mouseup.stop>
      <button type="button" @click="highlightFromSelection"><span class="selection-highlight-swatch" aria-hidden="true"></span> 划线</button>
      <button type="button" @click="openCardFromSelection"><Icon name="review" size="15" /> 复习卡</button>
      <button type="button" @click="openNoteFromSelection"><Icon name="notes" size="15" /> 笔记</button>
    </div>

    <SelectionCardDialog :open="isCardDialogOpen" :quote="selectedQuote" :source="`${book.title} · ${chapterName}`" @close="isCardDialogOpen = false" @save="saveSelectionCard" />

    <div v-if="isNoteDialogOpen" class="reader-note-backdrop" @click.self="closeNoteDialog">
      <form class="reader-note-dialog" role="dialog" aria-modal="true" aria-labelledby="reader-note-title" @submit.prevent="saveReadingNote">
        <header><div><span class="section-kicker">{{ book.title }} · {{ chapterName }}</span><h2 id="reader-note-title">把阅读重点收进笔记</h2></div><button type="button" class="icon-button" aria-label="关闭笔记窗口" @click="closeNoteDialog"><Icon name="close" size="17" /></button></header>
        <label class="reader-note-field"><span>笔记标题</span><input v-model="noteDraft.title" maxlength="120" placeholder="给这条笔记起个名字" /></label>
        <div class="reader-note-quote"><span>原文摘录</span><blockquote>{{ selectedQuote }}</blockquote></div>
        <label class="reader-note-field"><span>自己的理解或问题 <small>可选</small></span><textarea v-model="noteDraft.body" rows="5" placeholder="写下理解、疑问或之后想复习的内容"></textarea></label>
        <p class="reader-note-privacy">笔记保存在本机，并自动关联这本书的当前章节。</p>
        <p v-if="noteError" class="reader-note-error" role="alert">{{ noteError }}</p>
        <footer><button type="button" class="button button-secondary" :disabled="noteBusy" @click="closeNoteDialog">取消</button><button type="submit" class="button button-primary" :disabled="noteBusy || !noteDraft.title.trim()">{{ noteBusy ? '正在保存…' : '保存到私人笔记' }}</button></footer>
      </form>
    </div>
  </main>
</template>

<style scoped>
.reader-selection-action { position: fixed; z-index: 80; transform: translateX(-50%); padding: 4px; border: 1px solid #e7ebf1; border-radius: 11px; background: #fff; box-shadow: 0 8px 24px rgba(37,52,72,.16); }
.reader-selection-action.is-below::after { top: -5px; bottom: auto; transform: rotate(225deg); }
.reader-selection-action::after { position: absolute; bottom: -5px; left: calc(50% - 5px); width: 9px; height: 9px; border-right: 1px solid #e7ebf1; border-bottom: 1px solid #e7ebf1; background: #fff; content: ''; transform: rotate(45deg); }
.reader-selection-action button { position: relative; z-index: 1; display: inline-flex; align-items: center; gap: 7px; min-height: 32px; padding: 0 10px; border: 0; border-radius: 8px; color: #526b90; background: #fff; font: inherit; font-size: 12px; white-space: nowrap; cursor: pointer; }
.reader-selection-action button:hover { color: #3969a5; background: #f4f8fd; }
.reader-note-backdrop { position: fixed; z-index: 90; inset: 0; display: grid; place-items: center; padding: 20px; background: rgba(30,42,58,.3); backdrop-filter: blur(3px); }
.reader-note-dialog { width: min(100%, 520px); max-height: min(88vh, 760px); overflow: auto; padding: 22px; border: 1px solid rgba(255,255,255,.75); border-radius: 18px; background: #fff; box-shadow: 0 24px 70px rgba(31,43,61,.22); }
.reader-note-dialog header { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; margin-bottom: 19px; }
.reader-note-dialog header h2 { margin: 7px 0 0; color: #344154; font-size: 18px; font-weight: 620; letter-spacing: -.03em; }
.reader-note-dialog .section-kicker { display: block; max-width: 410px; overflow: hidden; color: #8291a5; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.reader-note-field { display: grid; gap: 7px; margin-top: 14px; color: #58667a; font-size: 12px; }
.reader-note-field > span { display: flex; justify-content: space-between; }
.reader-note-field small { color: #a1a9b4; font-size: 11px; font-weight: 400; }
.reader-note-field input, .reader-note-field textarea { box-sizing: border-box; width: 100%; padding: 10px 12px; border: 1px solid #e6eaf0; border-radius: 9px; outline: 0; color: #465368; background: #fbfcfd; font: inherit; font-size: 12.5px; }
.reader-note-field textarea { min-height: 90px; resize: vertical; line-height: 1.7; }
.reader-note-field input:focus, .reader-note-field textarea:focus { border-color: #a8c3eb; box-shadow: 0 0 0 3px rgba(87,137,211,.12); }
.reader-note-quote { display: grid; gap: 7px; margin-top: 14px; color: #58667a; font-size: 12px; }
.reader-note-quote blockquote { max-height: 190px; overflow: auto; margin: 0; padding: 11px 13px; border-left: 3px solid #b6cbea; border-radius: 0 8px 8px 0; color: #64738a; background: #f5f8fc; font-size: 12.5px; line-height: 1.75; white-space: pre-wrap; overflow-wrap: anywhere; }
.reader-note-privacy { margin: 12px 0 0; color: #929dac; font-size: 11px; line-height: 1.6; }
.reader-note-error { margin: 11px 0 0; color: #b65e59; font-size: 12px; }
.reader-note-dialog footer { display: flex; justify-content: flex-end; gap: 8px; margin-top: 17px; padding-top: 13px; border-top: 1px solid #edf0f3; }
.reader-note-dialog footer .button { min-height: 35px; font-size: 12px; }
.reader-storage-hint { margin: 0 0 15px; padding: 9px 12px; border: 1px solid #e8edf3; border-radius: 9px; color: #788597; background: rgba(246,248,251,.92); font-size: 12px; line-height: 1.6; }
.toc-section { display: grid; gap: 2px; }
.toc-folder { padding: 8px 8px 4px; overflow: hidden; color: #9ca6b4; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.reader-layout--toc-collapsed { grid-template-columns: 0 minmax(0, 1fr); }
.reader-layout--toc-collapsed .reader-toc { display: none; }
.reader-toc-backdrop { display: none; }
.toc-bookmark-mark { flex: 0 0 auto; margin-left: auto; color: #6592d2; fill: #a8c3eb; }
.reader-bookmark-control { position: relative; }
.reader-bookmark-count { position: absolute; top: -3px; right: -3px; min-width: 14px; height: 14px; display: grid; place-items: center; padding: 0 2px; border-radius: 8px; color: #fff; background: #6e98d4; font-size: 10px; line-height: 1; }
.reader-bookmark-panel { position: absolute; z-index: 20; top: calc(100% + 9px); right: 0; width: min(290px, calc(100vw - 30px)); max-height: min(360px, 60vh); overflow: auto; padding: 11px; border: 1px solid #e8ecf0; border-radius: 13px; background: #fff; box-shadow: 0 14px 38px rgba(35,49,68,.16); }
.reader-bookmark-heading { display: flex; justify-content: space-between; padding: 3px 4px 9px; border-bottom: 1px solid #edf0f3; color: #48566b; font-size: 12.5px; }
.reader-bookmark-heading span { color: #a0a9b5; font-size: 12px; }
.reader-bookmark-item { width: 100%; display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 9px 5px; border: 0; border-bottom: 1px solid #f0f2f5; color: #8994a3; background: transparent; text-align: left; cursor: pointer; }
.reader-bookmark-item:hover { color: #5684c7; background: #f8faff; }
.reader-bookmark-item > span { min-width: 0; display: grid; gap: 4px; }
.reader-bookmark-item small { color: #9ba5b2; font-size: 10px; }
.reader-bookmark-item strong { overflow: hidden; color: #536075; font-size: 12px; font-weight: 550; text-overflow: ellipsis; white-space: nowrap; }
.reader-bookmark-empty { margin: 0; padding: 14px 5px 6px; color: #9aa4b1; font-size: 11px; line-height: 1.6; }
.chapter-completion-button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 34px; padding: 0 9px; border: 1px solid #e7ebf0; border-radius: 9px; color: #8a95a4; background: #fff; font: inherit; font-size: 11px; cursor: pointer; }
.chapter-completion-button.is-complete { border-color: #dceadf; color: #5f8a6b; background: #f5faf6; }
.reader-markdown { color: #66717f; font-size: var(--reader-font-size); line-height: 1.9; letter-spacing: .01em; overflow-wrap: anywhere; }
.reader-markdown :deep(mark.reader-highlight-mark) { padding: .04em 0; border-radius: 3px; color: inherit; }
.selection-highlight-swatch { width: 13px; height: 13px; flex: 0 0 13px; border-radius: 4px; background: linear-gradient(120deg, rgba(233, 217, 142, .95), rgba(169, 198, 234, .95)); }
.reader-markdown :deep(img) { max-width: 100%; height: auto; display: block; margin: 18px auto; border-radius: 8px; }
.reader-markdown :deep(.reader-image-missing) { display: inline-block; padding: 7px 10px; border-radius: 7px; color: #9a7b72; background: #f9f1ee; font-size: .8em; }
.reader-markdown :deep(.reader-link-unavailable) { color: #8d96a3; text-decoration: underline dotted; text-underline-offset: 3px; }
.reader-markdown :deep(p) { margin: 0 0 15px; }
.reader-markdown :deep(h2), .reader-markdown :deep(h3), .reader-markdown :deep(h4) { margin: 27px 0 12px; color: #354050; font-weight: 640; letter-spacing: -.03em; line-height: 1.45; }
.reader-markdown :deep(h2) { font-size: calc(var(--reader-font-size) * 1.24); }
.reader-markdown :deep(h3) { font-size: calc(var(--reader-font-size) * 1.12); }
.reader-markdown :deep(h4) { font-size: var(--reader-font-size); }
.reader-markdown :deep(ul), .reader-markdown :deep(ol) { margin: 0 0 17px; padding-left: 1.5em; }
.reader-markdown :deep(li) { padding-left: .25em; }
.reader-markdown :deep(li + li) { margin-top: 5px; }
.reader-markdown :deep(.reader-task-item) { display: flex; align-items: flex-start; gap: .58em; padding-left: 0; list-style: none; }
.reader-markdown :deep(.reader-task-checkbox) { width: 15px; height: 15px; flex: 0 0 15px; margin: .36em 0 0; accent-color: #6f94c9; }
.reader-markdown :deep(blockquote) { margin: 18px 0; padding: 8px 16px; border-left: 3px solid #b5cbea; color: #758196; background: rgba(232, 240, 251, .55); }
.reader-markdown :deep(blockquote p) { margin: 0; }
.reader-markdown :deep(.reader-callout) { display: grid; gap: 6px; margin: 18px 0; padding: 12px 15px; border: 1px solid #dfe8f4; border-left: 3px solid #8eadd9; border-radius: 9px; color: #68778c; background: #f4f7fc; }
.reader-markdown :deep(.reader-callout > strong) { color: #5679aa; font-size: .78em; font-weight: 650; }
.reader-markdown :deep(.reader-callout p) { margin: 0; }
.reader-markdown :deep(.reader-callout--tip) { border-color: #e0ebe1; border-left-color: #83ae8c; background: #f5faf5; }
.reader-markdown :deep(.reader-callout--tip > strong) { color: #5e8966; }
.reader-markdown :deep(.reader-callout--important) { border-color: #e6e1f0; border-left-color: #a596c9; background: #f8f6fb; }
.reader-markdown :deep(.reader-callout--important > strong) { color: #77679f; }
.reader-markdown :deep(.reader-callout--warning), .reader-markdown :deep(.reader-callout--caution) { border-color: #efe5d8; border-left-color: #d0a477; background: #fcf8f2; }
.reader-markdown :deep(.reader-callout--warning > strong), .reader-markdown :deep(.reader-callout--caution > strong) { color: #9f784d; }
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
.reader-page--sepia .reader-markdown :deep(.reader-callout) { background: #f0eadf; }
@media (max-width: 720px) {
  .reader-note-dialog { padding: 18px; border-radius: 15px; }
  .reader-note-backdrop { padding: 12px; }
  .reader-layout--toc-collapsed { grid-template-columns: 1fr; }
  .reader-topbar { position: relative; z-index: 50; }
  .reader-layout:not(.reader-layout--toc-collapsed) .reader-toc { position: fixed; z-index: 41; top: 55px; bottom: 0; left: 0; width: min(300px, 84vw); height: auto; display: flex; border-right: 1px solid #e8ecf0; background: #fff; box-shadow: 8px 0 32px rgba(29,42,60,.13); }
  .reader-toc-backdrop { position: fixed; z-index: 40; inset: 55px 0 0; display: block; border: 0; background: rgba(33,43,56,.22); }
  .reader-chapter-controls { flex-wrap: wrap; justify-content: center; }
  .reader-chapter-controls > span { order: 4; width: 100%; text-align: center; }
  .reader-chapter-controls .button, .chapter-completion-button { min-width: 0; flex: 1; }
  .reader-markdown { font-size: max(14px, var(--reader-font-size)); }
}
</style>
