<script setup>
import { computed, nextTick, ref } from 'vue'
import BookCover from './BookCover.vue'
import EbookImportDialog from './EbookImportDialog.vue'
import Icon from './Icon.vue'
import { deleteImportedBook } from '../services/libraryStore.js'
import { createEbookObjectUrl, deleteEbookFile, updateEbookMetadata } from '../services/ebookFileStore.js'
import { ensureEbookAvailable, ebookMigrationState, retryEbookMigration } from '../services/ebookMigration.js'
import { deleteLegacyEbookFile } from '../services/legacyEbookStore.js'
import { deleteLocalRecord } from '../services/localDataStore.js'

const props = defineProps({ books: { type: Array, required: true } })
const emit = defineEmits(['open-book', 'book-imported', 'book-removed'])

const searchText = ref('')
const searchInput = ref(null)
const activeFilter = ref('全部')
const filters = ['全部', '技术', '人工智能', '产品设计', '通用能力']
const categories = filters.slice(1)
const isImporterOpen = ref(false)
const isEbookImporterOpen = ref(false)
const courseTitle = ref('')
const courseCategory = ref('人工智能')
const selectedFiles = ref([])
const isSaving = ref(false)
const importError = ref('')
const importNotice = ref('')
const folderInput = ref(null)
const filesInput = ref(null)
const sortMode = ref('title')
const managedBook = ref(null)
const managementDraft = ref({ title: '', subtitle: '', author: '', category: '人工智能', theme: 'blue' })
const managementBusy = ref(false)
const managementError = ref('')
const managementNotice = ref('')
const confirmBookDelete = ref(false)
const isManagedEbook = computed(() => ['epub', 'pdf'].includes(managedBook.value?.format))

const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })

const searchIndex = computed(() => props.books.map((book) => ({
  book,
  metadata: `${book.title || ''} ${book.subtitle || ''} ${book.category || ''} ${book.author || ''}`.toLocaleLowerCase('zh-CN'),
  documents: (book.documents || []).map((document, index) => {
    const title = String(document.title || `第 ${index + 1} 章`)
    const content = String(document.content || '')
    return {
      id: String(document.id ?? `document-${index + 1}`),
      title,
      content,
      normalizedTitle: title.toLocaleLowerCase('zh-CN'),
      normalizedContent: content.toLocaleLowerCase('zh-CN'),
    }
  }),
})))

const chapterSearch = computed(() => {
  const query = searchText.value.trim().toLocaleLowerCase('zh-CN')
  const matches = []
  let hasMore = false
  if (!query) return { matches, hasMore }

  for (const indexedBook of searchIndex.value) {
    if (activeFilter.value !== '全部' && indexedBook.book.category !== activeFilter.value) continue
    for (const chapter of indexedBook.documents) {
      const contentIndex = chapter.normalizedContent.indexOf(query)
      const titleIndex = chapter.normalizedTitle.indexOf(query)
      if (contentIndex < 0 && titleIndex < 0) continue
      if (matches.length === 8) {
        hasMore = true
        break
      }

      let before = ''
      let matchedText = ''
      let after = ''
      const anchor = { format: 'markdown', chapterId: chapter.id }
      if (contentIndex >= 0) {
        const exactMatch = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu').exec(chapter.content)
        const start = exactMatch?.index ?? contentIndex
        const exact = exactMatch?.[0] || chapter.content.slice(start, start + query.length)
        const end = start + exact.length
        const contextStart = Math.max(0, start - 46)
        const contextEnd = Math.min(chapter.content.length, end + 76)
        before = `${contextStart > 0 ? '…' : ''}${chapter.content.slice(contextStart, start)}`
        matchedText = exact
        after = `${chapter.content.slice(end, contextEnd)}${contextEnd < chapter.content.length ? '…' : ''}`
        Object.assign(anchor, {
          start,
          end,
          exact,
          prefix: chapter.content.slice(Math.max(0, start - 36), start),
          suffix: chapter.content.slice(end, Math.min(chapter.content.length, end + 36)),
        })
      } else {
        const exact = chapter.title.slice(titleIndex, titleIndex + query.length)
        before = chapter.title.slice(0, titleIndex)
        matchedText = exact
        after = chapter.title.slice(titleIndex + exact.length)
      }

      matches.push({ book: indexedBook.book, chapterTitle: chapter.title, before, matchedText, after, anchor })
    }
    if (hasMore) break
  }
  return { matches, hasMore }
})

const visibleBooks = computed(() => {
  const query = searchText.value.trim().toLocaleLowerCase()
  const filtered = searchIndex.value.filter(({ book, metadata, documents }) => {
    const matchesQuery = !query || metadata.includes(query)
      || documents.some((document) => document.normalizedTitle.includes(query) || document.normalizedContent.includes(query))
    const matchesFilter = activeFilter.value === '全部' || book.category === activeFilter.value
    return matchesQuery && matchesFilter
  }).map(({ book }) => book)
  const compareTitle = (a, b) => collator.compare(a.title, b.title)
  return filtered.sort((a, b) => {
    if (sortMode.value === 'progress') return Number(b.progress || 0) - Number(a.progress || 0) || compareTitle(a, b)
    if (sortMode.value === 'chapters') return Number(b.chapters || 0) - Number(a.chapters || 0) || compareTitle(a, b)
    if (sortMode.value === 'recent') return String(b.lastReadAt || '').localeCompare(String(a.lastReadAt || '')) || compareTitle(a, b)
    return compareTitle(a, b)
  })
})

