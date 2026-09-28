<script setup>
import { computed, ref, watch } from 'vue'
import { saveEbookFile } from '../services/ebookFileStore.js'

const props = defineProps({
  open: { type: Boolean, default: false },
})

const emit = defineEmits(['close', 'imported', 'open-existing'])

const fileInput = ref(null)
const selectedFile = ref(null)
const title = ref('')
const author = ref('')
const errorMessage = ref('')
const duplicateBook = ref(null)
const isDragging = ref(false)
const isSaving = ref(false)

const format = computed(() => selectedFile.value?.name.split('.').pop()?.toLowerCase() || '')
const formatLabel = computed(() => format.value === 'pdf' ? 'PDF' : format.value === 'epub' ? 'EPUB' : '')

watch(() => props.open, (open) => {
  if (open) {
    errorMessage.value = ''
  } else {
    clearForm()
  }
})

function clearForm() {
  selectedFile.value = null
  title.value = ''
  author.value = ''
  errorMessage.value = ''
  duplicateBook.value = null
  isDragging.value = false
  isSaving.value = false
  if (fileInput.value) fileInput.value.value = ''
}

function closeDialog() {
  if (!isSaving.value) emit('close')
}

function chooseFile(file) {
  if (!file) return
  const extension = file.name.split('.').pop()?.toLowerCase()
  if (!['epub', 'pdf'].includes(extension)) {
    selectedFile.value = null
    title.value = ''
    author.value = ''
    duplicateBook.value = null
    errorMessage.value = '请选择 EPUB 或 PDF 文件。'
    if (fileInput.value) fileInput.value.value = ''
    return
  }

  selectedFile.value = file
  title.value = file.name.replace(/\.[^.]+$/, '')
  author.value = ''
  duplicateBook.value = null
  errorMessage.value = ''
}

function openFilePicker() {
  fileInput.value?.click()
}

function handleDrop(event) {
  isDragging.value = false
  chooseFile(event.dataTransfer?.files?.[0])
}

