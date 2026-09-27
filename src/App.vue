<script setup>
import { computed, onMounted, ref } from 'vue'
import BookshelfView from './components/BookshelfView.vue'
import CalendarView from './components/CalendarView.vue'
import DashboardView from './components/DashboardView.vue'
import Icon from './components/Icon.vue'
import ReaderView from './components/ReaderView.vue'
import WorkspaceView from './components/WorkspaceView.vue'
import { listImportedBooks } from './services/libraryStore.js'

const currentPage = ref('today')
const returnPage = ref('shelf')
const activeBook = ref(null)

const navigation = [
  { id: 'today', label: '今天', icon: 'today' },
  { id: 'shelf', label: '书架', icon: 'shelf' },
  { id: 'calendar', label: '日历', icon: 'calendar' },
  { id: 'notes', label: '笔记', icon: 'notes' },
  { id: 'review', label: '复习', icon: 'review' },
]

const books = ref([
  { id: 'rag-engineering', title: 'RAG 工程学习手册', coverTitle: 'RAG\n工程学习手册', subtitle: '从原理到实践', theme: 'blue', chapters: 18, progress: 44, category: '人工智能', lastRead: true },
  { id: 'programming', title: '编程语言基础', coverTitle: '编程语言\n基础', subtitle: '从原理到实践', theme: 'sand', chapters: 12, progress: 67, category: '技术' },
  { id: 'ai-engineering', title: 'AI 工程实践', coverTitle: 'AI 工程', subtitle: '从想法到产品', theme: 'night', chapters: 16, progress: 42, category: '人工智能' },
  { id: 'frontend', title: '前端工程实践', coverTitle: '前端工程', subtitle: '从基础到实战', theme: 'sky', chapters: 20, progress: 75, category: '技术' },
  { id: 'product-thinking', title: '产品思维', coverTitle: '产品思维', subtitle: '从用户需求到产品价值', theme: 'peach', chapters: 10, progress: 35, category: '产品设计' },
  { id: 'computer-science', title: '计算机基础', coverTitle: '计算机\n基础', subtitle: '构建数字世界的底层认知', theme: 'night', chapters: 16, progress: 50, category: '技术' },
  { id: 'design-foundations', title: '设计基础', coverTitle: '设计基础', subtitle: '让想法被看见', theme: 'mist', chapters: 8, progress: 20, category: '产品设计' },
  { id: 'learning-methods', title: '高效学习方法', coverTitle: '学习方法', subtitle: '成为更好的学习者', theme: 'forest', chapters: 9, progress: 60, category: '通用能力' },
])

const activeNav = computed(() => currentPage.value === 'reader' ? 'shelf' : currentPage.value)
const isReader = computed(() => currentPage.value === 'reader')

onMounted(async () => {
  try {
    const importedBooks = await listImportedBooks()
    for (const book of importedBooks) addBook(book)
  } catch (error) {
    console.warn('无法恢复本地导入的课程书籍。', error)
  }
})

function navigate(page) {
  currentPage.value = page
}

function openBook(book) {
  returnPage.value = currentPage.value === 'reader' ? 'shelf' : currentPage.value
  activeBook.value = book
  currentPage.value = 'reader'
}

function addBook(book) {
  const existingIndex = books.value.findIndex((item) => item.id === book.id)
  if (existingIndex >= 0) books.value.splice(existingIndex, 1, book)
  else books.value.push(book)
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
        <button v-for="item in navigation" :key="item.id" class="nav-item" :class="{ 'nav-item--active': activeNav === item.id }" @click="navigate(item.id)">
          <Icon :name="item.icon" size="19" /><span>{{ item.label }}</span><span v-if="item.id === 'review'" class="nav-count">8</span>
        </button>
      </nav>

      <div class="sidebar-divider"></div>
      <div class="sidebar-section-label sidebar-section-row"><span>最近阅读</span><Icon name="more" size="16" /></div>
      <button class="recent-book-link" @click="openBook(books[0])"><span class="recent-book-icon"><Icon name="shelf" size="15" /></span><span><strong>RAG 工程学习手册</strong><small>第 8 章 · 44%</small></span></button>
      <button class="recent-book-link" @click="openBook(books[1])"><span class="recent-book-icon recent-book-icon--sage"><Icon name="shelf" size="15" /></span><span><strong>编程语言基础</strong><small>第 6 章 · 67%</small></span></button>

      <div class="sidebar-spacer"></div>
      <div class="sidebar-quote"><span class="quote-mark">“</span><p>慢慢来，<br />比较快。</p><span>给今天的自己</span></div>
      <button class="profile-button"><span class="profile-avatar">林</span><span class="profile-copy"><strong>林同学</strong><small>保持好奇，持续学习</small></span><Icon name="more" size="18" /></button>
    </aside>

    <section v-if="!isReader" class="main-column">
      <header class="app-topbar">
        <div class="topbar-context"><span class="context-dot"></span><span>我的空间</span><Icon name="chevronRight" size="14" /><span>{{ navigation.find((item) => item.id === currentPage)?.label || '学习空间' }}</span></div>
        <div class="topbar-actions">
          <button class="global-search" @click="navigate('shelf')"><Icon name="search" size="17" /><span>搜索书籍、章节与笔记</span><kbd>⌘ K</kbd></button>
          <button class="topbar-icon-button" aria-label="通知"><Icon name="bell" size="18" /><i></i></button>
          <button class="topbar-avatar" aria-label="个人资料">林</button>
        </div>
      </header>

      <div class="page-scroller">
        <DashboardView v-if="currentPage === 'today'" @open-reader="openBook" @open-calendar="navigate('calendar')" @open-shelf="navigate('shelf')" />
        <BookshelfView v-else-if="currentPage === 'shelf'" :books="books" @open-book="openBook" @book-imported="addBook" />
        <CalendarView v-else-if="currentPage === 'calendar'" />
        <WorkspaceView v-else-if="currentPage === 'notes' || currentPage === 'review'" :kind="currentPage" />
      </div>
    </section>

    <ReaderView v-else :book="activeBook || books[0]" @back="returnFromReader" />

    <nav v-if="!isReader" class="mobile-navigation" aria-label="移动端主导航">
      <button v-for="item in navigation" :key="item.id" :class="{ active: activeNav === item.id }" @click="navigate(item.id)"><Icon :name="item.icon" size="19" /><span>{{ item.label }}</span></button>
    </nav>
  </div>
</template>