const markdownFiles = computed(() => selectedFiles.value.filter((file) => /\.(md|markdown)$/i.test(file.name)))
const imageFiles = computed(() => selectedFiles.value.filter((file) => /\.(png|jpe?g|webp|gif|avif)$/i.test(file.name)))
const selectedMarkdownFiles = computed(() => markdownFiles.value.length)
const duplicateDocumentPaths = computed(() => {
  const occurrences = new Map()
  for (const file of markdownFiles.value) {
    const path = relativeFilePath(file).normalize('NFKC').toLocaleLowerCase('zh-CN')
    occurrences.set(path, (occurrences.get(path) || 0) + 1)
  }
  return [...occurrences].filter(([, count]) => count > 1).map(([path]) => path)
})
const emptyDocuments = computed(() => markdownFiles.value.filter((file) => file.size === 0))
const totalMarkdownBytes = computed(() => markdownFiles.value.reduce((total, file) => total + file.size, 0))
const totalImageBytes = computed(() => imageFiles.value.reduce((total, file) => total + file.size, 0))
const duplicateTitle = computed(() => props.books.find((book) => book.title.trim().toLocaleLowerCase('zh-CN') === courseTitle.value.trim().toLocaleLowerCase('zh-CN')) || null)
const importBlockReason = computed(() => {
  if (selectedMarkdownFiles.value > 500) return '单门课程最多导入 500 篇 Markdown 文档。'
  if (duplicateDocumentPaths.value.length) return `章节路径重复：${duplicateDocumentPaths.value.slice(0, 2).join('、')}${duplicateDocumentPaths.value.length > 2 ? '等' : ''}。请先调整文件名。`
  if (totalMarkdownBytes.value > 15 * 1024 * 1024) return 'Markdown 文档总大小超过 15 MB，请拆分课程后导入。'
  if (totalImageBytes.value > 10 * 1024 * 1024) return '课程图片总大小超过 10 MB，请压缩图片后导入。'
  return ''
})

function focusSearch() {
  nextTick(() => searchInput.value?.focus())
}

function openManagement(book) {
  managedBook.value = book
  managementDraft.value = {
    title: book.title || '', subtitle: book.subtitle || '', author: book.author || '',
    category: categories.includes(book.category) ? book.category : '通用能力',
    theme: book.theme || 'blue',
  }
  managementError.value = ''
  managementNotice.value = ''
  confirmBookDelete.value = false
}

function closeManagement() {
  if (managementBusy.value) return
  managedBook.value = null
  managementError.value = ''
  managementNotice.value = ''
  confirmBookDelete.value = false
}

async function requestBook(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'X-Zhixu-Client': 'local-ui', ...(options.headers || {}) },
    credentials: 'same-origin',
  })
  const result = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(result.error || '书籍操作失败。')
  return result
}

async function saveBookDetails() {
  if (!managedBook.value || !managementDraft.value.title.trim() || managementBusy.value) return
  if (isManagedEbook.value) {
    managementBusy.value = true
    managementError.value = ''
    try {
      // 还没迁到本机目录的旧电子书，先完成迁移再改书目信息。
      await ensureEbookAvailable(String(managedBook.value.id))
      const metadata = await updateEbookMetadata(managedBook.value.id, {
        title: managementDraft.value.title.trim(),
        author: managementDraft.value.author.trim(),
      })
      const formatLabel = metadata.format === 'pdf' ? 'PDF 文档' : 'EPUB 电子书'
      emit('book-imported', {
        ...managedBook.value,
        ...metadata,
        id: metadata.bookId,
        migrationPending: false,
        subtitle: metadata.author ? `${metadata.author} · ${formatLabel}` : `${formatLabel} · 仅本机保存`,
      })
      managementNotice.value = '书籍信息已保存在本机。'
      window.setTimeout(closeManagement, 650)
    } catch (error) {
      managementError.value = error.message
    } finally {
      managementBusy.value = false
    }
    return
  }
  if (!managedBook.value.repositoryManaged) {
    await moveLegacyBookToRepository()
    return
  }
  managementBusy.value = true
  managementError.value = ''
  try {
    const result = await requestBook(`/api/books/${encodeURIComponent(managedBook.value.id)}`, {
      method: 'PATCH',
      body: JSON.stringify(managementDraft.value),
    })
    emit('book-imported', { ...result.book, progress: managedBook.value.progress, lastRead: managedBook.value.lastRead, lastReadAt: managedBook.value.lastReadAt, currentChapter: managedBook.value.currentChapter })
    managementNotice.value = '书籍信息已保存到仓库。'
    window.setTimeout(closeManagement, 650)
  } catch (error) {
    managementError.value = error.message
  } finally {
    managementBusy.value = false
  }
}

