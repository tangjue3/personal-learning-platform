<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import ePub from 'epubjs'
import Icon from './Icon.vue'
import ReadingNotesPanel from './ReadingNotesPanel.vue'
import { loadEbookBlob } from '../services/ebookFileStore.js'
import { ensureEbookAvailable } from '../services/ebookMigration.js'
import { getLegacyReadingProgress } from '../services/legacyEbookStore.js'
import { getLocalRecord, saveLocalRecord } from '../services/localDataStore.js'

const props = defineProps({
  book: { type: Object, required: true },
  initialAnchor: { type: Object, default: null },
})
const emit = defineEmits(['back', 'progress'])

const isPdf = computed(() => props.book.format === 'pdf')
const formatLabel = computed(() => isPdf.value ? 'PDF 文档' : 'EPUB 电子书')
const readerRoot = ref(null)
const epubMount = ref(null)
const pdfStage = ref(null)
const pdfCanvas = ref(null)
const pdfTextLayer = ref(null)
const tocItems = ref([])
const bookmarks = ref([])
const isTocOpen = ref(false)
const theme = ref('light')
const fontSize = ref(18)
const progress = ref(0)
const chapterTitle = ref('')
const pdfPage = ref(1)
const pdfPageCount = ref(0)
const pdfPageInput = ref('1')
const pdfZoom = ref(1)
const pdfLoading = ref(false)
const busy = ref(true)
const errorMessage = ref('')
const storageError = ref('')
const notePanelOpen = ref(false)
const pdfNoteHighlight = ref(null)
const selectedExcerpt = ref('')
const selectedAnchor = ref(null)
const selectedChapterTitle = ref('')
const selectionAction = ref({ visible: false, top: 0, left: 0 })
const readerState = ref({
  cfi: '', href: '', page: 1, progress: 0, chapterTitle: '',
  bookmarks: [], theme: 'light', fontSize: 18, readDays: [], lastReadAt: '',
})

let epubBook = null
let epubRendition = null
let pdfjsLib = null
let pdfDocument = null
let pdfLoadingTask = null
let pdfRenderTask = null
let pdfTextLayerInstance = null
let resizeObserver = null
let saveTimer = null
let pageRenderToken = 0
let isReady = false
let isDirty = false
let progressRevision = 0
let lastSavedPayload = ''
let currentEpubCfi = ''
let currentEpubHref = ''

const progressStyle = computed(() => ({ width: `${Math.max(0, Math.min(100, progress.value))}%` }))
const readerClass = computed(() => ({
  'ebook-reader--sepia': theme.value === 'sepia',
  'ebook-reader--toc-open': isTocOpen.value,
  'ebook-reader--pdf': isPdf.value,
}))
const currentAnchor = computed(() => isPdf.value ? { page: pdfPage.value } : { cfi: currentEpubCfi, href: currentEpubHref })
const pdfHighlightStyles = computed(() => {
  if (pdfNoteHighlight.value?.page !== pdfPage.value) return []
  return pdfNoteHighlight.value.rects.map((rect) => ({
    left: `${rect.x * 100}%`,
    top: `${rect.y * 100}%`,
    width: `${rect.width * 100}%`,
    height: `${rect.height * 100}%`,
  }))
})
const currentBookmark = computed(() => bookmarks.value.some((item) => isPdf.value
  ? item.anchor?.page === pdfPage.value
  : item.anchor?.cfi === currentEpubCfi))

onMounted(() => {
  window.addEventListener('resize', handleResize)
  void loadBook()
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', handleResize)
  resizeObserver?.disconnect()
  if (saveTimer) window.clearTimeout(saveTimer)
  if (isReady && isDirty) void flushProgress()
  disposeReader()
})

async function loadBook() {
  busy.value = true
  errorMessage.value = ''
  storageError.value = ''
  isReady = false
  isDirty = false
  tocItems.value = []
  bookmarks.value = []
  disposeReader()
  try {
    // 优先读取本机目录中的原文件；只有本机副本缺失时才尝试迁移浏览器旧副本。
    await ensureEbookAvailable(String(props.book.id))
    const blob = await loadEbookBlob(String(props.book.id))

    let saved = getLocalRecord('reader', String(props.book.id))
    if (!saved) {
      const legacy = await getLegacyReadingProgress(String(props.book.id)).catch(() => null)
      const position = legacy?.position
      if (position && typeof position === 'object') {
        saved = { ...position, page: Number(position.page) || 1, cfi: position.cfi || '' }
      } else if (typeof position === 'string') {
        saved = isPdf.value ? { page: Number(position) || 1 } : { cfi: position }
      }
    }
    hydrateState(saved || {})
    isReady = true

    if (isPdf.value) await openPdf(blob)
    else await openEpub(blob)
    if (props.initialAnchor) await restoreInitialAnchor(props.initialAnchor)
    storageError.value = ''
  } catch (error) {
    errorMessage.value = error?.message || `无法打开${formatLabel.value}。`
  } finally {
    busy.value = false
  }
}

function reloadReader() {
  void loadBook()
}

function hydrateState(saved) {
  const validBookmarks = Array.isArray(saved.bookmarks)
    ? saved.bookmarks.filter((item) => item && item.anchor && typeof item.title === 'string')
    : []
  readerState.value = {
    cfi: typeof saved.cfi === 'string' ? saved.cfi : '',
    href: typeof saved.href === 'string' ? saved.href : '',
    page: Math.max(1, Number(saved.page) || 1),
    progress: Math.max(0, Math.min(100, Number(saved.progress) || 0)),
    chapterTitle: typeof saved.chapterTitle === 'string' ? saved.chapterTitle : '',
    bookmarks: validBookmarks,
    theme: saved.theme === 'sepia' ? 'sepia' : 'light',
    fontSize: Math.max(15, Math.min(24, Number(saved.fontSize) || 18)),
    readDays: Array.isArray(saved.readDays) ? saved.readDays.filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(day)) : [],
    lastReadAt: typeof saved.lastReadAt === 'string' ? saved.lastReadAt : '',
  }
  bookmarks.value = [...readerState.value.bookmarks]
  theme.value = readerState.value.theme
  fontSize.value = readerState.value.fontSize
  progress.value = readerState.value.progress
  chapterTitle.value = readerState.value.chapterTitle
  pdfPage.value = readerState.value.page
  pdfPageInput.value = String(pdfPage.value)
  lastSavedPayload = JSON.stringify(readerState.value)
}

