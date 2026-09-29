<script setup>
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import BookshelfView from './components/BookshelfView.vue'
import CalendarView from './components/CalendarView.vue'
import DashboardView from './components/DashboardView.vue'
import GlobalSearchDialog from './components/GlobalSearchDialog.vue'
import Icon from './components/Icon.vue'
import ReaderView from './components/ReaderView.vue'
import StatsView from './components/StatsView.vue'
import SyncCenter from './components/SyncCenter.vue'
import WorkspaceView from './components/WorkspaceView.vue'
import { listImportedBooks } from './services/libraryStore.js'
import { listEbookFiles } from './services/ebookFileStore.js'
import { listPendingEbooks, runEbookMigration } from './services/ebookMigration.js'
import { getLocalRecord, getLocalRecords, localDataState, refreshLocalDataState } from './services/localDataStore.js'
import { loadRepositoryBooks } from './services/repositoryLibrary.js'
import { isReviewDue } from './services/reviewSchedule.js'

const EbookReaderView = defineAsyncComponent(() => import('./components/EbookReaderView.vue'))

const currentPage = ref('today')
const returnPage = ref('shelf')
const activeBook = ref(null)
const activeAnchor = ref(null)
const globalSearchOpen = ref(false)
const workspaceView = ref(null)
const reviewClock = ref(Date.now())
let reviewClockTimer = null

const navigation = [
  { id: 'today', label: '工作台', icon: 'grid' },
  { id: 'shelf', label: '书架', icon: 'shelf' },
  { id: 'calendar', label: '日历', icon: 'calendar' },
  { id: 'notes', label: '笔记', icon: 'notes' },
  { id: 'review', label: '复习', icon: 'review' },
  { id: 'stats', label: '统计', icon: 'trend' },
]

const books = ref([])

const activeNav = computed(() => currentPage.value === 'reader' ? 'shelf' : currentPage.value)
const isReader = computed(() => currentPage.value === 'reader')
const searchShortcut = computed(() => /Mac|iPhone|iPad/.test(navigator.platform || '') ? '⌘ K' : 'Ctrl K')
const recentBooks = computed(() => [...books.value]
  .sort((a, b) => Number(Boolean(b.lastRead)) - Number(Boolean(a.lastRead)) || b.progress - a.progress)
  .slice(0, 2))
const dueReviewCount = computed(() => {
  const now = reviewClock.value
  return getLocalRecords('review').filter((card) => isReviewDue(card, now)).length
})

watch(() => localDataState.events, updatePrivateProgress, { deep: true })

const booksLoading = ref(true)

onMounted(async () => {
  reviewClockTimer = window.setInterval(() => { reviewClock.value = Date.now() }, 30_000)
  await refreshLocalDataState()
  await reloadRepositoryBooks()
  window.addEventListener('zhixu:sync-complete', reloadRepositoryBooks)
  // 迁移（含书架上的“重试迁移”）完成后刷新书架条目，去掉“待迁移”标记。
  window.addEventListener('zhixu:ebooks-migrated', refreshEbookShelf)
  window.addEventListener('zhixu:local-backup-restored', refreshEbooksAfterBackupRestore)
  window.addEventListener('keydown', handleGlobalShortcut)

  try {
    const importedBooks = await listImportedBooks()
    for (const book of importedBooks) addBook(book)
  } catch (error) {
    console.warn('无法恢复本地导入的课程书籍。', error)
  }
  await loadEbookBooks()
  await loadPendingEbookBooks()
  await migrateEbookFiles()
  updatePrivateProgress()
  booksLoading.value = false
})

onBeforeUnmount(() => {
  if (reviewClockTimer) window.clearInterval(reviewClockTimer)
  window.removeEventListener('zhixu:sync-complete', reloadRepositoryBooks)
  window.removeEventListener('zhixu:ebooks-migrated', refreshEbookShelf)
  window.removeEventListener('zhixu:local-backup-restored', refreshEbooksAfterBackupRestore)
  window.removeEventListener('keydown', handleGlobalShortcut)
})

async function reloadRepositoryBooks() {
  const repositoryBooks = await loadRepositoryBooks()
  const repositoryIds = new Set(repositoryBooks.map((book) => book.id))
  books.value = books.value.filter((book) => !book.repositoryManaged || repositoryIds.has(book.id))
  for (const book of repositoryBooks) addBook(book)
  updatePrivateProgress()
}