async function moveLegacyBookToRepository() {
  const source = managedBook.value
  if (!source?.documents?.length) {
    managementError.value = '这本旧版书籍没有可迁移的 Markdown 章节。'
    return
  }
  managementBusy.value = true
  managementError.value = ''
  try {
    const documents = source.documents.map((document, index) => ({
      file: document.file || `${String(index + 1).padStart(2, '0')}-${document.title || '章节'}.md`,
      content: String(document.content || ''),
    }))
    const result = await requestBook('/api/books', {
      method: 'POST',
      body: JSON.stringify({ id: /^[a-zA-Z0-9._-]{1,120}$/.test(String(source.id)) ? String(source.id) : undefined, title: managementDraft.value.title.trim(), subtitle: managementDraft.value.subtitle.trim(), category: managementDraft.value.category, theme: managementDraft.value.theme, documents }),
    })
    await deleteImportedBook(source.id)
    emit('book-removed', source.id)
    emit('book-imported', { ...result.book, progress: 0, lastRead: false })
    managementNotice.value = '课程已迁移到课程仓库，Markdown 章节也已保留。'
    window.setTimeout(closeManagement, 900)
  } catch (error) {
    managementError.value = error.message
  } finally {
    managementBusy.value = false
  }
}

async function removeManagedBook() {
  const target = managedBook.value
  if (!target || managementBusy.value) return
  managementBusy.value = true
  managementError.value = ''
  let removed = false
  try {
    if (target.repositoryManaged) {
      await requestBook(`/api/books/${encodeURIComponent(target.id)}`, { method: 'DELETE' })
    } else if (['epub', 'pdf'].includes(target.format)) {
      // 已迁到本机目录的删本机目录；仍在浏览器里的删浏览器副本，两种情况都清理干净。
      if (!target.migrationPending) await deleteEbookFile(target.id)
      else await deleteLegacyEbookFile(String(target.id)).catch(() => {})
      await deleteLocalRecord('reader', String(target.id))
    } else {
      await deleteImportedBook(target.id)
    }
    emit('book-removed', target.id)
    removed = true
  } catch (error) {
    managementError.value = error.message
  } finally {
    managementBusy.value = false
    if (removed) closeManagement()
  }
}

async function downloadEbookOriginal() {
  const target = managedBook.value
  if (!target || !isManagedEbook.value || managementBusy.value) return
  managementBusy.value = true
  managementError.value = ''
  managementNotice.value = ''
  try {
    await ensureEbookAvailable(String(target.id))
    const url = await createEbookObjectUrl(String(target.id))
    const link = document.createElement('a')
    link.href = url
    link.download = target.fileName || `${target.title}.${target.format}`
    document.body.append(link)
    link.click()
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
    managementNotice.value = '已开始下载本机目录中的原始电子书文件；请在浏览器下载列表确认完成。'
  } catch (error) {
    managementError.value = error?.message || '无法导出这本电子书。'
  } finally {
    managementBusy.value = false
  }
}

defineExpose({ focusSearch })

function startImport() {
  isImporterOpen.value = true
  importError.value = ''
  importNotice.value = ''
}

function handleEbookImported(savedBook) {
  const formatLabel = savedBook.format === 'pdf' ? 'PDF 文档' : 'EPUB 电子书'
  const book = {
    ...savedBook,
    id: String(savedBook.bookId),
    subtitle: savedBook.author ? `${savedBook.author} · ${formatLabel}` : `${formatLabel} · 仅本机保存`,
    category: '通用能力',
    theme: savedBook.format === 'pdf' ? 'peach' : 'mist',
    chapters: 0,
    documents: [],
    progress: 0,
    lastRead: false,
    imported: true,
    localOnly: true,
    migrationPending: false,
  }
  emit('book-imported', book)
  importNotice.value = `《${book.title}》已保存到本机目录 data/local/ebooks/${book.id}/。${savedBook.structurePrecheckSkipped
    ? '文件较大，已跳过浏览器端深度校验；打开时会再确认能否正常阅读。'
    : ''}`
}

const migrationFailures = computed(() => ebookMigrationState.failures)
const migrationBusy = computed(() => ebookMigrationState.running)
const migrationWarning = computed(() => {
  if (migrationFailures.value.length) {
    return `有 ${migrationFailures.value.length} 本电子书还没迁到本机目录 data/local/ebooks/：${migrationFailures.value
      .map((item) => `${item.title}（${item.reason}）`)
      .join('；')}。浏览器中的副本已保留，可以重试迁移。`
  }
  if (ebookMigrationState.error) {
    return `${ebookMigrationState.error} 旧版电子书仍保留在浏览器存储中，书架条目暂时标记为待迁移；本机服务恢复后点“重试迁移”即可，不会丢失数据。`
  }
  return ''
})

async function retryEbookMigrationNow() {
  await retryEbookMigration()
  if (ebookMigrationState.error) {
    importNotice.value = '本机电子书服务仍未连接，旧版电子书原样保留，没有丢失。'
    return
  }
  importNotice.value = migrationFailures.value.length
    ? `仍有 ${migrationFailures.value.length} 本电子书未能迁到本机目录，浏览器中的副本已保留。`
    : '旧版电子书已全部迁到本机目录。'
}

function openExistingEbook(bookId) {
  const book = props.books.find((item) => String(item.id) === String(bookId))
  if (!book) {
    importNotice.value = '检测到相同电子书已保存在本机，但书架列表暂时没有对应项目。请刷新页面后重试。'
    return
  }
  emit('open-book', book)
}

function closeImporter() {
  if (isSaving.value) return
  isImporterOpen.value = false
  selectedFiles.value = []
  courseTitle.value = ''
  importError.value = ''
}

function validMarkdownFiles(fileList) {
  return Array.from(fileList || []).filter((file) => /\.(md|markdown|png|jpe?g|webp|gif|avif)$/i.test(file.name))
}

