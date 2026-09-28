<script setup>
import { computed, ref } from 'vue'
import { renderNoteMarkdown } from '../services/noteMarkdown.js'

const props = defineProps({
  modelValue: { type: String, default: '' },
  rows: { type: Number, default: 6 },
  placeholder: { type: String, default: '写下笔记…' },
})
const emit = defineEmits(['update:modelValue'])
const mode = ref('edit')
const previewHtml = computed(() => renderNoteMarkdown(props.modelValue))
</script>

<template>
  <div class="markdown-note-editor">
    <div class="markdown-note-toolbar">
      <div role="group" aria-label="笔记显示模式">
        <button type="button" :class="{ selected: mode === 'edit' }" :aria-pressed="mode === 'edit'" @click="mode = 'edit'">编辑</button>
        <button type="button" :class="{ selected: mode === 'preview' }" :aria-pressed="mode === 'preview'" @click="mode = 'preview'">预览</button>
      </div>
      <span>支持标题、列表、引用与代码</span>
    </div>
    <textarea
      v-if="mode === 'edit'"
      :value="modelValue"
      :rows="rows"
      :placeholder="placeholder"
      @input="emit('update:modelValue', $event.target.value)"
    ></textarea>
    <div v-else class="markdown-note-preview">
      <div v-if="modelValue.trim()" v-html="previewHtml"></div>
      <p v-else class="markdown-note-empty">写下内容后即可在这里预览。</p>
    </div>
  </div>
</template>

<style scoped>
.markdown-note-editor { overflow: hidden; border: 1px solid #e6e8ec; border-radius: 12px; background: #fbfbfc; }
.markdown-note-toolbar { min-height: 38px; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 5px 8px; border-bottom: 1px solid #eceef1; }
.markdown-note-toolbar > div { display: inline-flex; gap: 3px; padding: 2px; border-radius: 8px; background: #f0f2f5; }
.markdown-note-toolbar button { min-height: 25px; padding: 0 9px; border: 0; border-radius: 6px; color: #848c98; background: transparent; font: inherit; font-size: 10px; cursor: pointer; }
.markdown-note-toolbar button.selected { color: #4c5f79; background: #fff; box-shadow: 0 1px 3px rgb(35 48 64 / 9%); }
.markdown-note-toolbar > span { color: #a0a6af; font-size: 9px; }
.markdown-note-editor textarea { display: block; width: 100%; min-height: 112px; padding: 11px 12px; resize: vertical; border: 0; outline: 0; background: transparent; color: #343941; font: inherit; font-size: 13px; font-weight: 400; line-height: 1.65; }
.markdown-note-editor textarea::placeholder { color: #a8adb5; }
.markdown-note-preview { min-height: 112px; max-height: 360px; padding: 12px 13px; overflow: auto; color: #4e5968; font-size: 12px; font-weight: 400; line-height: 1.75; overflow-wrap: anywhere; }
.markdown-note-preview :deep(p) { margin: 0 0 10px; }
.markdown-note-preview :deep(p:last-child) { margin-bottom: 0; }
.markdown-note-preview :deep(h1), .markdown-note-preview :deep(h2), .markdown-note-preview :deep(h3), .markdown-note-preview :deep(h4) { margin: 15px 0 7px; color: #39475b; line-height: 1.4; }
.markdown-note-preview :deep(h1) { font-size: 18px; }.markdown-note-preview :deep(h2) { font-size: 16px; }.markdown-note-preview :deep(h3), .markdown-note-preview :deep(h4) { font-size: 14px; }
.markdown-note-preview :deep(ul), .markdown-note-preview :deep(ol) { margin: 6px 0 11px; padding-left: 1.5em; }
.markdown-note-preview :deep(blockquote) { margin: 9px 0; padding: 6px 11px; border-left: 3px solid #b9c9dc; color: #69788d; background: #f1f5fa; }
.markdown-note-preview :deep(blockquote p) { margin: 0; }
.markdown-note-preview :deep(pre) { margin: 9px 0; padding: 10px 11px; overflow: auto; border-radius: 8px; color: #536176; background: #eef1f5; font: 11px/1.65 Consolas, monospace; }
.markdown-note-preview :deep(code) { padding: .08em .3em; border-radius: 4px; color: #536176; background: #edf0f4; font: .92em Consolas, monospace; }
.markdown-note-preview :deep(pre code) { padding: 0; background: transparent; }
.markdown-note-preview :deep(a) { color: #4b83c8; text-decoration: underline; text-underline-offset: 2px; }
.markdown-note-preview :deep(hr) { margin: 13px 0; border: 0; border-top: 1px solid #e4e8ed; }
.markdown-note-empty { margin: 0; color: #a2a8b1; }
</style>
