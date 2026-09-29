<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import Icon from './Icon.vue'
import { saveLocalRecord } from '../services/localDataStore.js'

const props = defineProps({
  open: { type: Boolean, default: false },
  task: { type: Object, default: null },
})
const emit = defineEmits(['close', 'saved'])

const titleField = ref(null)
const draft = ref({ title: '', dueDate: '', priority: 'normal' })
const baseline = ref('')
const busy = ref(false)
const error = ref('')
const dirty = computed(() => JSON.stringify(draft.value) !== baseline.value)

watch(() => props.open, (open) => {
  if (open && props.task) resetDraft(props.task)
})
watch(() => props.task, (task) => {
  if (props.open && task) resetDraft(task)
})

function resetDraft(task) {
  draft.value = {
    title: String(task.title || ''),
    dueDate: /^\d{4}-\d{2}-\d{2}$/.test(task.dueDate || '') ? task.dueDate : '',
    priority: ['high', 'normal', 'low'].includes(task.priority) ? task.priority : 'normal',
  }
  baseline.value = JSON.stringify(draft.value)
  error.value = ''
  nextTick(() => titleField.value?.focus())
}

function close() {
  if (busy.value) return
  if (dirty.value && !window.confirm('这条待办有未保存的修改，确定丢弃吗？')) return
  emit('close')
}

function isValidDateKey(value) {
  if (!value) return true
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(year, month - 1, day)
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
}

async function save() {
  const title = draft.value.title.trim()
  if (busy.value || !title || !props.task?.id) return
  if (!isValidDateKey(draft.value.dueDate)) {
    error.value = '请选择有效的安排日期。'
    return
  }
  busy.value = true
  error.value = ''
  const { id, updatedAt, ...data } = props.task
  try {
    await saveLocalRecord('task', String(id), {
      ...data,
      title: title.slice(0, 120),
      dueDate: draft.value.dueDate,
      priority: draft.value.priority,
    })
    emit('saved')
  } catch (saveError) {
    error.value = saveError.message || '保存失败，请稍后重试。'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="task-editor-scrim" @click.self="close" @keydown.esc.stop="close">
      <form class="task-editor-dialog" role="dialog" aria-modal="true" aria-labelledby="task-editor-title" @submit.prevent="save">
        <header>
          <div><span class="section-kicker">待办事项</span><h2 id="task-editor-title">编辑待办</h2></div>
          <button type="button" class="icon-button" aria-label="关闭编辑窗口" :disabled="busy" @click="close"><Icon name="close" size="17" /></button>
        </header>
        <label class="task-editor-field"><span>事项名称</span><input ref="titleField" v-model="draft.title" maxlength="120" required :disabled="busy" /></label>
        <div class="task-editor-row">
          <label class="task-editor-field"><span>安排日期</span><input v-model="draft.dueDate" type="date" :disabled="busy" /><small>留空表示暂不安排日期</small></label>
          <label class="task-editor-field"><span>优先级</span><select v-model="draft.priority" :disabled="busy"><option value="high">高</option><option value="normal">普通</option><option value="low">低</option></select></label>
        </div>
        <p v-if="error" class="task-editor-error" role="alert">{{ error }}</p>
        <footer>
          <span v-if="props.task?.done" class="task-editor-completed"><Icon name="check" size="14" /> 已完成状态会保留</span>
          <span v-else></span>
          <div><button type="button" class="button button-secondary" :disabled="busy" @click="close">取消</button><button type="submit" class="button button-primary" :disabled="busy || !draft.title.trim()">{{ busy ? '保存中…' : '保存修改' }}</button></div>
        </footer>
      </form>
    </div>
  </Teleport>
</template>

<style scoped>
.task-editor-scrim { position: fixed; z-index: 1100; inset: 0; display: grid; place-items: center; padding: 18px; background: rgb(24 29 37 / 32%); backdrop-filter: blur(4px); }
.task-editor-dialog { width: min(100%, 450px); display: grid; gap: 17px; padding: 24px; border: 1px solid #edf0f3; border-radius: 20px; background: #fff; box-shadow: 0 24px 80px rgb(23 34 48 / 18%); color: #354155; }
.task-editor-dialog header, .task-editor-dialog footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.task-editor-dialog header h2 { margin: 5px 0 0; color: #303a49; font-size: 20px; font-weight: 640; }
.task-editor-dialog header .icon-button { display: grid; place-items: center; }
.task-editor-field { min-width: 0; display: grid; gap: 7px; color: #657184; font-size: 13.5px; font-weight: 600; }
.task-editor-field input, .task-editor-field select { width: 100%; min-height: 40px; padding: 0 11px; border: 1px solid #e4e8ed; border-radius: 10px; outline: 0; background: #fbfcfd; color: #384455; font: inherit; font-size: 13px; }
.task-editor-field input:focus, .task-editor-field select:focus { border-color: #abc0df; box-shadow: 0 0 0 3px rgb(88 129 190 / 11%); }
.task-editor-field small { color: #99a1ac; font-size: 12px; font-weight: 400; }
.task-editor-row { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(100px, .8fr); gap: 12px; align-items: start; }
.task-editor-dialog footer > div { display: flex; gap: 8px; }
.task-editor-completed { display: inline-flex; align-items: center; gap: 5px; color: #6c9278; font-size: 12.5px; }
.task-editor-error { margin: 0; color: #ad5a54; font-size: 13.5px; }
.task-editor-dialog button:disabled, .task-editor-field :disabled { cursor: wait; opacity: .58; }
@media (max-width: 430px) { .task-editor-dialog { padding: 19px; border-radius: 17px; } }
</style>