function disposeReader() {
  try { pdfRenderTask?.cancel() } catch { /* A completed page has nothing to cancel. */ }
  pdfRenderTask = null
  pdfTextLayerInstance = null
  try { pdfLoadingTask?.destroy() } catch { /* The task may already be closed. */ }
  pdfLoadingTask = null
  try { epubRendition?.destroy() } catch { /* A closed rendition has nothing to destroy. */ }
  epubRendition = null
  try { epubBook?.destroy() } catch { /* A closed book has nothing to destroy. */ }
  epubBook = null
  pdfDocument = null
}

async function openEpub(blob) {
  epubBook = ePub(await blob.arrayBuffer())
  await epubBook.ready
  const navigation = await epubBook.loaded.navigation
  tocItems.value = flattenEpubToc(navigation?.toc || [])
  epubRendition = epubBook.renderTo(epubMount.value, {
    width: '100%', height: '100%', flow: 'paginated', spread: 'none',
    manager: 'default', allowScriptedContent: false,
  })
  epubRendition.themes.register('zhixu-light', { body: { color: '#343941 !important', background: '#fbfaf8 !important' } })
  epubRendition.themes.register('zhixu-sepia', { body: { color: '#51483b !important', background: '#f5efe4 !important' } })
  epubRendition.themes.select(theme.value === 'sepia' ? 'zhixu-sepia' : 'zhixu-light')
  epubRendition.themes.fontSize(`${fontSize.value}px`)
  epubRendition.on('relocated', handleEpubRelocated)
  epubRendition.on('selected', handleEpubSelection)
  await epubRendition.display(readerState.value.cfi || readerState.value.href || undefined)
  epubBook.locations.generate(900).then(() => {
    const location = epubRendition?.currentLocation()
    if (location) handleEpubRelocated(location)
  }).catch(() => { /* Page locations are an enhancement; CFI restore still works. */ })
}

function flattenEpubToc(items, depth = 0) {
  const rows = []
  for (const item of items) {
    if (item?.href) rows.push({ title: String(item.label || item.href), href: item.href, depth })
    rows.push(...flattenEpubToc(item?.subitems || [], depth + 1))
  }
  return rows
}

function handleEpubRelocated(location) {
  const start = location?.start
  if (!start) return
  currentEpubCfi = start.cfi || currentEpubCfi
  currentEpubHref = start.href || currentEpubHref
  const hrefPath = String(start.href || '').split('#')[0]
  const tocMatch = tocItems.value.find((item) => String(item.href).split('#')[0] === hrefPath)
  const spineItems = epubBook?.spine?.spineItems || []
  const spineIndex = spineItems.findIndex((item) => String(item.href).split('#')[0] === hrefPath)
  const displayed = start.displayed || {}
  const withinSpineProgress = displayed.total ? (Number(displayed.page || 1) - 1) / displayed.total : 0
  const generatedProgress = currentEpubCfi && epubBook?.locations?.length
    ? epubBook.locations.percentageFromCfi(currentEpubCfi)
    : null
  const nextProgress = Number.isFinite(generatedProgress)
    ? Math.round(generatedProgress * 100)
    : spineItems.length && spineIndex >= 0
      ? Math.round(((spineIndex + withinSpineProgress) / spineItems.length) * 100)
      : progress.value
  const title = tocMatch?.title || start.href || props.book.title
  chapterTitle.value = title
  progress.value = Math.max(0, Math.min(100, nextProgress))
  scheduleProgress({ cfi: currentEpubCfi, href: currentEpubHref, progress: progress.value, chapterTitle: title })
}

function handleEpubSelection(cfiRange, contents) {
  const selection = contents?.window?.getSelection?.()
  const quote = selection?.toString().replace(/\s+/g, ' ').trim() || ''
  if (!quote) {
    selectionAction.value.visible = false
    selectedExcerpt.value = ''
    selectedAnchor.value = null
    return
  }
  selectedExcerpt.value = quote.slice(0, 3000)
  selectedAnchor.value = { cfi: cfiRange || currentEpubCfi, href: currentEpubHref }
  selectedChapterTitle.value = chapterTitle.value || props.book.title
  const range = selection.rangeCount ? selection.getRangeAt(0).getBoundingClientRect() : null
  const frameRect = contents?.window?.frameElement?.getBoundingClientRect?.()
  if (range && frameRect) {
    showSelectionAction({ top: frameRect.top + range.top, left: frameRect.left + range.left, width: range.width })
  } else selectionAction.value.visible = true
}

async function openPdf(blob) {
  const [pdfModule, workerModule] = await Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
    import('pdfjs-dist/web/pdf_viewer.css'),
  ])
  pdfjsLib = pdfModule
  pdfjsLib.GlobalWorkerOptions.workerSrc = workerModule.default
  pdfLoadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(await blob.arrayBuffer()),
    isEvalSupported: false,
    enableXfa: false,
  })
  pdfDocument = await pdfLoadingTask.promise
  pdfPageCount.value = pdfDocument.numPages
  pdfPage.value = Math.min(pdfPageCount.value || 1, Math.max(1, readerState.value.page))
  pdfPageInput.value = String(pdfPage.value)
  const outline = await pdfDocument.getOutline().catch(() => null)
  tocItems.value = await flattenPdfOutline(outline || [])
  await renderPdfPage()
  if (pdfStage.value && typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => { void renderPdfPage() })
    resizeObserver.observe(pdfStage.value)
  }
  updatePdfProgress()
}

