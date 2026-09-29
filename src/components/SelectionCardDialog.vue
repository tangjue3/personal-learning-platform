<script setup>
import { nextTick, ref, watch } from 'vue'
import Icon from './Icon.vue'

const props = defineProps({
  open: { type: Boolean, default: false },
  quote: { type: String, default: '' },
  source: { type: String, default: '' },
})
const emit = defineEmits(['close', 'save'])

const front = ref('')
const back = ref('')
const busy = ref(false)
const saveError = ref('')
const backField = ref(null)

watch(() => props.open, (open) => {
  if (!open) return
  front.value = props.quote
  back.value = ''
  busy.value = false
  saveError.value = ''
  nextTick(() => backField.value?.focus())
})

async function save() {
  if (busy.value || !front.value.trim()) return
  busy.value = true
  saveError.value = ''
  try {
    await new Promise((resolve, reject) => {
      emit('save', { front: front.value.trim(), back: back.value, resolve, reject })
    })
    emit('close')
  } catch (error) { saveError.value = error?.message || '保存失败，请稍后重试。' }
  finally { busy.value = false }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="card-dialog-backdrop" @click.self="emit('close')">
      <form class="card-dialog" role="dialog" aria-modal="true" aria-labelledby="selection-card-title" @submit.prevent="save">
        <header>
          <div><span class="section-kicker">{{ source || '阅读原文' }}</span><h2 id="selection-card-title">把这段原文变成复习卡</h2></div>
          <button type="button" class="icon-button" aria-label="关闭" :disabled="busy" @click="emit('close')"><Icon name="close" size="17" /></button>
        </header>
        <div class="card-dialog-quote"><span>原文</span><blockquote>{{ quote }}</blockquote></div>
        <label class="card-dialog-field"><span>卡片正面 · 回忆问题</span><textarea v-model="front" rows="3" maxlength="2000" :disabled="busy" placeholder="默认是原文，可改成一个自问的问题" /></label>
        <label class="card-dialog-field"><span>卡片背面 · 我的理解 <em>可选</em></span><textarea ref="backField" v-model="back" rows="3" maxlength="4000" :disabled="busy" placeholder="写下答案、解释或为什么重要" /></label>
        <p class="card-dialog-hint">卡片会立刻进入复习队列，正面默认展示原文，靠回忆巩固。</p>
        <p v-if="saveError" class="card-dialog-error" role="alert">{{ saveError }}</p>
        <footer>
          <button type="button" class="button button-secondary" :disabled="busy" @click="emit('close')">取消</button>
          <button type="submit" class="button button-primary" :disabled="busy || !front.trim()">{{ busy ? '正在保存…' : '生成复习卡' }}</button>
        </footer>
      </form>
    </div>
  </Teleport>
</template>

<style scoped>
.card-dialog-backdrop { position: fixed; z-index: 1002; inset: 0; display: grid; place-items: center; padding: 18px; background: rgba(25, 36, 51, .3); backdrop-filter: blur(6px); }
.card-dialog { width: min(100%, 470px); max-height: min(90vh, 720px); display: grid; gap: 13px; overflow: auto; padding: 22px; border: 1px solid rgba(255, 255, 255, .8); border-radius: 17px; background: #fff; box-shadow: 0 22px 70px rgba(26, 44, 70, .18); }
.card-dialog header { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
.card-dialog header h2 { margin: 5px 0 2px; color: #354155; font-size: 17px; }
.card-dialog-quote { padding: 12px 14px; border-left: 3px solid #d9c782; border-radius: 0 10px 10px 0; background: #fbf9f1; }
.card-dialog-quote span { color: #999071; font-size: 12px; font-weight: 650; }
.card-dialog-quote blockquote { margin: 5px 0 0; color: #555045; font-size: 13px; line-height: 1.65; white-space: pre-wrap; overflow-wrap: anywhere; }
.card-dialog-field { display: grid; gap: 6px; color: #687589; font-size: 11px; font-weight: 600; }
.card-dialog-field em { color: #a5a9b1; font-style: normal; font-weight: 400; }
.card-dialog-field textarea { width: 100%; box-sizing: border-box; padding: 9px 10px; border: 1px solid #e5e9ee; border-radius: 8px; outline: 0; color: #47566a; background: #fff; font: inherit; font-size: 12px; line-height: 1.6; resize: vertical; }
.card-dialog-field textarea:focus { border-color: #a8c3eb; box-shadow: 0 0 0 3px rgba(87, 137, 211, .1); }
.card-dialog-hint { margin: 0; color: #9aa4b1; font-size: 11.5px; line-height: 1.6; }
.card-dialog-error { margin: 0; color: #b65f58; font-size: 12px; }
.card-dialog footer { display: flex; justify-content: flex-end; gap: 8px; padding-top: 3px; }
.card-dialog .button { min-height: 34px; font-size: 11px; }
.card-dialog .button:disabled { opacity: .55; cursor: wait; }
@media (max-width: 560px) { .card-dialog-backdrop { align-items: end; padding: 0; } .card-dialog { width: 100%; max-height: 88vh; border-radius: 17px 17px 0 0; } }
</style>