function acceptFiles(fileList) {
  const files = validMarkdownFiles(fileList)
  const markdown = files.filter((file) => /\.(md|markdown)$/i.test(file.name))
  if (!markdown.length) {
    selectedFiles.value = []
    importError.value = '没有找到 Markdown 文件，请选择包含 .md 文档的课程目录。'
    return
  }

  selectedFiles.value = files.sort((a, b) => collator.compare(a.webkitRelativePath || a.name, b.webkitRelativePath || b.name))
  importError.value = ''
  importNotice.value = ''

  const relativePath = markdown[0].webkitRelativePath
  const folderName = relativePath?.split('/').filter(Boolean)[0]
  if (!courseTitle.value) {
    courseTitle.value = folderName || (selectedFiles.value.length === 1 ? fileTitle(selectedFiles.value[0].name) : '我的 AI 学习课程')
  }
}

function fileTitle(filename) {
  return filename.replace(/\.(md|markdown)$/i, '').trim() || '未命名章节'
}

function relativeFilePath(file) {
  const path = file.webkitRelativePath || file.name
  if (!file.webkitRelativePath) return path
  const segments = path.split('/').filter(Boolean)
  return segments.length > 1 ? segments.slice(1).join('/') : path
}

function formatFileSize(size) {
  const bytes = Number(size) || 0
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

async function fileToBase64(file) {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  const chunkSize = 0x8000
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize))
  }
  return window.btoa(binary)
}

async function importCourse() {
  if (!selectedFiles.value.length || !courseTitle.value.trim() || isSaving.value) return
  if (importBlockReason.value) {
    importError.value = importBlockReason.value
    return
  }
  isSaving.value = true
  importError.value = ''

  try {
    const documents = await Promise.all(markdownFiles.value.map(async (file) => ({
      file: relativeFilePath(file),
      content: await file.text(),
    })))
    const assets = await Promise.all(imageFiles.value.map(async (file) => ({
      file: relativeFilePath(file),
      content: await fileToBase64(file),
    })))
    const response = await fetch('/api/books', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Zhixu-Client': 'local-ui' },
      credentials: 'same-origin',
      body: JSON.stringify({ title: courseTitle.value.trim(), category: courseCategory.value, theme: 'blue', documents, assets }),
    })
    const result = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(result.error || '无法将课程写入仓库。请确认本机服务已启动。')

    const book = { ...result.book, progress: 0, lastRead: false }
    emit('book-imported', book)
    closeImporter()
    importNotice.value = `《${book.title}》已写入本机课程仓库，可以从书架开始阅读。`
  } catch (error) {
    importError.value = error instanceof Error ? error.message : '导入失败，请重试。'
  } finally {
    isSaving.value = false
  }
}
</script>