async function flattenPdfOutline(items, depth = 0) {
  const rows = []
  for (const item of items) {
    let page = 1
    try {
      const destination = await pdfDocument.getDestination(item.dest)
      if (Array.isArray(destination) && destination[0]) page = (await pdfDocument.getPageIndex(destination[0])) + 1
    } catch { /* Unsupported destinations can still be shown as labels. */ }
    rows.push({ title: String(item.title || `第 ${page} 页`), page, depth })
    rows.push(...await flattenPdfOutline(item.items || [], depth + 1))
  }
  return rows
}

async function restoreInitialAnchor(anchor) {
  if (isPdf.value && Number(anchor.page)) {
    await applyPdfAnchor(anchor)
    return
  }
  const location = anchor.cfi || anchor.href
  if (location && epubRendition) await epubRendition.display(location)
}

async function renderPdfPage() {
  if (!pdfDocument || !pdfCanvas.value || !pdfTextLayer.value) return
  const token = ++pageRenderToken
  try { pdfRenderTask?.cancel() } catch { /* The previous page may already be complete. */ }
  pdfRenderTask = null
  pdfLoading.value = true
  try {
    const page = await pdfDocument.getPage(pdfPage.value)
    if (token !== pageRenderToken) return
    const baseViewport = page.getViewport({ scale: 1 })
    const availableWidth = Math.max(280, (pdfStage.value?.clientWidth || 800) - 36)
    const scale = Math.max(0.5, Math.min(2.4, Math.min(availableWidth / baseViewport.width, 1.45) * pdfZoom.value))
    const viewport = page.getViewport({ scale })
    const outputScale = Math.max(1, window.devicePixelRatio || 1)
    const canvas = pdfCanvas.value
    const context = canvas.getContext('2d', { alpha: false })
    canvas.width = Math.ceil(viewport.width * outputScale)
    canvas.height = Math.ceil(viewport.height * outputScale)
    canvas.style.width = `${viewport.width}px`
    canvas.style.height = `${viewport.height}px`
    pdfTextLayer.value.replaceChildren()
    pdfTextLayer.value.style.width = `${viewport.width}px`
    pdfTextLayer.value.style.height = `${viewport.height}px`
    pdfTextLayerInstance = new pdfjsLib.TextLayer({
      textContentSource: await page.getTextContent(),
      container: pdfTextLayer.value,
      viewport,
    })
    const textRender = pdfTextLayerInstance.render()
    pdfRenderTask = page.render({
      canvasContext: context,
      viewport,
      transform: outputScale === 1 ? null : [outputScale, 0, 0, outputScale, 0, 0],
    })
    await Promise.all([pdfRenderTask.promise, textRender])
  } catch (error) {
    if (error?.name !== 'RenderingCancelledException' && token === pageRenderToken) {
      errorMessage.value = error?.message || '无法渲染 PDF 页面。'
    }
  } finally {
    if (token === pageRenderToken) pdfLoading.value = false
  }
}

function handleResize() {
  if (isPdf.value) void renderPdfPage()
  else epubRendition?.resize()
}

function updatePdfProgress() {
  if (!pdfPageCount.value) return
  const percentage = Math.round((pdfPage.value / pdfPageCount.value) * 100)
  progress.value = percentage
  chapterTitle.value = `第 ${pdfPage.value} 页`
  pdfPageInput.value = String(pdfPage.value)
  scheduleProgress({ page: pdfPage.value, progress: percentage, chapterTitle: chapterTitle.value, pageCount: pdfPageCount.value })
}

async function goToPdfPage(pageNumber) {
  const nextPage = Math.max(1, Math.min(pdfPageCount.value || 1, Number(pageNumber) || 1))
  if (nextPage === pdfPage.value && !pdfLoading.value) return
  pdfPage.value = nextPage
  pdfNoteHighlight.value = null
  selectionAction.value.visible = false
  await renderPdfPage()
  updatePdfProgress()
  readerRoot.value?.scrollTo({ top: 0, behavior: 'smooth' })
}

async function applyPdfAnchor(anchor) {
  const page = Math.max(1, Math.min(pdfPageCount.value || 1, Number(anchor.page) || 1))
  await goToPdfPage(page)
  const rects = normalizePdfRectangles(anchor.rects)
  if (!rects.length) return

  pdfNoteHighlight.value = { page, rects }
  await nextTick()
  window.requestAnimationFrame(() => {
    readerRoot.value?.querySelector('.pdf-note-highlight')?.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' })
  })
}

function normalizePdfRectangles(rectangles) {
  if (!Array.isArray(rectangles)) return []
  return rectangles.slice(0, 80).map((rect) => {
    if (!rect || typeof rect !== 'object') return null
    const values = ['x', 'y', 'width', 'height'].map((key) => Number(rect[key]))
    if (!values.every(Number.isFinite)) return null
    const [rawX, rawY, rawWidth, rawHeight] = values
    if (rawWidth <= 0 || rawHeight <= 0) return null
    const clamp = (value) => Math.max(0, Math.min(1, value))
    const x = clamp(rawX)
    const y = clamp(rawY)
    const width = clamp(rawX + rawWidth) - x
    const height = clamp(rawY + rawHeight) - y
    if (width < 0.001 || height < 0.001) return null
    return { x, y, width, height }
  }).filter(Boolean)
}

