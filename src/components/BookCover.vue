<script setup>
defineProps({
  book: { type: Object, required: true },
  compact: { type: Boolean, default: false },
})
</script>

<template>
  <div class="book-cover" :class="[`cover--${book.theme || 'blue'}`, { 'book-cover--compact': compact }]">
    <div class="cover-topline"><span class="cover-mark"></span><span>{{ book.eyebrow || '学习手册' }}</span></div>
    <div class="cover-copy">
      <strong>{{ book.coverTitle || book.title }}</strong>
      <span>{{ book.subtitle }}</span>
    </div>
    <div class="cover-art" aria-hidden="true">
      <span class="cover-orbit cover-orbit--one"></span>
      <span class="cover-orbit cover-orbit--two"></span>
      <span class="cover-landscape"></span>
    </div>
    <span class="cover-edition">{{ book.edition || 'LEARNING SERIES' }}</span>
  </div>
</template>
