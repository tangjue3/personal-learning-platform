<script setup>
import { computed, ref } from 'vue'
import BookCover from './BookCover.vue'
import Icon from './Icon.vue'
import { saveImportedBook } from '../services/libraryStore.js'

const props = defineProps({ books: { type: Array, required: true } })
const emit = defineEmits(['open-book', 'book-imported'])

const searchText = ref('')
const activeFilter = ref('全部')
const filters = ['全部', '技术', '人工智能', '产品设计', '通用能力']
const categories = filters.slice(1)
const isImporterOpen = ref(false)
const courseTitle = ref('')
const courseCategory = ref('人工智能')
const selectedFiles = ref([])
const isSaving = ref(false)
const importError = ref('')
const importNotice = ref('')
const folderInput = ref(null)
const filesInput = ref(null)

const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })

const visibleBooks = computed(() => {
  const query = searchText.value.trim().toLocaleLowerCase()
  return props.books.filter((book) => {
    const chapterNames = (book.documents || []).map((document) => document.title).join(' ')
    const matchesQuery = !query || `${book.title} ${book.subtitle || ''} ${book.category || ''} ${chapterNames}`.toLocaleLowerCase().includes(query)
    const matchesFilter = activeFilter.value === '全部' || book.category === activeFilter.value
    return matchesQuery && matchesFilter
  })
})

const selectedMarkdownFiles = computed(() => selectedFiles.value.length)

function startImport() {
  isImporterOpen.value = true
  importError.value = ''
  importNotice.value = ''
}

function closeImporter() {
  if (isSaving.value) return
  isImporterOpen.value = false
  selectedFiles.value = []
  courseTitle.value = ''
  importError.value = ''
}

function validMarkdownFiles(fileList) {
  return Array.from(fileList || []).filter((file) => /\.(md|markdown)$/i.test(file.name))
}

function acceptFiles(fileList) {
  const files = validMarkdownFiles(fileList)
  if (!files.length) {
    selectedFiles.value = []
    importError.value = '没有找到 Markdown 文件，请选择包含 .md 文件的课程目录或文件。'
    return
  }

  selectedFiles.value = files.sort((a, b) => collator.compare(a.webkitRelativePath || a.name, b.webkitRelativePath || b.name))
  importError.value = ''
  importNotice.value = ''

  const relativePath = selectedFiles.value[0].webkitRelativePath
  const folderName = relativePath?.split('/').filter(Boolean)[0]
  if (!courseTitle.value) {
    courseTitle.value = folderName || (selectedFiles.value.length === 1 ? fileTitle(selectedFiles.value[0].name) : '我的 AI 学习课程')
  }
}

function fileTitle(filename) {
  return filename.replace(/\.(md|markdown)$/i, '').trim() || '未命名章节'
}