function handlePdfSelection() {
  const selection = window.getSelection()
  const quote = selection?.toString().replace(/\s+/g, ' ').trim() || ''
  const selectedNode = selection?.anchorNode
  if (!quote || !selectedNode || !pdfTextLayer.value?.contains(selectedNode.nodeType === 1 ? selectedNode : selectedNode.parentElement)) {
    selectionAction.value.visible = false
    selectedExcerpt.value = ''
    selectedAnchor.value = null
    return
  }
  selectedExcerpt.value = quote.slice(0, 3000)
  const pageRect = pdfCanvas.value?.getBoundingClientRect()
  const selectionRects = selection.rangeCount ? [...selection.getRangeAt(0).getClientRects()] : []
  const rects = pageRect?.width && pageRect?.height
    ? selectionRects.map((rect) => ({
      x: (rect.left - pageRect.left) / pageRect.width,
      y: (rect.top - pageRect.top) / pageRect.height,
      width: rect.width / pageRect.width,
      height: rect.height / pageRect.height,
    })).filter((rect) => rect.width > 0.001 && rect.height > 0.001).slice(0, 80)
    : []
  selectedAnchor.value = { page: pdfPage.value, rects: normalizePdfRectangles(rects) }
  selectedChapterTitle.value = `第 ${pdfPage.value} 页`
  const rect = selection.rangeCount ? selection.getRangeAt(0).getBoundingClientRect() : null
  if (rect) showSelectionAction({ top: rect.top, left: rect.left, width: rect.width })
}

function showSelectionAction(rect) {
  const left = Math.max(12, Math.min(window.innerWidth - 170, rect.left + Math.min(rect.width / 2, 100)))
  const top = Math.max(68, Math.min(window.innerHeight - 56, rect.top - 42))
  selectionAction.value = { visible: true, top, left }
}

function scheduleProgress(patch) {
  progressRevision += 1
  const today = localDateKey()
  readerState.value = {
    ...readerState.value,
    ...patch,
    bookmarks: [...bookmarks.value],
    theme: theme.value,
    fontSize: fontSize.value,
    lastReadAt: new Date().toISOString(),
    readDays: [...new Set([...(readerState.value.readDays || []), today])].slice(-180),
  }
  progress.value = Math.max(0, Math.min(100, Number(readerState.value.progress) || 0))
  chapterTitle.value = readerState.value.chapterTitle || chapterTitle.value
  emit('progress', { bookId: props.book.id, progress: progress.value, chapterTitle: chapterTitle.value })
  isDirty = true
  if (!isReady) return
  if (saveTimer) window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => { void flushProgress() }, 650)
}

