<script setup>
import { computed, ref, watch } from 'vue'
import MarkdownNoteInput from './MarkdownNoteInput.vue'
import { deleteLegacyReadingNote, listLegacyReadingNotes } from '../services/legacyEbookStore.js'
import { deleteLocalRecord, getLocalRecord, getLocalRecords, saveLocalRecord } from '../services/localDataStore.js'
import { createReviewCardFromQuote } from '../services/readingCaptures.js'
import { renderNoteInline } from '../services/noteMarkdown.js'

const props = defineProps({
  open: { type: Boolean, default: false },
  book: { type: Object, default: null },
  anchor: { type: [Object, String, Number], default: null },
  excerpt: { type: String, default: '' },
  chapterId: { type: String, default: '' },
  chapterTitle: { type: String, default: '' },
})

const emit = defineEmits(['close', 'jump'])

const notes = ref([])
const content = ref('')
const excerpt = ref('')
const color = ref('yellow')
const draftAnchor = ref(null)
const draftChapterId = ref('')
const draftChapterTitle = ref('')
const editingId = ref('')
const confirmDeleteId = ref('')
const isSaving = ref(false)
const errorMessage = ref('')
const cardBusyId = ref('')
const cardNotice = ref('')

const bookId = computed(() => props.book?.id || props.book?.bookId || '')
const bookTitle = computed(() => props.book?.title || props.book?.name || '未命名书籍')
const format = computed(() => props.book?.format || 'markdown')
const isEditing = computed(() => Boolean(editingId.value))

watch(() => [props.open, bookId.value], async ([open]) => {
  if (!open) return
  resetDraft()
  excerpt.value = props.excerpt || ''
  await refreshNotes()
})

function resetDraft() {
  content.value = ''
  excerpt.value = props.excerpt || ''
  color.value = 'yellow'
  editingId.value = ''
  confirmDeleteId.value = ''
  errorMessage.value = ''
  draftAnchor.value = props.anchor
  draftChapterId.value = props.chapterId
  draftChapterTitle.value = props.chapterTitle
}

function closePanel() {
  if (isSaving.value) return
  emit('close')
}

async function refreshNotes() {
  if (!bookId.value) {
    notes.value = []
    errorMessage.value = '当前书籍没有稳定标识，暂时无法保存笔记。'
    return
  }
  try {
    const legacyNotes = await listLegacyReadingNotes(bookId.value)
    for (const legacy of legacyNotes) {
      if (!getLocalRecord('note', legacy.id)) {
        await saveLocalRecord('note', legacy.id, {
          title: `${legacy.chapterTitle || bookTitle.value} · 摘录`.slice(0, 120),
          content: String(legacy.content || '').trim(),
          excerpt: String(legacy.excerpt || '').trim(),
          bookId: legacy.bookId,
          chapterId: legacy.chapterId || '',
          chapterTitle: legacy.chapterTitle || '',
          format: legacy.format || 'markdown',
          anchor: legacy.anchor || null,
          color: legacy.color || 'yellow',
          createdAt: legacy.createdAt || new Date().toISOString(),
          updatedAt: legacy.updatedAt || legacy.createdAt || new Date().toISOString(),
        })
      }
      await deleteLegacyReadingNote(legacy.id)
    }

    notes.value = getLocalRecords('note').filter((note) => note.bookId === bookId.value)
  } catch (error) {
    errorMessage.value = error?.message || '暂时无法读取本机笔记。'
  }
}