function chapterTitle(markdown, filename) {
  const heading = markdown.match(/^\s*#\s+(.+?)\s*#*\s*$/m)?.[1]
  return heading?.trim() || fileTitle(filename)
}

function makeId() {
  return globalThis.crypto?.randomUUID?.() || `course-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

async function importCourse() {
  if (!selectedFiles.value.length || !courseTitle.value.trim() || isSaving.value) return
  isSaving.value = true
  importError.value = ''

  try {
    const documents = await Promise.all(selectedFiles.value.map(async (file, index) => {
      const content = await file.text()
      return {
        id: makeId(),
        title: chapterTitle(content, file.name),
        content,
        order: index,
      }
    }))

    const title = courseTitle.value.trim()
    const now = new Date().toISOString()
    const book = {
      id: makeId(),
      title,
      coverTitle: title,
      subtitle: `AI 课程 · ${documents.length} 篇 Markdown 文档`,
      theme: 'blue',
      category: courseCategory.value,
      chapters: documents.length,
      progress: 0,
      lastRead: false,
      imported: true,
      documents,
      createdAt: now,
      updatedAt: now,
    }

    await saveImportedBook(book)
    emit('book-imported', book)
    closeImporter()
    importNotice.value = `《${title}》已加入书架。`
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
      <button class="button button-primary add-book-button" @click="startImport"><Icon name="plus" size="17" /> 添加一本书</button>
    </header>

    <div v-if="importNotice" class="import-notice" role="status"><span class="import-notice-dot"></span>{{ importNotice }}<button aria-label="关闭提示" @click="importNotice = ''">×</button></div>

    <section class="shelf-toolbar">
      <div class="filter-pills" role="tablist" aria-label="书籍分类">
        <button v-for="filter in filters" :key="filter" class="filter-pill" :class="{ 'filter-pill--active': activeFilter === filter }" @click="activeFilter = filter">{{ filter }}<span v-if="filter === '全部'">{{ books.length }}</span></button>
      </div>
      <div class="shelf-actions">
        <label class="search-field shelf-search"><Icon name="search" size="17" /><input v-model="searchText" type="search" placeholder="搜索书名或章节..." /></label>
        <button class="icon-button sort-button" aria-label="筛选与排序"><Icon name="filter" size="19" /></button>
      </div>
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
          <div class="book-card-title-row"><button class="book-card-title-button" @click="emit('open-book', book)"><h2>{{ book.title }}</h2><p>{{ book.subtitle }}</p></button><button class="card-more-button" aria-label="更多操作" @click.stop><Icon name="more" size="18" /></button></div>
          <div class="book-card-meta"><span>{{ book.chapters }} 个章节</span><span class="meta-dot">·</span><span>{{ book.progress }}% 已读</span><span v-if="book.imported" class="imported-label">已导入</span></div>
          <div class="progress-track book-progress"><span :style="{ width: `${book.progress}%` }"></span></div>
        </div>
      </article>
    </section>
    <div v-else class="empty-state surface-card"><span class="empty-state-icon"><Icon name="search" size="22" /></span><h2>没有找到这本书</h2><p>试试其他关键词或分类。</p><button class="text-button" @click="searchText = ''; activeFilter = '全部'">清除筛选</button></div>

    <footer class="shelf-footer"><span>共 {{ visibleBooks.length }} 本学习书籍</span><span>每门课程，都有自己的阅读节奏。</span></footer>

    <div v-if="isImporterOpen" class="importer-backdrop" @click.self="closeImporter">
      <section class="importer-dialog" role="dialog" aria-modal="true" aria-labelledby="importer-title">
        <header class="importer-header"><div><span class="importer-kicker">课程导入</span><h2 id="importer-title">把一门课程装进书架</h2><p>选择课程文件夹，或一次选中多篇 Markdown。文件会按名称自然排序。</p></div><button class="importer-close" aria-label="关闭导入窗口" @click="closeImporter">×</button></header>

        <div class="importer-source-options">
          <button class="importer-source" @click="folderInput?.click()"><span class="source-icon"><Icon name="shelf" size="20" /></span><span><strong>选择课程文件夹</strong><small>自动收集文件夹中的 .md 文档</small></span><Icon name="chevronRight" size="16" /></button>
          <button class="importer-source" @click="filesInput?.click()"><span class="source-icon source-icon--blue"><Icon name="notes" size="19" /></span><span><strong>选择多篇 Markdown</strong><small>将所选文档合并为一本课程书</small></span><Icon name="chevronRight" size="16" /></button>
          <input ref="folderInput" class="visually-hidden-input" type="file" webkitdirectory multiple accept=".md,.markdown,text/markdown" @change="acceptFiles($event.target.files); $event.target.value = ''" />
          <input ref="filesInput" class="visually-hidden-input" type="file" multiple accept=".md,.markdown,text/markdown" @change="acceptFiles($event.target.files); $event.target.value = ''" />
        </div>

        <div v-if="selectedMarkdownFiles" class="importer-form">
          <label class="importer-field"><span>课程名称</span><input v-model="courseTitle" type="text" maxlength="100" placeholder="例如：RAG 工程学习手册" /></label>
          <label class="importer-field"><span>书架分类</span><select v-model="courseCategory"><option v-for="category in categories" :key="category" :value="category">{{ category }}</option></select></label>
          <div class="document-preview"><div class="document-preview-heading"><strong>章节预览</strong><span>{{ selectedMarkdownFiles }} 篇文档</span></div><ol><li v-for="(file, index) in selectedFiles.slice(0, 4)" :key="`${file.name}-${index}`">{{ fileTitle(file.name) }}</li></ol><small v-if="selectedMarkdownFiles > 4">以及另外 {{ selectedMarkdownFiles - 4 }} 篇章节</small></div>
        </div>

        <p v-if="importError" class="importer-error" role="alert">{{ importError }}</p>
        <footer class="importer-footer"><span class="importer-storage-note"><Icon name="bookmark" size="14" /> 内容保存在此设备的浏览器中</span><div><button class="button button-secondary" :disabled="isSaving" @click="closeImporter">取消</button><button class="button button-primary" :disabled="!selectedMarkdownFiles || !courseTitle.trim() || isSaving" @click="importCourse">{{ isSaving ? '正在导入…' : '导入到书架' }}</button></div></footer>
      </section>
    </div>
  </main>
</template>

<style scoped>
.import-notice { display: flex; align-items: center; gap: 9px; margin: -8px 0 17px; padding: 10px 13px; border: 1px solid #d9eadf; border-radius: 11px; color: #426c50; background: #f2faf4; font-size: 12px; }
.import-notice-dot { width: 7px; height: 7px; border-radius: 50%; background: #55a76b; }
.import-notice button { margin-left: auto; border: 0; color: inherit; background: transparent; font-size: 18px; cursor: pointer; }
.imported-label { margin-left: auto; color: #8d98a7; font-size: 9px; }
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
.document-preview ol { display: grid; gap: 5px; margin: 10px 0 0; padding-left: 19px; color: #718096; font-size: 11px; }
.document-preview small { display: block; margin-top: 7px; color: #9aa4b1; font-size: 10px; }
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
  .document-preview { grid-column: 1; }
  .importer-footer { align-items: flex-start; flex-direction: column; }
  .importer-footer > div { width: 100%; }
  .importer-footer .button { flex: 1; }
}
</style>