function formatSize(size) {
  if (!Number.isFinite(size) || size <= 0) return '文件大小未知'
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

async function importBook() {
  if (!selectedFile.value || isSaving.value) return
  isSaving.value = true
  errorMessage.value = ''
  duplicateBook.value = null

  try {
    const id = globalThis.crypto?.randomUUID?.() || `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const savedBook = await saveEbookFile({
      bookId: id,
      file: selectedFile.value,
      format: format.value,
      title: title.value,
      author: author.value,
    })
    emit('imported', { ...savedBook, source: 'local' })
    emit('close')
  } catch (error) {
    duplicateBook.value = error?.duplicateBookId
      ? { id: String(error.duplicateBookId), title: error.duplicateBookTitle || '' }
      : null
    errorMessage.value = duplicateBook.value
      ? `书架中已经有《${duplicateBook.value.title || '这本书'}》。`
      : error?.message || '导入失败，请稍后重试。'
  } finally {
    isSaving.value = false
  }
}

function openExistingBook() {
  if (!duplicateBook.value?.id) return
  emit('open-existing', duplicateBook.value.id)
  emit('close')
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="ebook-import-overlay"
      @click.self="closeDialog"
      @keyup.esc="closeDialog"
    >
      <section
        class="ebook-import-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ebook-import-title"
        aria-describedby="ebook-import-description"
      >
        <header class="ebook-import-header">
          <div>
            <p class="ebook-import-eyebrow">添加到本机书架</p>
            <h2 id="ebook-import-title">导入电子书</h2>
            <p id="ebook-import-description">支持 EPUB 与 PDF，原文件保存在这台电脑的项目目录 data/local/ebooks/ 中。</p>
          </div>
          <button class="ebook-import-close" type="button" aria-label="关闭导入窗口" @click="closeDialog">
            <span aria-hidden="true">×</span>
          </button>
        </header>

        <input
          ref="fileInput"
          class="ebook-import-native-input"
          type="file"
          accept=".epub,.pdf,application/epub+zip,application/pdf"
          @change="chooseFile($event.target.files?.[0])"
        />

        <div
          class="ebook-import-dropzone"
          :class="{ 'is-dragging': isDragging, 'has-file': selectedFile }"
          role="button"
          tabindex="0"
          aria-label="选择 EPUB 或 PDF 文件，也可以拖放到这里"
          @click="openFilePicker"
          @keydown.enter.prevent="openFilePicker"
          @keydown.space.prevent="openFilePicker"
          @dragenter.prevent="isDragging = true"
          @dragover.prevent="isDragging = true"
          @dragleave.prevent="isDragging = false"
          @drop.prevent="handleDrop"
        >
          <template v-if="selectedFile">
            <span class="ebook-import-file-icon" :class="`format-${format}`" aria-hidden="true">{{ formatLabel }}</span>
            <span class="ebook-import-file-details">
              <strong>{{ selectedFile.name }}</strong>
              <small>{{ formatLabel }} · {{ formatSize(selectedFile.size) }}</small>
            </span>
            <span class="ebook-import-change">更换</span>
          </template>
          <template v-else>
            <span class="ebook-import-upload-icon" aria-hidden="true">↑</span>
            <strong>拖放电子书到这里</strong>
            <span>或 <span class="ebook-import-link">从电脑选择</span></span>
            <small>支持 .epub 与 .pdf</small>
          </template>
        </div>

        <div class="ebook-import-fields">
          <label>
            <span>书名</span>
            <input v-model="title" type="text" maxlength="160" placeholder="为这本书命名" :disabled="!selectedFile || isSaving" />
          </label>
          <label>
            <span>作者 <em>可选</em></span>
            <input v-model="author" type="text" maxlength="120" placeholder="填写作者" :disabled="!selectedFile || isSaving" />
          </label>
        </div>

        <div v-if="errorMessage" class="ebook-import-error" role="alert">
          <span>{{ errorMessage }}</span>
          <button v-if="duplicateBook" type="button" @click="openExistingBook">打开已有书籍</button>
        </div>
        <p class="ebook-import-privacy"><span aria-hidden="true">◉</span> 电子书原文件保存在本机目录，不会上传到仓库或 GitHub。</p>

        <footer class="ebook-import-actions">
          <button class="ebook-import-cancel" type="button" :disabled="isSaving" @click="closeDialog">取消</button>
          <button class="ebook-import-submit" type="button" :disabled="!selectedFile || !title.trim() || isSaving" @click="importBook">
            {{ isSaving ? '正在校验并导入…' : '加入书架' }}
          </button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.ebook-import-overlay {
  position: fixed;
  z-index: 1000;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgb(24 27 33 / 38%);
  backdrop-filter: blur(8px);
  animation: ebook-overlay-in 160ms ease-out;
}

.ebook-import-dialog {
  width: min(100%, 520px);
  padding: 30px;
  border: 1px solid rgb(30 34 42 / 7%);
  border-radius: 24px;
  background: #fff;
  box-shadow: 0 28px 80px rgb(17 24 39 / 22%);
  color: #24272d;
  animation: ebook-dialog-in 180ms cubic-bezier(.2, .8, .2, 1);
}

.ebook-import-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
  margin-bottom: 24px;
}

.ebook-import-eyebrow {
  margin: 0 0 7px;
  color: #8a8f98;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: .04em;
}

.ebook-import-header h2 {
  margin: 0;
  color: #22252b;
  font-size: 24px;
  font-weight: 650;
  letter-spacing: -.035em;
}

.ebook-import-header p:last-child {
  margin: 8px 0 0;
  color: #777d86;
  font-size: 13px;
  line-height: 1.6;
}

.ebook-import-close {
  display: grid;
  width: 34px;
  height: 34px;
  place-items: center;
  flex: 0 0 auto;
  border: 0;
  border-radius: 50%;
  background: #f3f4f6;
  color: #60656d;
  cursor: pointer;
  font-size: 23px;
  line-height: 1;
}

.ebook-import-close:hover { background: #e9ebef; }
.ebook-import-close:focus-visible,
.ebook-import-dropzone:focus-visible,
.ebook-import-dialog button:focus-visible,
.ebook-import-dialog input:focus-visible {
  outline: 3px solid rgb(68 118 230 / 35%);
  outline-offset: 2px;
}

.ebook-import-native-input { display: none; }

.ebook-import-dropzone {
  display: flex;
  min-height: 176px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 20px;
  border: 1px dashed #cdd2db;
  border-radius: 18px;
  background: #fafbfc;
  color: #737984;
  cursor: pointer;
  font-size: 13px;
  transition: border-color 160ms ease, background-color 160ms ease;
}

.ebook-import-dropzone:hover,
.ebook-import-dropzone.is-dragging {
  border-color: #7d9be0;
  background: #f5f8ff;
}

.ebook-import-dropzone strong { color: #383d45; font-size: 14px; font-weight: 600; }
.ebook-import-dropzone small { color: #a0a5ad; font-size: 11px; }
.ebook-import-link { color: #426bca; font-weight: 600; }

.ebook-import-upload-icon {
  display: grid;
  width: 38px;
  height: 38px;
  margin-bottom: 3px;
  place-items: center;
  border: 1px solid #e7eaf0;
  border-radius: 12px;
  background: #fff;
  box-shadow: 0 2px 7px rgb(27 39 62 / 5%);
  color: #5478ca;
  font-size: 21px;
}

.ebook-import-dropzone.has-file {
  min-height: 88px;
  flex-direction: row;
  justify-content: flex-start;
  gap: 14px;
  border-style: solid;
  border-color: #e3e6ec;
  background: #fbfbfc;
  cursor: default;
}

.ebook-import-file-icon {
  display: grid;
  width: 44px;
  height: 52px;
  place-items: center;
  flex: 0 0 auto;
  border-radius: 8px 8px 11px 8px;
  background: #eaf0ff;
  color: #486bc0;
  font-size: 10px;
  font-weight: 750;
  letter-spacing: .02em;
}

.ebook-import-file-icon.format-pdf { background: #fff0ed; color: #bd6558; }
.ebook-import-file-details { display: grid; min-width: 0; gap: 5px; flex: 1; text-align: left; }
.ebook-import-file-details strong { overflow: hidden; max-width: 100%; text-overflow: ellipsis; white-space: nowrap; }
.ebook-import-file-details small { color: #969ba3; font-size: 11px; }
.ebook-import-change { color: #4d70c3; font-size: 12px; font-weight: 600; }

.ebook-import-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-top: 22px; }
.ebook-import-fields label { display: grid; gap: 7px; color: #555b64; font-size: 12px; font-weight: 600; }
.ebook-import-fields label em { margin-left: 4px; color: #a2a6ad; font-size: 10px; font-style: normal; font-weight: 400; }
.ebook-import-fields input {
  width: 100%;
  height: 40px;
  padding: 0 12px;
  border: 1px solid #e3e5e9;
  border-radius: 10px;
  background: #fff;
  color: #333840;
  font: inherit;
  font-size: 13px;
}
.ebook-import-fields input::placeholder { color: #b0b4bb; }
.ebook-import-fields input:disabled { background: #f8f9fa; color: #a0a4ac; }

.ebook-import-error { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 14px 0 0; color: #b64036; font-size: 12px; line-height: 1.55; }
.ebook-import-error button { flex: 0 0 auto; padding: 5px 9px; border: 1px solid #e8c4bf; border-radius: 7px; color: #9d4339; background: #fff8f7; font: inherit; font-size: 11px; font-weight: 600; cursor: pointer; }
.ebook-import-privacy { display: flex; align-items: center; gap: 7px; margin: 18px 0 0; color: #878c95; font-size: 11px; }
.ebook-import-privacy span { color: #7b9b87; }

.ebook-import-actions { display: flex; justify-content: flex-end; gap: 9px; margin-top: 24px; }
.ebook-import-actions button { min-width: 86px; height: 38px; padding: 0 16px; border: 0; border-radius: 10px; cursor: pointer; font: inherit; font-size: 12px; font-weight: 600; transition: background-color 150ms ease, opacity 150ms ease; }
.ebook-import-cancel { background: #f2f3f5; color: #5f646d; }
.ebook-import-cancel:hover:not(:disabled) { background: #e9ebee; }
.ebook-import-submit { background: #242a35; color: #fff; }
.ebook-import-submit:hover:not(:disabled) { background: #3b4657; }
.ebook-import-actions button:disabled { cursor: not-allowed; opacity: .45; }

@keyframes ebook-overlay-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes ebook-dialog-in { from { opacity: 0; transform: translateY(7px) scale(.99); } to { opacity: 1; transform: translateY(0) scale(1); } }

@media (max-width: 560px) {
  .ebook-import-overlay { align-items: end; padding: 10px; }
  .ebook-import-dialog { padding: 23px 20px; border-radius: 21px; }
  .ebook-import-fields { grid-template-columns: 1fr; }
}

@media (prefers-reduced-motion: reduce) {
  .ebook-import-overlay,
  .ebook-import-dialog { animation: none; }
  .ebook-import-dropzone,
  .ebook-import-actions button { transition: none; }
}
</style>