async function saveNote() {
  if (isSaving.value || (!content.value.trim() && !excerpt.value.trim())) return
  isSaving.value = true
  errorMessage.value = ''

  try {
    const now = new Date().toISOString()
    const id = editingId.value || globalThis.crypto?.randomUUID?.() || `note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const existing = notes.value.find((note) => note.id === id)
    await saveLocalRecord('note', id, {
      title: existing?.title || `${draftChapterTitle.value || bookTitle.value} · 摘录`.slice(0, 120),
      content: content.value.trim(),
      excerpt: excerpt.value.trim(),
      bookId: bookId.value,
      chapterId: draftChapterId.value,
      chapterTitle: draftChapterTitle.value,
      format: format.value,
      anchor: draftAnchor.value,
      color: color.value,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    })
    resetDraft()
    await refreshNotes()
  } catch (error) {
    errorMessage.value = error?.message || '保存失败，请稍后重试。'
  } finally {
    isSaving.value = false
  }
}

function editNote(note) {
  editingId.value = note.id
  content.value = note.content || ''
  excerpt.value = note.excerpt || ''
  color.value = note.color || 'yellow'
  draftAnchor.value = note.anchor || null
  draftChapterId.value = note.chapterId || ''
  draftChapterTitle.value = note.chapterTitle || ''
  errorMessage.value = ''
}

function cancelEdit() {
  resetDraft()
}

async function toggleDelete(note) {
  if (confirmDeleteId.value !== note.id) {
    confirmDeleteId.value = note.id
    return
  }

  try {
    await deleteLocalRecord('note', note.id)
    confirmDeleteId.value = ''
    if (editingId.value === note.id) resetDraft()
    await refreshNotes()
  } catch (error) {
    errorMessage.value = error?.message || '删除失败，请稍后重试。'
  }
}

function jumpToNote(note) {
  if (isSaving.value) return
  emit('jump', note.anchor, note)
  emit('close')
}

async function makeCardFromNote(note) {
  if (cardBusyId.value) return
  cardBusyId.value = note.id
  cardNotice.value = ''
  try {
    await createReviewCardFromQuote({
      bookId: note.bookId,
      chapterId: note.chapterId,
      front: note.excerpt || note.title,
      back: note.content || '',
    })
    cardNotice.value = '已生成一张复习卡，到期后出现在复习队列。'
  } catch (error) {
    cardNotice.value = ''
    errorMessage.value = error?.message || '复习卡没有生成成功，请稍后重试。'
  } finally {
    cardBusyId.value = ''
  }
}

function formatDate(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric' }).format(date)
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="reading-notes-scrim" @click.self="closePanel" @keyup.esc="closePanel">
      <aside class="reading-notes-panel" role="dialog" aria-modal="true" aria-labelledby="reading-notes-title">
        <header class="reading-notes-header">
          <div>
            <p>阅读摘录</p>
            <h2 id="reading-notes-title">{{ bookTitle }} 的笔记</h2>
          </div>
          <button class="reading-notes-close" type="button" aria-label="关闭笔记" :disabled="isSaving" @click="closePanel">×</button>
        </header>

        <div class="reading-notes-compose">
          <div v-if="excerpt" class="reading-notes-quote">
            <span>摘录</span>
            <blockquote>{{ excerpt }}</blockquote>
          </div>
          <div class="reading-notes-field">
            <span>{{ isEditing ? '编辑笔记' : '写下你的想法' }}</span>
            <MarkdownNoteInput v-model="content" :rows="4" placeholder="记录理解、疑问或下一步行动…" :disabled="isSaving" />
          </div>
          <label v-if="!excerpt" class="reading-notes-field reading-notes-excerpt-field">
            <span>摘录原文 <em>可选</em></span>
            <textarea v-model="excerpt" rows="2" maxlength="3000" placeholder="粘贴想稍后回看的内容" :disabled="isSaving" />
          </label>
          <div class="reading-notes-compose-footer">
            <div class="reading-notes-colors" role="group" aria-label="笔记标记颜色">
              <button v-for="option in ['yellow', 'blue', 'green', 'pink']" :key="option" type="button" :class="[`note-color-${option}`, { selected: color === option }]" :aria-label="`${option} 标记`" :aria-pressed="color === option" :disabled="isSaving" @click="color = option" />
            </div>
            <div class="reading-notes-compose-actions">
                <button v-if="isEditing" class="quiet-action" type="button" :disabled="isSaving" @click="cancelEdit">取消编辑</button>
              <button class="save-action" type="button" :disabled="isSaving || (!content.trim() && !excerpt.trim())" @click="saveNote">
                {{ isSaving ? '保存中…' : isEditing ? '保存修改' : '保存笔记' }}
              </button>
            </div>
          </div>
        </div>

        <div class="reading-notes-list-heading">
          <h3>本书笔记</h3>
          <span>{{ notes.length }}</span>
        </div>
        <div v-if="notes.length" class="reading-notes-list">
          <article v-for="note in notes" :key="note.id" class="reading-note-card" :class="`note-card-${note.color || 'yellow'}`">
            <button class="reading-note-main" type="button" @click="jumpToNote(note)">
              <span v-if="note.excerpt" class="reading-note-excerpt">{{ note.excerpt }}</span>
              <span v-if="note.content" class="reading-note-content" v-html="renderNoteInline(note.content)"></span>
              <span class="reading-note-location">{{ note.chapterTitle || (note.format === 'pdf' && note.anchor?.page ? `第 ${note.anchor.page} 页` : '阅读摘录') }}</span>
            </button>
            <footer>
              <time :datetime="note.updatedAt">{{ formatDate(note.updatedAt) }}</time>
              <div>
                <button type="button" :disabled="isSaving || cardBusyId === note.id" @click="makeCardFromNote(note)">
                  {{ cardBusyId === note.id ? '生成中…' : '制作复习卡' }}
                </button>
                <button type="button" :disabled="isSaving" @click="editNote(note)">编辑</button>
                <button type="button" class="delete-note-action" :disabled="isSaving" @click="toggleDelete(note)">
                  {{ confirmDeleteId === note.id ? '再点一次删除' : '删除' }}
                </button>
              </div>
            </footer>
          </article>
        </div>
        <div v-else class="reading-notes-empty">
          <span aria-hidden="true">✎</span>
          <strong>还没有阅读笔记</strong>
          <p>选中一段内容，或在上方写下第一条想法。</p>
        </div>

        <p v-if="errorMessage" class="reading-notes-error" role="alert">{{ errorMessage }}</p>
        <p v-else-if="cardNotice" class="reading-notes-card-notice" role="status">{{ cardNotice }}</p>
        <p class="reading-notes-local-hint">笔记只保存在本机，可以随时回来继续整理。</p>
      </aside>
    </div>
  </Teleport>
</template>

<style scoped>
.reading-notes-scrim { position: fixed; z-index: 1001; inset: 0; display: flex; justify-content: flex-end; background: rgb(23 27 34 / 28%); backdrop-filter: blur(4px); animation: notes-scrim-in 140ms ease-out; }
.reading-notes-panel { display: flex; width: min(100%, 440px); height: 100%; flex-direction: column; padding: 26px; overflow: auto; background: #fff; box-shadow: -18px 0 56px rgb(19 28 44 / 12%); color: #292d34; animation: notes-panel-in 180ms cubic-bezier(.2,.8,.2,1); }
.reading-notes-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; padding-bottom: 20px; border-bottom: 1px solid #f0f1f3; }
.reading-notes-header p { margin: 0 0 6px; color: #8b9099; font-size: 12.5px; font-weight: 600; letter-spacing: .04em; }
.reading-notes-header h2 { margin: 0; color: #282c33; font-size: 19px; font-weight: 650; letter-spacing: -.025em; }
.reading-notes-close { display: grid; width: 32px; height: 32px; place-items: center; flex: 0 0 auto; border: 0; border-radius: 50%; background: #f4f5f6; color: #636871; cursor: pointer; font-size: 22px; line-height: 1; }
.reading-notes-close:hover { background: #e9ebee; }
.reading-notes-compose { padding: 20px 0 18px; border-bottom: 1px solid #f0f1f3; }
.reading-notes-field { display: grid; gap: 8px; color: #626873; font-size: 12.5px; font-weight: 600; }
.reading-notes-field em { color: #a5a9b1; font-style: normal; font-weight: 400; }
.reading-notes-field textarea { width: 100%; resize: vertical; min-height: 88px; padding: 11px 12px; border: 1px solid #e6e8ec; border-radius: 12px; background: #fbfbfc; color: #343941; font: inherit; font-size: 13px; font-weight: 400; line-height: 1.65; }
.reading-notes-field textarea:focus { border-color: #a8b9e2; background: #fff; outline: 3px solid rgb(82 117 190 / 11%); }
.reading-notes-field textarea::placeholder { color: #a8adb5; }
.reading-notes-quote { margin-bottom: 14px; padding: 12px 14px; border-left: 3px solid #d9c782; border-radius: 0 10px 10px 0; background: #fbf9f1; }
.reading-notes-quote span { color: #999071; font-size: 12px; font-weight: 650; }
.reading-notes-quote blockquote { margin: 5px 0 0; color: #555045; font-size: 13.5px; line-height: 1.65; }
.reading-notes-excerpt-field { margin-top: 12px; }
.reading-notes-excerpt-field textarea { min-height: 60px; }
.reading-notes-compose-footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 12px; }
.reading-notes-colors { display: flex; align-items: center; gap: 7px; }
.reading-notes-colors button { width: 17px; height: 17px; padding: 0; border: 2px solid #fff; border-radius: 50%; box-shadow: 0 0 0 1px #dadddf; cursor: pointer; }
.reading-notes-colors button.selected { box-shadow: 0 0 0 2px #727881; }
.reading-notes-colors button:disabled, .reading-notes-compose-actions button:disabled, .reading-notes-close:disabled, .reading-note-card footer button:disabled { cursor: wait; opacity: .55; }
.note-color-yellow { background: #e9d98e; }.note-color-blue { background: #a9c6ea; }.note-color-green { background: #afd1b8; }.note-color-pink { background: #edbdc7; }
.reading-notes-compose-actions { display: flex; gap: 8px; }
.reading-notes-compose-actions button { height: 33px; padding: 0 11px; border: 0; border-radius: 9px; cursor: pointer; font: inherit; font-size: 12.5px; font-weight: 600; }
.quiet-action { background: #f2f3f5; color: #676c74; }.save-action { background: #293241; color: #fff; }.save-action:disabled { cursor: not-allowed; opacity: .42; }
.reading-notes-list-heading { display: flex; align-items: center; justify-content: space-between; padding: 18px 0 10px; }
.reading-notes-list-heading h3 { margin: 0; color: #515762; font-size: 13.5px; font-weight: 650; }
.reading-notes-list-heading span { display: grid; min-width: 22px; height: 22px; place-items: center; border-radius: 11px; background: #f2f3f5; color: #7d838c; font-size: 12px; }
.reading-notes-list { display: grid; gap: 9px; }
.reading-note-card { overflow: hidden; border: 1px solid #ece9de; border-radius: 12px; background: #fffdf5; }
.note-card-blue { border-color: #e0e8f2; background: #f8fbff; }.note-card-green { border-color: #dfebe1; background: #f8fcf8; }.note-card-pink { border-color: #f0e1e4; background: #fffafb; }
.reading-note-main { display: grid; width: 100%; gap: 7px; padding: 12px 13px 8px; border: 0; background: transparent; color: inherit; cursor: pointer; text-align: left; }
.reading-note-main:hover .reading-note-content { color: #315cb3; }
.reading-note-excerpt { display: -webkit-box; overflow: hidden; color: #77735f; font-size: 12.5px; line-height: 1.55; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.reading-note-content { display: -webkit-box; overflow: hidden; color: #41454c; font-size: 13.5px; line-height: 1.6; white-space: pre-wrap; -webkit-box-orient: vertical; -webkit-line-clamp: 4; }
.reading-note-content :deep(code) { padding: .08em .3em; border-radius: 4px; color: #536176; background: #edf0f4; font: .94em Consolas, monospace; }
.reading-note-content :deep(.note-markdown-link) { color: #5684c7; text-decoration: underline; text-underline-offset: 2px; }
.reading-note-location { color: #9a9da3; font-size: 12px; }
.reading-note-card footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 7px 12px 10px; }
.reading-note-card footer time { color: #a2a5ab; font-size: 11px; }
.reading-note-card footer div { display: flex; gap: 5px; }
.reading-note-card footer button { padding: 4px 6px; border: 0; border-radius: 6px; background: transparent; color: #797f88; cursor: pointer; font: inherit; font-size: 12px; }
.reading-note-card footer button:hover { background: rgb(0 0 0 / 5%); color: #30353d; }.reading-note-card footer .delete-note-action { color: #bd7068; }
.reading-notes-empty { display: grid; min-height: 136px; align-content: center; justify-items: center; gap: 5px; color: #969ba4; text-align: center; }
.reading-notes-empty span { margin-bottom: 3px; color: #bcc1c9; font-size: 22px; }
.reading-notes-empty strong { color: #656b75; font-size: 13.5px; font-weight: 600; }
.reading-notes-empty p { margin: 0; font-size: 12px; }
.reading-notes-error { margin: 10px 0 0; color: #ae473e; font-size: 12.5px; line-height: 1.5; }
.reading-notes-card-notice { margin: 10px 0 0; color: #5a8d6a; font-size: 12.5px; line-height: 1.5; }
.reading-notes-local-hint { margin: auto 0 0; padding-top: 18px; color: #a0a4aa; font-size: 12px; text-align: center; }
.reading-notes-panel button:focus-visible { outline: 3px solid rgb(70 111 208 / 32%); outline-offset: 2px; }
@keyframes notes-scrim-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes notes-panel-in { from { opacity: .6; transform: translateX(9px); } to { opacity: 1; transform: translateX(0); } }
@media (max-width: 560px) { .reading-notes-panel { width: 100%; padding: 21px 18px; } }
@media (prefers-reduced-motion: reduce) { .reading-notes-scrim, .reading-notes-panel { animation: none; } }
</style>