<template>
  <main class="page-content shelf-page">
    <header class="page-heading shelf-heading">
      <div><span class="eyebrow-label"><span class="eyebrow-line"></span> 你的学习收藏</span><h1>我的书架</h1><p>把每一门课程，都收进一本正在成长的书里。</p></div>
      <div class="shelf-import-actions">
        <button class="button button-secondary add-book-button" aria-label="导入 EPUB 或 PDF 电子书" @click="isEbookImporterOpen = true"><Icon name="shelf" size="17" /> 导入电子书</button>
        <button class="button button-primary add-book-button" aria-label="导入 Markdown 课程" @click="startImport"><Icon name="plus" size="17" /> 导入课程</button>
      </div>
    </header>

    <div v-if="importNotice" class="import-notice" role="status"><span class="import-notice-dot"></span>{{ importNotice }}<button aria-label="关闭提示" @click="importNotice = ''">×</button></div>

    <div v-if="migrationWarning" class="import-notice import-notice--warning" role="alert">
      <span class="import-notice-dot import-notice-dot--warning"></span>
      <span>{{ migrationWarning }}</span>
      <button class="text-button" :disabled="migrationBusy" @click="retryEbookMigrationNow">{{ migrationBusy ? '正在迁移…' : '重试迁移' }}</button>
    </div>

    <section class="shelf-toolbar">
      <div class="filter-pills" role="group" aria-label="按分类筛选书籍">
        <button v-for="filter in filters" :key="filter" type="button" class="filter-pill" :class="{ 'filter-pill--active': activeFilter === filter }" :aria-pressed="activeFilter === filter" @click="activeFilter = filter">{{ filter }}<span v-if="filter === '全部'">{{ books.length }}</span></button>
      </div>
      <div class="shelf-actions">
        <label class="search-field shelf-search"><Icon name="search" size="17" /><input ref="searchInput" v-model="searchText" type="search" aria-label="搜索书名、章节或正文" placeholder="搜索书名、章节或正文..." /></label>
        <label class="sort-control"><Icon name="filter" size="16" /><select v-model="sortMode" aria-label="书籍排序"><option value="title">按书名</option><option value="recent">最近阅读</option><option value="progress">阅读进度</option><option value="chapters">章节数量</option></select></label>
      </div>
    </section>

    <section v-if="searchText.trim() && chapterSearch.matches.length" class="chapter-search-results" aria-label="章节搜索结果">
      <header class="chapter-search-heading"><div><span>正文命中</span><strong>{{ chapterSearch.hasMore ? '显示前 8 条' : `${chapterSearch.matches.length} 个匹配章节` }}</strong></div><p>选择一条结果，直接打开对应章节并定位到原文。</p></header>
      <ol>
        <li v-for="(match, index) in chapterSearch.matches" :key="`${match.book.id}:${match.anchor.chapterId}`">
          <button type="button" class="chapter-search-result" :aria-label="`打开《${match.book.title}》的${match.chapterTitle}并定位到匹配内容`" @click="emit('open-book', match.book, match.anchor)">
            <span class="chapter-search-index">{{ String(index + 1).padStart(2, '0') }}</span>
            <span class="chapter-search-copy"><span class="chapter-search-source">{{ match.book.title }}<span aria-hidden="true"> / </span>{{ match.chapterTitle }}</span><span class="chapter-search-snippet"><span>{{ match.before }}</span><mark>{{ match.matchedText }}</mark><span>{{ match.after }}</span></span></span>
            <Icon name="arrowRight" size="16" />
          </button>
        </li>
      </ol>
    </section>

    <section v-if="visibleBooks.length" class="book-grid" aria-label="书籍">
      <article v-for="book in visibleBooks" :key="book.id" class="book-card">
        <button class="book-card-open" :aria-label="`打开《${book.title}》`" @click="emit('open-book', book)">
          <div class="book-card-cover-wrap">
            <BookCover :book="book" />
            <span v-if="book.lastRead" class="continue-badge"><span class="live-dot"></span> 继续阅读</span>
          </div>
        </button>
        <div class="book-card-details">
          <div class="book-card-title-row"><button class="book-card-title-button" @click="emit('open-book', book)"><h2>{{ book.title }}</h2><p>{{ book.subtitle }}</p></button><button class="card-more-button" :aria-label="`管理《${book.title}》`" @click.stop="openManagement(book)"><Icon name="more" size="18" /></button></div>
          <div class="book-card-meta"><span v-if="book.format">{{ book.format.toUpperCase() }} 电子书</span><span v-else>{{ book.chapters }} 个章节</span><span class="meta-dot">·</span><span>{{ book.progress }}% 已读</span><span v-if="book.repositoryManaged" class="imported-label">课程仓库</span><span v-else-if="book.localOnly" class="imported-label">仅本机</span><span v-else-if="book.imported" class="imported-label">已导入</span><span v-if="book.migrationPending" class="imported-label imported-label--warning">{{ book.serviceOffline ? '待迁移 · 服务离线' : '待迁移' }}</span></div>
          <div class="progress-track book-progress"><span :style="{ width: `${book.progress}%` }"></span></div>
        </div>
      </article>
    </section>
    <div v-else class="empty-state surface-card"><span class="empty-state-icon"><Icon :name="books.length ? 'search' : 'shelf'" size="22" /></span><h2>{{ books.length ? '没有找到这本书' : '你的书架还没有书' }}</h2><p>{{ books.length ? '试试其他关键词或分类。' : '导入一门 Markdown 课程，或把 EPUB、PDF 电子书放进本机书架。' }}</p><button v-if="books.length" class="text-button" @click="searchText = ''; activeFilter = '全部'">清除筛选</button><div v-else class="shelf-empty-actions"><button class="button button-secondary" @click="isEbookImporterOpen = true"><Icon name="shelf" size="15" /> 导入电子书</button><button class="button button-primary" @click="startImport"><Icon name="plus" size="15" /> 导入课程</button></div></div>

    <footer class="shelf-footer"><span>共 {{ visibleBooks.length }} 本学习书籍</span><span>每门课程，都有自己的阅读节奏。</span></footer>

    <div v-if="managedBook" class="importer-backdrop" @click.self="closeManagement">
      <section class="importer-dialog management-dialog" role="dialog" aria-modal="true" aria-labelledby="management-title">
        <header class="importer-header"><div><span class="importer-kicker">书籍管理</span><h2 id="management-title">{{ managedBook.repositoryManaged ? '编辑书籍信息' : isManagedEbook ? '编辑本机电子书' : '整理旧版课程' }}</h2><p v-if="managedBook.repositoryManaged">更新书架展示信息，章节原文不会被改动。</p><p v-else-if="isManagedEbook">电子书原文件保存在本机目录 data/local/ebooks/，阅读记录保存在 data/local/records.json。</p><p v-else>这门课程还只保存在当前浏览器。迁移后会写入本机课程仓库。</p></div><button class="importer-close" aria-label="关闭书籍管理" @click="closeManagement">×</button></header>
        <div class="management-fields">
          <label class="importer-field"><span>书名</span><input v-model="managementDraft.title" maxlength="100" /></label>
          <label v-if="isManagedEbook" class="importer-field"><span>作者 <small>可选</small></span><input v-model="managementDraft.author" maxlength="120" /></label>
          <template v-else>
            <label class="importer-field"><span>副标题</span><input v-model="managementDraft.subtitle" maxlength="140" /></label>
            <label class="importer-field"><span>书架分类</span><select v-model="managementDraft.category"><option v-for="category in categories" :key="category">{{ category }}</option></select></label>
            <label class="importer-field"><span>封面色系</span><select v-model="managementDraft.theme"><option value="blue">雾蓝</option><option value="sand">暖沙</option><option value="night">深夜</option><option value="sky">晴空</option><option value="peach">蜜桃</option><option value="mist">薄雾</option><option value="forest">森林</option></select></label>
          </template>
        </div>
        <div v-if="confirmBookDelete" class="management-confirm"><strong>确定移除《{{ managedBook.title }}》？</strong><p v-if="managedBook.repositoryManaged">课程文件会从仓库中删除；与它关联的私人笔记和复习卡会保留，但不再显示书名。</p><p v-else-if="isManagedEbook">电子书原文件会从本机目录 data/local/ebooks/ 中删除；阅读进度也会删除，已保存的笔记和复习卡会保留。</p><p v-else>课程会从当前浏览器的本地书架移除。</p><div><button class="button button-secondary" :disabled="managementBusy" @click="confirmBookDelete = false">返回</button><button class="button button-danger" :disabled="managementBusy" @click="removeManagedBook">{{ managementBusy ? '正在删除…' : '确认删除' }}</button></div></div>
        <div v-else class="management-footer"><button v-if="managedBook.repositoryManaged || isManagedEbook" class="text-button danger-text" :disabled="managementBusy" @click="confirmBookDelete = true">删除书籍</button><button v-else class="text-button danger-text" :disabled="managementBusy" @click="confirmBookDelete = true">从本机移除</button><div><button v-if="isManagedEbook" class="button button-secondary" :disabled="managementBusy" @click="downloadEbookOriginal">导出原文件</button><button class="button button-secondary" :disabled="managementBusy" @click="closeManagement">取消</button><button class="button button-primary" :disabled="managementBusy || !managementDraft.title.trim()" @click="saveBookDetails">{{ managementBusy ? '正在保存…' : managedBook.repositoryManaged || isManagedEbook ? '保存信息' : '迁移到仓库' }}</button></div></div>
        <p v-if="managementNotice" class="management-notice" role="status">{{ managementNotice }}</p><p v-if="managementError" class="importer-error" role="alert">{{ managementError }}</p>
      </section>
    </div>

    <div v-if="isImporterOpen" class="importer-backdrop" @click.self="closeImporter">
      <section class="importer-dialog" role="dialog" aria-modal="true" aria-labelledby="importer-title">
        <header class="importer-header"><div><span class="importer-kicker">课程导入</span><h2 id="importer-title">把一门课程装进书架</h2><p>选择课程文件夹，或一次选中多篇 Markdown。文件会按名称自然排序。</p></div><button class="importer-close" aria-label="关闭导入窗口" @click="closeImporter">×</button></header>

        <div class="importer-source-options">
          <button class="importer-source" @click="folderInput?.click()"><span class="source-icon"><Icon name="shelf" size="20" /></span><span><strong>选择课程文件夹</strong><small>自动收集文件夹中的 .md 文档</small></span><Icon name="chevronRight" size="16" /></button>
          <button class="importer-source" @click="filesInput?.click()"><span class="source-icon source-icon--blue"><Icon name="notes" size="19" /></span><span><strong>选择多篇 Markdown</strong><small>将所选文档合并为一本课程书</small></span><Icon name="chevronRight" size="16" /></button>
          <input ref="folderInput" class="visually-hidden-input" type="file" webkitdirectory multiple @change="acceptFiles($event.target.files); $event.target.value = ''" />
          <input ref="filesInput" class="visually-hidden-input" type="file" multiple accept=".md,.markdown,.png,.jpg,.jpeg,.webp,.gif,.avif,text/markdown,image/png,image/jpeg,image/webp,image/gif,image/avif" @change="acceptFiles($event.target.files); $event.target.value = ''" />
        </div>

        <div v-if="selectedMarkdownFiles" class="importer-form">
          <label class="importer-field"><span>课程名称</span><input v-model="courseTitle" type="text" maxlength="100" placeholder="例如：RAG 工程学习手册" /></label>
          <label class="importer-field"><span>书架分类</span><select v-model="courseCategory"><option v-for="category in categories" :key="category" :value="category">{{ category }}</option></select></label>
          <div class="document-preview">
            <div class="document-preview-heading"><strong>导入检查</strong><span>{{ selectedMarkdownFiles }} 篇章节 · {{ formatFileSize(totalMarkdownBytes) }}</span></div>
            <ol class="document-preview-list"><li v-for="(file, index) in markdownFiles" :key="`${relativeFilePath(file)}-${index}`"><span class="preview-index">{{ String(index + 1).padStart(2, '0') }}</span><span class="preview-path">{{ relativeFilePath(file) }}</span><small>{{ formatFileSize(file.size) }}</small></li></ol>
            <small v-if="imageFiles.length">将一并收录 {{ imageFiles.length }} 张图片 · {{ formatFileSize(totalImageBytes) }}</small>
            <small v-if="emptyDocuments.length" class="preview-warning">有 {{ emptyDocuments.length }} 篇空文档，导入后会作为空章节保留。</small>
            <small v-if="duplicateTitle" class="preview-warning">书架上已有同名课程《{{ duplicateTitle.title }}》，仍可继续导入为另一册。</small>
            <small v-if="importBlockReason" class="preview-error" role="alert">{{ importBlockReason }}</small>
          </div>
        </div>

        <p v-if="importError" class="importer-error" role="alert">{{ importError }}</p>
          <footer class="importer-footer"><span class="importer-storage-note"><Icon name="bookmark" size="14" /> 课程文档以明文保存在仓库，之后可能随 Git 同步到远程；请勿导入私人内容</span><div><button class="button button-secondary" :disabled="isSaving" @click="closeImporter">取消</button><button class="button button-primary" :disabled="!selectedMarkdownFiles || !courseTitle.trim() || Boolean(importBlockReason) || isSaving" @click="importCourse">{{ isSaving ? '正在导入…' : '导入到书架' }}</button></div></footer>
      </section>
    </div>

    <EbookImportDialog :open="isEbookImporterOpen" @close="isEbookImporterOpen = false" @imported="handleEbookImported" @open-existing="openExistingEbook" />
  </main>
