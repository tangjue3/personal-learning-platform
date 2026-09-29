import { getLocalRecord, saveLocalRecord } from './localDataStore.js'

// 阅读时长按「会话心跳」累计：阅读器挂载期间，每 30 秒检查一次页面可见且
// 最近 3 分钟内有交互，满足才计入。数据合并进当天的 preference 记录
// （reading-time-日期），与服务端每次写入都压缩事件的行为配合，不会膨胀。
const HEARTBEAT_SECONDS = 30
const IDLE_AFTER_MS = 3 * 60 * 1000
const FLUSH_THRESHOLD_SECONDS = 60

let activeBookId = ''
let timer = null
let lastActivityAt = 0
let pendingSeconds = 0
let flushing = false

function localDateKey(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

function markActivity() {
  lastActivityAt = Date.now()
}

function isCounting() {
  if (document.visibilityState !== 'visible') return false
  return Date.now() - lastActivityAt < IDLE_AFTER_MS
}

async function flush() {
  if (!pendingSeconds || flushing) return
  const bookId = activeBookId
  const seconds = pendingSeconds
  pendingSeconds = 0
  if (!bookId || seconds <= 0) return
  flushing = true
  const now = new Date()
  const day = localDateKey(now)
  try {
    const key = `reading-time-${day}`
    const existing = getLocalRecord('preference', key) || { date: day, totalSeconds: 0, byBook: {}, byHour: {} }
    const byBook = { ...(existing.byBook || {}) }
    byBook[bookId] = (Number(byBook[bookId]) || 0) + seconds
    const byHour = { ...(existing.byHour || {}) }
    const hour = String(now.getHours())
    byHour[hour] = (Number(byHour[hour]) || 0) + seconds
    await saveLocalRecord('preference', key, {
      ...existing,
      date: day,
      totalSeconds: (Number(existing.totalSeconds) || 0) + seconds,
      byBook,
      byHour,
    })
  } catch { /* 时长统计尽力而为，失败不打扰阅读。 */ }
  finally { flushing = false }
}

function tick() {
  if (!activeBookId || !isCounting()) return
  pendingSeconds += HEARTBEAT_SECONDS
  if (pendingSeconds >= FLUSH_THRESHOLD_SECONDS) void flush()
}

function handleVisibilityChange() {
  if (document.visibilityState === 'hidden') void flush()
}

/** 在阅读器挂载时调用；同一时间只统计一本书。 */
export function startReadingSession(bookId) {
  const id = String(bookId || '')
  if (!id) return
  if (activeBookId && activeBookId !== id) void flush()
  activeBookId = id
  markActivity()
  if (timer) return
  timer = window.setInterval(tick, HEARTBEAT_SECONDS * 1000)
  window.addEventListener('pointerdown', markActivity, { capture: true, passive: true })
  window.addEventListener('keydown', markActivity, { capture: true, passive: true })
  window.addEventListener('wheel', markActivity, { capture: true, passive: true })
  document.addEventListener('visibilitychange', handleVisibilityChange)
  window.addEventListener('pagehide', () => { void flush() })
}

export function stopReadingSession() {
  void flush()
  activeBookId = ''
}