function ebookBookFromRecord(savedBook, { migrationPending = false, serviceOffline = false } = {}) {
  const bookId = String(savedBook.bookId ?? savedBook.id)
  const reader = getLocalRecord('reader', bookId)
  const formatLabel = savedBook.format === 'pdf' ? 'PDF 文档' : 'EPUB 电子书'
  const subtitle = serviceOffline
    ? `${formatLabel} · 本机服务未连接，暂未迁移`
    : migrationPending
      ? `${formatLabel} · 等待迁到本机目录`
      : savedBook.author ? `${savedBook.author} · ${formatLabel}` : `${formatLabel} · 仅本机保存`
  return {
    ...savedBook,
    id: bookId,
    bookId,
    format: savedBook.format,
    subtitle,
    category: '通用能力',
    theme: savedBook.format === 'pdf' ? 'peach' : 'mist',
    chapters: Number(reader?.pageCount || reader?.chapterCount || 0),
    documents: [],
    progress: Number(reader?.progress) || 0,
    lastRead: Boolean(reader?.lastReadAt),
    lastReadAt: reader?.lastReadAt || '',
    currentChapter: reader?.chapterTitle || (reader?.page ? `第 ${reader.page} 页` : ''),
    imported: true,
    localOnly: true,
    migrationPending,
    serviceOffline,
  }
}

async function loadEbookBooks() {
  try {
    const ebookFiles = await listEbookFiles()
    for (const savedBook of ebookFiles) addBook(ebookBookFromRecord(savedBook))
  } catch (error) {
    console.warn('无法恢复本机电子书。', error)
  }
}

async function loadPendingEbookBooks() {
  try {
    const pending = await listPendingEbooks()
    for (const savedBook of pending) {
      addBook(ebookBookFromRecord(savedBook, {
        migrationPending: true,
        serviceOffline: Boolean(savedBook.serviceOffline),
      }))
    }
  } catch (error) {
    console.warn('无法读取旧版浏览器电子书列表。', error)
  }
}

/** 迁移完成后重新装载书架上的电子书条目。 */
async function refreshEbookShelf() {
  await loadEbookBooks()
  await loadPendingEbookBooks()
  updatePrivateProgress()
}

async function refreshEbooksAfterBackupRestore() {
  books.value = books.value.filter((book) => !['epub', 'pdf'].includes(book.format))
  await refreshEbookShelf()
}

async function migrateEbookFiles() {
  await runEbookMigration()
  updatePrivateProgress()
}

function navigate(page) {
  currentPage.value = page
  if (page === 'shelf') void reloadRepositoryBooks()
}

function startReviewFromDashboard() {
  currentPage.value = 'review'
  nextTick(() => workspaceView.value?.startReview())
}

function createReviewCardFromDashboard() {
  currentPage.value = 'review'
  nextTick(() => workspaceView.value?.focusNewCard())
}

function openGlobalSearch() {
  globalSearchOpen.value = true
}

function openSearchNote(note) {
  currentPage.value = 'notes'
  nextTick(() => workspaceView.value?.focusNoteById(note.id))
}
function handleGlobalShortcut(event) {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault()
    openGlobalSearch()
  }
}

function openBook(book, anchor = null) {
  returnPage.value = currentPage.value === 'reader' ? 'shelf' : currentPage.value
  activeBook.value = book
  activeAnchor.value = anchor
  currentPage.value = 'reader'
}

function openNoteLocation(note) {
  const book = books.value.find((item) => item.id === note.bookId)
  if (!book) return
  returnPage.value = currentPage.value === 'reader' ? 'notes' : currentPage.value
  activeBook.value = book
  activeAnchor.value = note.anchor || (note.chapterId ? { chapterId: note.chapterId } : null)
  currentPage.value = 'reader'
}

function addBook(book) {
  const existingIndex = books.value.findIndex((item) => item.id === book.id)
  if (existingIndex >= 0) {
    const existing = books.value[existingIndex]
    if (existing.repositoryManaged && !book.repositoryManaged) return
    books.value.splice(existingIndex, 1, { ...existing, ...book })
  }
  else books.value.push(book)
}

function removeBook(bookId) {
  books.value = books.value.filter((book) => book.id !== bookId)
  if (activeBook.value?.id === bookId) {
    activeBook.value = null
    currentPage.value = 'shelf'
  }
}

function updateBookProgress({ bookId, progress, chapterTitle }) {
  const book = books.value.find((item) => item.id === bookId)
  if (!book) return
  book.progress = progress
  book.lastRead = true
  book.lastReadAt = new Date().toISOString()
  if (chapterTitle) book.currentChapter = chapterTitle
}

function updatePrivateProgress() {
  for (const book of books.value) {
    const record = getLocalRecord('reader', String(book.id))
    if (book.format === 'epub' || book.format === 'pdf') {
      Object.assign(book, {
        progress: Math.min(100, Math.max(0, Number(record?.progress) || 0)),
        lastRead: Boolean(record?.lastReadAt),
        lastReadAt: record?.lastReadAt || '',
        currentChapter: record?.chapterTitle || (record?.page ? `第 ${record.page} 页` : ''),
        chapters: Number(record?.pageCount || record?.chapterCount || book.chapters || 0),
      })
      continue
    }
    if (!record) {
      Object.assign(book, { progress: 0, lastRead: false, currentChapter: '' })
      continue
    }
    const chapters = Array.isArray(book.documents) ? book.documents : []
    const chapterIndex = chapters.findIndex((chapter) => chapter.id === record.chapterId)
    Object.assign(book, {
      progress: chapters.length ? Math.round(new Set(record.completedChapterIds || []).size / chapters.length * 100) : 0,
      lastRead: Boolean(record.lastReadAt),
      lastReadAt: record.lastReadAt || '',
      currentChapter: chapters[chapterIndex]?.title || '',
    })
  }
}