</template>

<style scoped>
.import-notice { display: flex; align-items: center; gap: 9px; margin: -8px 0 17px; padding: 10px 13px; border: 1px solid #d9eadf; border-radius: 11px; color: #426c50; background: #f2faf4; font-size: 12px; }
.import-notice--warning { align-items: flex-start; border-color: #f0ddc4; color: #8a6438; background: #fdf8ef; line-height: 1.65; }
.import-notice--warning .text-button { flex: 0 0 auto; margin-left: auto; padding: 4px 9px; border: 1px solid #e6d3b4; border-radius: 7px; color: #8a6438; background: #fff; font: inherit; font-size: 11px; font-weight: 600; cursor: pointer; }
.import-notice--warning .text-button:disabled { cursor: wait; opacity: .55; }
.import-notice-dot { width: 7px; height: 7px; flex: 0 0 auto; border-radius: 50%; background: #55a76b; }
.import-notice-dot--warning { margin-top: 5px; background: #d29a4c; }
.chapter-search-results { margin: 16px 0 24px; overflow: hidden; border: 1px solid #e8ebef; border-radius: 15px; background: rgba(255,255,255,.78); }
.chapter-search-heading { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 13px 16px; border-bottom: 1px solid #edf0f3; }
.chapter-search-heading > div { display: flex; align-items: baseline; gap: 9px; }
.chapter-search-heading > div span { color: #8490a0; font-size: 10px; font-weight: 650; letter-spacing: .04em; }
.chapter-search-heading > div strong { color: #515b69; font-size: 11px; font-weight: 600; }
.chapter-search-heading p { margin: 0; color: #9aa2ad; font-size: 10px; }
.chapter-search-results ol { display: grid; margin: 0; padding: 0; list-style: none; }
.chapter-search-results li + li { border-top: 1px solid #f0f2f4; }
.chapter-search-result { display: grid; width: 100%; grid-template-columns: 27px minmax(0, 1fr) 17px; align-items: center; gap: 12px; padding: 12px 16px; border: 0; color: #858e9a; background: transparent; cursor: pointer; text-align: left; transition: background-color 150ms ease; }
.chapter-search-result:hover { background: #f8f9fb; }
.chapter-search-index { color: #aab2bd; font-size: 10px; font-variant-numeric: tabular-nums; }
.chapter-search-copy { display: grid; min-width: 0; gap: 5px; }
.chapter-search-source { overflow: hidden; color: #6f7885; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.chapter-search-snippet { display: -webkit-box; overflow: hidden; color: #9299a3; font-size: 11px; line-height: 1.55; text-overflow: ellipsis; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.chapter-search-snippet mark { border-radius: 3px; color: #3b506e; background: #e7eef8; }
.chapter-search-result:focus-visible { outline: 3px solid rgb(70 111 208 / 30%); outline-offset: -3px; }
.sort-control { min-height: 34px; display: inline-flex; align-items: center; gap: 5px; padding: 0 8px; border: 1px solid #e9edf1; border-radius: 9px; color: #9aa4b1; background: rgba(255,255,255,.7); }
.sort-control select { max-width: 86px; border: 0; outline: 0; color: #758194; background: transparent; font: inherit; font-size: 9px; cursor: pointer; }
.management-dialog { width: min(100%, 470px); }
.shelf-import-actions, .shelf-empty-actions { display: flex; align-items: center; gap: 8px; }
.shelf-empty-actions { justify-content: center; }
.management-fields .importer-field small { margin-left: 4px; color: #a1a9b4; font-size: 9px; font-weight: 400; }
.management-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 21px; }
.management-fields .importer-field:first-child, .management-fields .importer-field:nth-child(2) { grid-column: 1 / -1; }
.management-footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 20px; padding-top: 15px; border-top: 1px solid #edf0f3; }
.management-footer > div, .management-confirm > div { display: flex; gap: 8px; }
.management-footer .button, .management-confirm .button { min-height: 35px; font-size: 10px; }
.danger-text { color: #b56660; }
.button-danger { min-height: 35px; padding: 0 13px; border: 1px solid #f0d7d4; border-radius: 9px; color: #a84f49; background: #fff7f6; font: inherit; font-size: 10px; cursor: pointer; }
.button-danger:hover { background: #ffefed; }
.button-danger:disabled { opacity: .55; cursor: wait; }
.management-confirm { margin-top: 21px; padding: 14px; border: 1px solid #f0dfda; border-radius: 12px; background: #fffaf9; }
.management-confirm strong { color: #6e4f4a; font-size: 12px; }
.management-confirm p { margin: 7px 0 13px; color: #927f7b; font-size: 10px; line-height: 1.65; }
.management-confirm > div { justify-content: flex-end; }
.management-notice { margin: 13px 0 0; color: #548268; font-size: 10px; }
.import-notice-dot { width: 7px; height: 7px; border-radius: 50%; background: #55a76b; }
.import-notice button { margin-left: auto; border: 0; color: inherit; background: transparent; font-size: 18px; cursor: pointer; }
.imported-label { margin-left: auto; color: #8d98a7; font-size: 9px; }
.imported-label--warning { margin-left: 0; color: #a3763c; }
.importer-backdrop { position: fixed; z-index: 30; inset: 0; display: grid; place-items: center; padding: 20px; background: rgba(25, 36, 51, .32); backdrop-filter: blur(7px); }
.importer-dialog { width: min(100%, 520px); max-height: min(90vh, 760px); overflow: auto; padding: 25px; border: 1px solid rgba(255,255,255,.8); border-radius: 20px; background: #fff; box-shadow: 0 24px 80px rgba(26, 44, 70, .2); }
.importer-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; }
.importer-kicker { color: #5a8ce2; font-size: 10px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
.importer-header h2 { margin: 8px 0 6px; color: #253247; font-size: 20px; letter-spacing: -.035em; }
.importer-header p { max-width: 390px; margin: 0; color: #8691a0; font-size: 12px; line-height: 1.65; }
.importer-close { display: grid; width: 31px; height: 31px; flex: 0 0 auto; place-items: center; border: 0; border-radius: 9px; color: #7d8795; background: #f3f5f8; font-size: 21px; cursor: pointer; }
.importer-source-options { display: grid; gap: 9px; margin-top: 21px; }
.importer-source { display: flex; align-items: center; gap: 12px; width: 100%; padding: 12px; border: 1px solid #e7ebf0; border-radius: 12px; color: #8691a0; background: #fff; text-align: left; cursor: pointer; transition: border-color .16s ease, background .16s ease; }
.importer-source:hover { border-color: #cbdaf1; background: #f9fbff; }
.source-icon { display: grid; width: 37px; height: 37px; flex: 0 0 auto; place-items: center; border-radius: 10px; color: #9a8052; background: #f8f3e8; }
.source-icon--blue { color: #5789d7; background: #edf4ff; }
.importer-source > span:nth-child(2) { display: grid; gap: 4px; flex: 1; }
.importer-source strong { color: #344155; font-size: 12px; font-weight: 600; }
.importer-source small { color: #929caa; font-size: 10px; }
.visually-hidden-input { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; clip-path: inset(50%); }
.importer-form { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 17px; }
.importer-field { display: grid; gap: 7px; color: #667386; font-size: 11px; font-weight: 600; }
.importer-field input, .importer-field select { width: 100%; min-height: 38px; box-sizing: border-box; padding: 0 10px; border: 1px solid #e5e9ee; border-radius: 9px; color: #344155; background: #fff; font-size: 12px; }
.document-preview { grid-column: 1 / -1; padding: 12px 13px; border-radius: 11px; background: #f7f8fa; }
.document-preview-heading { display: flex; justify-content: space-between; color: #47556a; font-size: 11px; }
.document-preview-heading span { color: #9aa4b1; font-size: 10px; }
.document-preview-list { display: grid; max-height: 192px; gap: 5px; overflow: auto; margin: 10px -4px 0 0; padding: 0 4px 0 0; color: #718096; font-size: 10px; list-style: none; }
.document-preview-list li { display: flex; align-items: center; gap: 8px; min-width: 0; padding: 5px 0; border-bottom: 1px solid #eceff3; }
.preview-index { flex: 0 0 22px; color: #a5afbb; font-variant-numeric: tabular-nums; }
.preview-path { min-width: 0; flex: 1; overflow-wrap: anywhere; }
.document-preview-list li small { flex: 0 0 auto; margin: 0; font-size: 9px; }
.document-preview small { display: block; margin-top: 7px; color: #9aa4b1; font-size: 10px; }
.document-preview small.preview-warning { color: #9c7949; }
.document-preview small.preview-error { color: #ba4c48; }
.importer-error { margin: 12px 0 0; color: #ba4c48; font-size: 11px; line-height: 1.5; }
.importer-footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 19px; padding-top: 15px; border-top: 1px solid #edf0f3; }
.importer-storage-note { display: inline-flex; align-items: center; gap: 5px; color: #9aa4b1; font-size: 9px; }
.importer-footer > div { display: flex; gap: 8px; }
.importer-footer .button { min-height: 35px; font-size: 10px; }
.importer-footer .button:disabled { opacity: .48; cursor: not-allowed; }
@media (max-width: 520px) {
  .importer-backdrop { align-items: end; padding: 10px; }
  .importer-dialog { max-height: 88vh; padding: 19px 17px; border-radius: 18px; }
  .importer-header h2 { font-size: 18px; }
  .importer-form { grid-template-columns: 1fr; }
  .chapter-search-heading { align-items: flex-start; flex-direction: column; gap: 5px; }
  .chapter-search-result { grid-template-columns: 20px minmax(0, 1fr) 14px; gap: 8px; padding: 11px 12px; }
  .management-fields { grid-template-columns: 1fr; }
  .management-fields .importer-field { grid-column: 1 !important; }
  .management-footer { align-items: flex-start; flex-direction: column; }
  .management-footer > div { width: 100%; }
  .management-footer .button { flex: 1; }
  .document-preview { grid-column: 1; }
  .importer-footer { align-items: flex-start; flex-direction: column; }
  .importer-footer > div { width: 100%; }
  .importer-footer .button { flex: 1; }
}
</style>