function localDateKey() {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

async function flushProgress() {
  if (saveTimer) window.clearTimeout(saveTimer)
  saveTimer = null
  if (!isReady || !isDirty) return
  const payload = {
    ...readerState.value,
    format: props.book.format,
    pageCount: isPdf.value ? pdfPageCount.value : undefined,
    chapterCount: isPdf.value ? undefined : tocItems.value.length,
    bookmarks: [...bookmarks.value],
  }
  const savingRevision = progressRevision
  const serialized = JSON.stringify(payload)
  if (serialized === lastSavedPayload) { isDirty = false; return }
  try {
    await saveLocalRecord('reader', String(props.book.id), payload)
    lastSavedPayload = serialized
    isDirty = progressRevision !== savingRevision
    storageError.value = ''
  } catch (error) {
    storageError.value = error?.message || '阅读进度未能保存到本机。'
  }
}

function jumpToToc(item) {
  if (isPdf.value) goToPdfPage(item.page)
  else if (item.href) void epubRendition?.display(item.href)
  if (window.matchMedia('(max-width: 760px)').matches) isTocOpen.value = false
}

async function jumpToAnchor(anchor) {
  if (!anchor) return
  if (isPdf.value && Number(anchor.page)) await applyPdfAnchor(anchor)
  else if (anchor.cfi) void epubRendition?.display(anchor.cfi)
  else if (anchor.href) void epubRendition?.display(anchor.href)
}

function openNotes() {
  selectedExcerpt.value = ''
  selectedAnchor.value = currentAnchor.value
  selectedChapterTitle.value = chapterTitle.value || props.book.title
  selectionAction.value.visible = false
  notePanelOpen.value = true
}

function openSelectedNote() {
  notePanelOpen.value = true
  selectionAction.value.visible = false
}

function toggleBookmark() {
  const anchor = currentAnchor.value
  if (currentBookmark.value) {
    bookmarks.value = bookmarks.value.filter((item) => isPdf.value
      ? item.anchor?.page !== pdfPage.value
      : item.anchor?.cfi !== currentEpubCfi)
  } else {
    bookmarks.value = [...bookmarks.value, {
      id: globalThis.crypto?.randomUUID?.() || `bookmark-${Date.now()}`,
      anchor,
      title: chapterTitle.value || props.book.title,
      createdAt: new Date().toISOString(),
    }]
  }
  readerState.value.bookmarks = [...bookmarks.value]
  scheduleProgress({ bookmarks: [...bookmarks.value] })
}

function changeFontSize(amount) {
  fontSize.value = Math.max(15, Math.min(24, fontSize.value + amount))
  epubRendition?.themes.fontSize(`${fontSize.value}px`)
  scheduleProgress({ fontSize: fontSize.value })
}

function toggleTheme() {
  theme.value = theme.value === 'light' ? 'sepia' : 'light'
  if (epubRendition) epubRendition.themes.select(theme.value === 'sepia' ? 'zhixu-sepia' : 'zhixu-light')
  scheduleProgress({ theme: theme.value })
}

function backToShelf() {
  if (isDirty) void flushProgress()
  emit('back')
}

function setZoom(amount) {
  pdfZoom.value = Math.max(0.7, Math.min(1.8, Number((pdfZoom.value + amount).toFixed(2))))
  void renderPdfPage()
}
</script>

<template>
  <main ref="readerRoot" class="ebook-reader" :class="readerClass">
    <header class="ebook-reader-topbar">
      <button class="ebook-back" type="button" @click="backToShelf"><Icon name="arrowLeft" size="17" /><span>返回书架</span></button>
      <div class="ebook-titlebar">
        <strong :title="book.title">{{ book.title }}</strong><span>{{ formatLabel }}</span>
        <div class="ebook-progress-track" role="progressbar" :aria-valuenow="progress" aria-valuemin="0" aria-valuemax="100" :aria-label="`阅读进度 ${progress}%`"><i :style="progressStyle"></i></div>
        <small>{{ progress }}%</small>
      </div>
      <div class="ebook-toolbar" role="toolbar" aria-label="阅读工具">
        <button class="ebook-tool ebook-toc-toggle" type="button" :aria-expanded="isTocOpen" aria-label="目录和书签" title="目录和书签" @click="isTocOpen = !isTocOpen"><Icon name="list" size="17" /></button>
        <template v-if="isPdf">
          <div class="ebook-page-jump"><button class="ebook-tool" type="button" aria-label="上一页" :disabled="pdfPage <= 1" @click="goToPdfPage(pdfPage - 1)">‹</button><form @submit.prevent="goToPdfPage(pdfPageInput)"><input v-model="pdfPageInput" aria-label="页码" inputmode="numeric" @change="goToPdfPage(pdfPageInput)" /><span>/ {{ pdfPageCount || '—' }}</span></form><button class="ebook-tool" type="button" aria-label="下一页" :disabled="pdfPage >= pdfPageCount" @click="goToPdfPage(pdfPage + 1)">›</button></div>
          <button class="ebook-tool ebook-zoom" type="button" aria-label="缩小页面" title="缩小" @click="setZoom(-0.15)">−</button><span class="ebook-zoom-label">{{ Math.round(pdfZoom * 100) }}%</span><button class="ebook-tool ebook-zoom" type="button" aria-label="放大页面" title="放大" @click="setZoom(0.15)">+</button>
        </template>
        <template v-else>
          <button class="ebook-tool ebook-font-small" type="button" aria-label="减小字号" title="减小字号" @click="changeFontSize(-1)">A−</button><button class="ebook-tool ebook-font-large" type="button" aria-label="增大字号" title="增大字号" @click="changeFontSize(1)">A+</button>
        </template>
        <button class="ebook-tool" type="button" :aria-pressed="theme === 'sepia'" :aria-label="theme === 'sepia' ? '切换到浅色主题' : '切换到护眼主题'" title="切换阅读背景" @click="toggleTheme"><Icon :name="theme === 'sepia' ? 'sun' : 'moon'" size="17" /></button>
        <button class="ebook-tool" type="button" :aria-pressed="currentBookmark" :aria-label="currentBookmark ? '取消书签' : '添加书签'" title="书签" @click="toggleBookmark"><Icon name="bookmark" size="17" /></button>
        <button class="ebook-note-button" type="button" @click="openNotes"><Icon name="notes" size="16" /><span>笔记</span></button>
      </div>
    </header>

    <div v-if="isTocOpen" class="ebook-toc-scrim" aria-hidden="true" @click="isTocOpen = false"></div>
    <div class="ebook-reader-layout">
      <aside class="ebook-toc" aria-label="书籍目录和书签">
        <div class="ebook-toc-heading"><div><span>阅读导航</span><strong>{{ isPdf ? '文档目录' : '本书目录' }}</strong></div><button class="ebook-toc-close" type="button" aria-label="关闭目录" @click="isTocOpen = false"><Icon name="close" size="16" /></button></div>
        <div class="ebook-toc-caption">{{ isPdf ? '目录' : '章节' }} <span>{{ tocItems.length }}</span></div>
        <nav v-if="tocItems.length" class="ebook-toc-list" aria-label="章节列表">
          <button v-for="(item, index) in tocItems" :key="`${item.href || item.page}-${index}`" type="button" :style="{ paddingLeft: `${12 + item.depth * 14}px` }" :title="item.title" @click="jumpToToc(item)"><span>{{ isPdf ? item.page : String(index + 1).padStart(2, '0') }}</span><strong>{{ item.title }}</strong></button>
        </nav>
        <p v-else class="ebook-toc-empty">{{ busy ? '正在读取目录…' : isPdf ? '这份 PDF 没有内置目录，可以用上方页码翻阅。' : '这本 EPUB 没有可用目录。' }}</p>
        <div class="ebook-toc-caption ebook-bookmarks-caption">书签 <span>{{ bookmarks.length }}</span></div>
        <div v-if="bookmarks.length" class="ebook-bookmark-list"><button v-for="bookmark in bookmarks" :key="bookmark.id" type="button" @click="jumpToAnchor(bookmark.anchor)"><Icon name="bookmark" size="13" /><span>{{ bookmark.title }}</span></button></div>
        <p v-else class="ebook-bookmark-empty">阅读时点按书签图标，可以保存当前位置。</p>
        <div class="ebook-local-note"><span class="ebook-local-dot"></span>原文件在 data/local/ebooks/，进度和笔记在本机记录中</div>
      </aside>

      <section class="ebook-reading-area" :aria-label="`${book.title} 阅读内容`">
        <div v-if="errorMessage" class="ebook-reader-error" role="alert"><Icon name="notes" size="20" /><strong>暂时无法打开这本书</strong><p>{{ errorMessage }}</p><button type="button" class="ebook-note-button" @click="reloadReader">重试</button><button type="button" class="ebook-note-button" @click="backToShelf">返回书架</button></div>
        <div v-else-if="busy" class="ebook-reader-loading" role="status"><span class="ebook-loading-spinner"></span><strong>正在准备阅读内容</strong><p>首次打开较大的文件可能需要一点时间。</p></div>        <template v-else-if="isPdf">
          <div class="ebook-content-heading"><div><span>{{ formatLabel }}</span><h1>{{ chapterTitle || book.title }}</h1></div><span v-if="pdfLoading" class="ebook-page-status">正在排版…</span><span v-else class="ebook-page-status">第 {{ pdfPage }} / {{ pdfPageCount }} 页</span></div>
          <div ref="pdfStage" class="ebook-pdf-stage" @mouseup="handlePdfSelection">
            <div class="ebook-pdf-page-frame" :class="{ 'is-rendering': pdfLoading }"><canvas ref="pdfCanvas" aria-label="PDF 页面图像"></canvas><div ref="pdfTextLayer" class="textLayer"></div><div v-if="pdfHighlightStyles.length" class="pdf-note-highlight-layer" aria-hidden="true"><span v-for="(style, index) in pdfHighlightStyles" :key="index" class="pdf-note-highlight" :class="{ 'pdf-note-highlight--first': index === 0 }" :style="style"></span></div></div>
          </div>
          <div class="ebook-pdf-bottom"><button class="ebook-page-button" type="button" :disabled="pdfPage <= 1" @click="goToPdfPage(pdfPage - 1)"><Icon name="arrowLeft" size="15" />上一页</button><span>{{ pdfPage }} / {{ pdfPageCount }}</span><button class="ebook-page-button" type="button" :disabled="pdfPage >= pdfPageCount" @click="goToPdfPage(pdfPage + 1)">下一页<Icon name="arrowRight" size="15" /></button></div>
        </template>
        <template v-else>
          <div class="ebook-content-heading ebook-epub-heading"><div><span>{{ formatLabel }}<template v-if="chapterTitle"> · {{ chapterTitle }}</template></span><h1>{{ book.title }}</h1></div><span>{{ progress }}%</span></div>
          <div ref="epubMount" class="ebook-epub-stage" aria-label="EPUB 页面"></div>
          <div class="ebook-epub-bottom"><button class="ebook-page-button" type="button" @click="epubRendition?.prev()"><Icon name="arrowLeft" size="15" />上一页</button><span>进度自动保存在本机</span><button class="ebook-page-button" type="button" @click="epubRendition?.next()">下一页<Icon name="arrowRight" size="15" /></button></div>
        </template>
        <p v-if="storageError" class="ebook-storage-error" role="status">{{ storageError }}</p>
      </section>
    </div>

    <button v-if="selectionAction.visible" class="ebook-selection-action" type="button" :style="{ top: `${selectionAction.top}px`, left: `${selectionAction.left}px` }" @mousedown.prevent @click="openSelectedNote"><Icon name="notes" size="14" />记下这段</button>
    <ReadingNotesPanel :open="notePanelOpen" :book="book" :anchor="selectedAnchor || currentAnchor" :excerpt="selectedExcerpt" :chapter-title="selectedChapterTitle || chapterTitle" @close="notePanelOpen = false" @jump="jumpToAnchor" />
  </main>
</template>

<style scoped>
.ebook-reader { --ebook-ink: #303640; --ebook-muted: #8b929e; --ebook-line: #e9ebee; --ebook-paper: #fbfaf8; min-height: 100vh; color: var(--ebook-ink); background: #f7f7f6; }
.ebook-reader--sepia { --ebook-paper: #f5f0e7; background: #f5f0e7; }
.ebook-reader-topbar { position: sticky; z-index: 10; top: 0; display: grid; min-height: 64px; grid-template-columns: minmax(100px, 1fr) minmax(240px, 1.1fr) minmax(330px, 1.7fr); align-items: center; gap: 18px; padding: 0 24px; border-bottom: 1px solid var(--ebook-line); background: color-mix(in srgb, var(--ebook-paper) 91%, white 9%); backdrop-filter: blur(16px); }
.ebook-back { display: inline-flex; width: max-content; align-items: center; gap: 7px; padding: 8px 9px; border: 0; border-radius: 8px; color: #7b8491; background: transparent; font: inherit; font-size: 12px; cursor: pointer; }
.ebook-back:hover, .ebook-tool:hover { color: #4d7fca; background: #eef3fb; }
.ebook-titlebar { min-width: 0; display: grid; grid-template-columns: minmax(70px, auto) auto minmax(50px, 110px) 32px; align-items: center; justify-content: center; gap: 9px; }
.ebook-titlebar > strong { overflow: hidden; color: #4c5562; font-size: 12px; font-weight: 630; text-overflow: ellipsis; white-space: nowrap; }
.ebook-titlebar > span, .ebook-titlebar > small { color: #9ba2ac; font-size: 10px; white-space: nowrap; }
.ebook-progress-track { height: 4px; overflow: hidden; border-radius: 8px; background: #e8ebef; }
.ebook-progress-track i { display: block; height: 100%; border-radius: inherit; background: #6d9be0; transition: width .24s ease; }
.ebook-toolbar { display: flex; align-items: center; justify-content: flex-end; gap: 4px; }
.ebook-tool { display: inline-grid; width: 34px; height: 34px; flex: 0 0 34px; place-items: center; border: 0; border-radius: 9px; color: #788290; background: transparent; cursor: pointer; }
.ebook-tool:disabled { cursor: default; opacity: .35; }
.ebook-tool[aria-pressed="true"] { color: #5888ce; background: #e9f1fc; }
.ebook-font-small { font-family: Georgia, serif; font-size: 12px; }.ebook-font-large { font-family: Georgia, serif; font-size: 15px; }
.ebook-note-button { display: inline-flex; min-height: 34px; align-items: center; justify-content: center; gap: 7px; margin-left: 4px; padding: 0 12px; border: 1px solid #e4e7eb; border-radius: 9px; color: #566171; background: #fff; font: inherit; font-size: 11px; font-weight: 600; cursor: pointer; }
.ebook-note-button:hover { border-color: #cfdaea; color: #4a7bc4; background: #f6f9fe; }
.ebook-page-jump { display: flex; align-items: center; gap: 1px; padding: 0 3px; border: 1px solid #eceef1; border-radius: 9px; background: #fff; }
.ebook-page-jump form { display: flex; align-items: center; gap: 4px; color: #9ca3ac; font-size: 10px; }
.ebook-page-jump input { width: 32px; padding: 4px 0; border: 0; color: #515b69; background: transparent; font: inherit; font-size: 11px; text-align: center; outline: 0; }
.ebook-page-jump .ebook-tool { width: 27px; height: 29px; flex-basis: 27px; font-size: 19px; }
.ebook-zoom-label { min-width: 33px; color: #8d95a0; font-size: 9px; text-align: center; }
.ebook-toc-scrim { display: none; }
.ebook-reader-layout { min-height: calc(100vh - 64px); display: grid; grid-template-columns: 248px minmax(0, 1fr); }
.ebook-toc { position: sticky; top: 64px; display: flex; height: calc(100vh - 64px); min-height: 410px; flex-direction: column; padding: 24px 15px 16px 18px; overflow: auto; border-right: 1px solid var(--ebook-line); background: color-mix(in srgb, var(--ebook-paper) 86%, white 14%); }
.ebook-toc-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 0 6px 19px; }
.ebook-toc-heading > div { display: grid; gap: 5px; }.ebook-toc-heading span { color: #a2a8b1; font-size: 10px; }.ebook-toc-heading strong { color: #515b68; font-size: 15px; font-weight: 650; }
.ebook-toc-close { display: none; width: 30px; height: 30px; place-items: center; border: 0; border-radius: 8px; color: #8b929d; background: transparent; cursor: pointer; }
.ebook-toc-caption { display: flex; align-items: center; justify-content: space-between; padding: 11px 7px 8px; border-top: 1px solid var(--ebook-line); color: #89919d; font-size: 10px; font-weight: 620; }
.ebook-toc-caption span { color: #a2a8b1; font-weight: 500; }
.ebook-toc-list { display: grid; gap: 2px; padding: 3px 0 15px; }
.ebook-toc-list button { display: flex; min-height: 34px; align-items: center; gap: 9px; padding: 0 9px; overflow: hidden; border: 0; border-radius: 7px; color: #838c99; background: transparent; text-align: left; cursor: pointer; }
.ebook-toc-list button:hover { color: #557eb8; background: #eef3fa; }
.ebook-toc-list button > span { min-width: 20px; color: #a9afb8; font-size: 9px; font-variant-numeric: tabular-nums; }
.ebook-toc-list button strong { overflow: hidden; font-size: 10px; font-weight: 520; text-overflow: ellipsis; white-space: nowrap; }
.ebook-toc-empty, .ebook-bookmark-empty { margin: 0; padding: 8px 7px 15px; color: #a3a9b1; font-size: 10px; line-height: 1.7; }
.ebook-bookmarks-caption { margin-top: 1px; }
.ebook-bookmark-list { display: grid; gap: 2px; padding: 4px 0 14px; }
.ebook-bookmark-list button { display: flex; min-height: 31px; align-items: center; gap: 8px; padding: 0 7px; overflow: hidden; border: 0; border-radius: 7px; color: #8490a0; background: transparent; text-align: left; cursor: pointer; }
.ebook-bookmark-list button:hover { background: #f0f3f8; }.ebook-bookmark-list button > span { overflow: hidden; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.ebook-local-note { display: flex; align-items: center; gap: 7px; margin-top: auto; padding: 14px 7px 0; border-top: 1px solid var(--ebook-line); color: #a0a6ae; font-size: 9px; }
.ebook-local-dot { width: 6px; height: 6px; border-radius: 50%; background: #8fb59d; }
.ebook-reading-area { min-width: 0; padding: 25px clamp(18px, 4vw, 64px) 34px; }
.ebook-content-heading { display: flex; max-width: 980px; align-items: flex-end; justify-content: space-between; gap: 15px; margin: 2px auto 16px; }
.ebook-content-heading > div { min-width: 0; }.ebook-content-heading > div > span { color: #9aa2ad; font-size: 10px; }
.ebook-content-heading h1 { margin: 5px 0 0; overflow: hidden; color: #3e4857; font-size: 18px; font-weight: 630; letter-spacing: -.025em; text-overflow: ellipsis; white-space: nowrap; }
.ebook-page-status, .ebook-epub-heading > span { color: #9ba2ad; font-size: 10px; white-space: nowrap; }
.ebook-pdf-stage { display: flex; min-height: 360px; justify-content: center; padding: 18px; overflow: auto; border: 1px solid #eceef0; border-radius: 15px; background: #eceff2; }
.ebook-pdf-page-frame { position: relative; width: max-content; height: max-content; flex: 0 0 auto; overflow: hidden; background: white; box-shadow: 0 3px 18px rgb(39 47 58 / 13%); transition: opacity .16s ease; }
.ebook-pdf-page-frame.is-rendering { opacity: .72; }.ebook-pdf-page-frame canvas { display: block; }
.pdf-note-highlight-layer { position: absolute; z-index: 2; inset: 0; pointer-events: none; }
.pdf-note-highlight { position: absolute; border-radius: 2px; background: rgb(242 204 92 / 34%); box-shadow: 0 0 0 1px rgb(190 145 39 / 12%); }
.pdf-note-highlight--first { background: rgb(242 204 92 / 48%); box-shadow: 0 0 0 1px rgb(190 145 39 / 28%); }
.ebook-pdf-page-frame :deep(.textLayer) { position: absolute; inset: 0; overflow: hidden; line-height: 1; text-align: initial; opacity: 1; forced-color-adjust: none; transform-origin: 0 0; }
.ebook-pdf-page-frame :deep(.textLayer span), .ebook-pdf-page-frame :deep(.textLayer br) { position: absolute; color: transparent; white-space: pre; transform-origin: 0 0; cursor: text; }
.ebook-pdf-page-frame :deep(.textLayer ::selection) { color: transparent; background: rgb(105 153 225 / 35%); }
.ebook-pdf-bottom, .ebook-epub-bottom { display: flex; max-width: 980px; align-items: center; justify-content: space-between; gap: 12px; margin: 13px auto 0; color: #9da4ad; font-size: 10px; }
.ebook-page-button { display: inline-flex; min-height: 32px; align-items: center; gap: 7px; padding: 0 10px; border: 1px solid #e5e8ec; border-radius: 8px; color: #778190; background: #fff; font: inherit; font-size: 10px; cursor: pointer; }
.ebook-page-button:hover:not(:disabled) { color: #4e7fc8; border-color: #d7e1ef; }.ebook-page-button:disabled { cursor: default; opacity: .42; }
.ebook-epub-stage { width: min(100%, 940px); height: min(76vh, 900px); min-height: 480px; margin: 0 auto; overflow: hidden; border: 1px solid #eceef0; border-radius: 15px; background: var(--ebook-paper); box-shadow: 0 7px 28px rgb(38 45 54 / 5%); }
.ebook-reader--sepia .ebook-epub-stage { border-color: #e8dfcf; }
.ebook-reader-loading, .ebook-reader-error { display: grid; min-height: 50vh; align-content: center; justify-items: center; gap: 10px; color: #828b98; text-align: center; }
.ebook-reader-loading strong, .ebook-reader-error strong { color: #596574; font-size: 14px; }.ebook-reader-loading p, .ebook-reader-error p { max-width: 480px; margin: 0; color: #9aa1aa; font-size: 11px; line-height: 1.7; }
.ebook-reader-error .ebook-note-button { margin-top: 5px; }.ebook-loading-spinner { width: 24px; height: 24px; border: 2px solid #e5e9ef; border-top-color: #6f9ada; border-radius: 50%; animation: ebook-spin .8s linear infinite; }
.ebook-storage-error { max-width: 980px; margin: 12px auto 0; color: #b36b45; font-size: 10px; text-align: center; }
.ebook-selection-action { position: fixed; z-index: 30; display: inline-flex; height: 34px; align-items: center; gap: 7px; padding: 0 11px; border: 1px solid #dbe3ef; border-radius: 9px; color: #4d6f9f; background: #fff; box-shadow: 0 5px 18px rgb(32 44 61 / 13%); font: inherit; font-size: 11px; font-weight: 600; cursor: pointer; }
.ebook-selection-action:hover { color: #396eb9; background: #f4f8fe; }
.ebook-reader button:focus-visible { outline: 3px solid rgb(77 128 202 / 34%); outline-offset: 2px; }
@keyframes ebook-spin { to { transform: rotate(360deg); } }
@media (max-width: 1060px) { .ebook-reader-topbar { grid-template-columns: 110px minmax(200px, .8fr) minmax(330px, 1.6fr); gap: 9px; padding: 0 14px; }.ebook-reader-layout { grid-template-columns: 220px minmax(0, 1fr); }.ebook-reading-area { padding-right: 26px; padding-left: 26px; }.ebook-toc { padding-right: 12px; padding-left: 13px; } }
@media (max-width: 760px) {
  .ebook-reader-topbar { min-height: 56px; grid-template-columns: auto minmax(0, 1fr) auto; gap: 5px; padding: 0 8px; }
  .ebook-back { gap: 2px; padding: 7px 5px; }.ebook-back span { display: none; }
  .ebook-titlebar { grid-template-columns: minmax(50px, auto) auto; justify-content: start; gap: 5px 7px; }.ebook-titlebar > strong { max-width: 35vw; font-size: 10px; }.ebook-titlebar > span { font-size: 8px; }.ebook-titlebar > small, .ebook-titlebar .ebook-progress-track { display: none; }
  .ebook-toolbar { gap: 0; }.ebook-tool { width: 30px; height: 31px; flex-basis: 30px; }.ebook-note-button { width: 33px; min-height: 31px; gap: 0; padding: 0; font-size: 0; }.ebook-note-button svg { flex: 0 0 16px; }
  .ebook-page-jump { gap: 0; }.ebook-page-jump .ebook-tool { width: 22px; flex-basis: 22px; }.ebook-page-jump input { width: 27px; font-size: 10px; }.ebook-page-jump form { gap: 2px; font-size: 8px; }.ebook-zoom { display: none; }.ebook-zoom-label { display: none; }
  .ebook-reader-layout { display: block; min-height: calc(100vh - 56px); }
  .ebook-toc { position: fixed; z-index: 22; top: 56px; bottom: 0; left: 0; width: min(84vw, 310px); height: auto; min-height: 0; transform: translateX(-102%); box-shadow: 12px 0 40px rgb(29 35 44 / 14%); transition: transform .2s ease; }
  .ebook-reader--toc-open .ebook-toc { transform: translateX(0); }.ebook-toc-close { display: grid; }.ebook-toc-scrim { position: fixed; z-index: 21; inset: 56px 0 0; display: block; background: rgb(25 31 39 / 24%); }
  .ebook-reading-area { padding: 17px 12px 26px; }.ebook-content-heading { margin: 2px 3px 12px; }.ebook-content-heading h1 { font-size: 15px; }.ebook-content-heading > div > span, .ebook-page-status, .ebook-epub-heading > span { font-size: 9px; }
  .ebook-pdf-stage { min-height: 280px; padding: 8px; border-radius: 11px; }.ebook-epub-stage { height: calc(100dvh - 154px); min-height: 400px; border-radius: 11px; }.ebook-pdf-bottom, .ebook-epub-bottom { margin-top: 10px; }
}
@media (max-width: 420px) { .ebook-titlebar > strong { max-width: 27vw; }.ebook-toolbar { gap: 0; }.ebook-toolbar > .ebook-tool:nth-child(2) { display: none; }.ebook-page-jump input { width: 23px; }.ebook-content-heading h1 { max-width: 64vw; } }
@media (prefers-reduced-motion: reduce) { .ebook-reader *, .ebook-reader *::before, .ebook-reader *::after { animation-duration: .01ms !important; transition-duration: .01ms !important; } }
</style>