function returnFromReader() {
  currentPage.value = returnPage.value || 'shelf'
}
</script>

<template>
  <div class="app-shell" :class="{ 'app-shell--reader': isReader }">
    <aside v-if="!isReader" class="sidebar">
      <button class="brand-lockup" @click="navigate('today')" aria-label="返回首页">
        <span class="brand-symbol"><span></span><span></span></span>
        <span class="brand-copy"><strong>知序</strong><small>个人学习空间</small></span>
      </button>

      <div class="sidebar-section-label">空间</div>
      <nav class="primary-navigation" aria-label="主导航">
        <button v-for="item in navigation" :key="item.id" class="nav-item" :class="{ 'nav-item--active': activeNav === item.id }" :aria-label="item.label" :title="item.label" :aria-current="activeNav === item.id ? 'page' : undefined" @click="navigate(item.id)">
          <Icon :name="item.icon" size="19" /><span>{{ item.label }}</span><span v-if="item.id === 'review' && dueReviewCount" class="nav-count">{{ dueReviewCount }}</span>
        </button>
      </nav>

      <div class="sidebar-divider"></div>
      <div class="sidebar-section-label sidebar-section-row"><span>最近阅读</span><Icon name="more" size="16" /></div>
      <button v-for="(book, index) in recentBooks" :key="book.id" class="recent-book-link" @click="openBook(book)"><span class="recent-book-icon" :class="{ 'recent-book-icon--sage': index === 1 }"><Icon name="shelf" size="15" /></span><span><strong>{{ book.title }}</strong><small>{{ book.currentChapter || `阅读进度 ${book.progress}%` }}</small></span></button>

      <div class="sidebar-spacer"></div>
      <div class="sidebar-quote"><span class="quote-mark">“</span><p>慢慢来，<br />比较快。</p><span>给今天的自己</span></div>
      <div class="profile-button"><span class="profile-avatar">知</span><span class="profile-copy"><strong>我的学习空间</strong><small>保持好奇，持续学习</small></span></div>
    </aside>

    <section v-if="!isReader" class="main-column">
      <header class="app-topbar">
        <div class="topbar-context"><span class="context-dot"></span><span>我的空间</span><Icon name="chevronRight" size="14" /><span>{{ navigation.find((item) => item.id === currentPage)?.label || '学习空间' }}</span></div>
        <div class="topbar-actions">
          <button class="global-search" aria-label="全局搜索" @click="openGlobalSearch"><Icon name="search" size="17" /><span>搜索课程、章节与笔记</span><kbd>{{ searchShortcut }}</kbd></button>
          <SyncCenter />
          <span class="topbar-avatar" aria-hidden="true">知</span>
        </div>
      </header>

      <div class="page-scroller">
        <DashboardView v-if="currentPage === 'today'" :books="books" @open-reader="openBook" @open-calendar="navigate('calendar')" @open-shelf="navigate('shelf')" @start-review="startReviewFromDashboard" @create-review-card="createReviewCardFromDashboard" />
        <BookshelfView v-else-if="currentPage === 'shelf'" :books="books" :books-loading="booksLoading" @open-book="openBook" @book-imported="addBook" @book-removed="removeBook" />
        <CalendarView v-else-if="currentPage === 'calendar'" :books="books" />
        <WorkspaceView v-else-if="currentPage === 'notes' || currentPage === 'review'" ref="workspaceView" :kind="currentPage" :books="books" @open-note="openNoteLocation" />
        <StatsView v-else-if="currentPage === 'stats'" :books="books" @open-book="openBook" />
      </div>
    </section>

    <EbookReaderView v-if="isReader && ['epub', 'pdf'].includes(activeBook?.format)" :key="activeBook?.id" :book="activeBook" :initial-anchor="activeAnchor" @back="returnFromReader" @progress="updateBookProgress" />
    <ReaderView v-else-if="isReader" :key="activeBook?.id" :book="activeBook || books[0]" :initial-anchor="activeAnchor" @back="returnFromReader" @progress="updateBookProgress" />

    <GlobalSearchDialog v-model:open="globalSearchOpen" :books="books" @open-book="openBook" @open-note="openSearchNote" />
    <nav v-if="!isReader" class="mobile-navigation" aria-label="移动端主导航">
      <button v-for="item in navigation" :key="item.id" :class="{ active: activeNav === item.id }" :aria-label="item.label" :aria-current="activeNav === item.id ? 'page' : undefined" @click="navigate(item.id)"><Icon :name="item.icon" size="19" /><span>{{ item.label }}</span></button>
    </nav>
  </div>
</template>
