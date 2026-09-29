import { saveLocalRecord } from './localDataStore.js'

function makeId() {
  return globalThis.crypto?.randomUUID?.() || `cap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/** 划线 = 一条带 type:'highlight' 的笔记记录：摘录是原文，锚点能跳回原文。
 *  EPUB 用 CFI 重绘高亮，Markdown 用文本偏移重绘，PDF 用页面矩形。 */
export async function createHighlight({ bookId, chapterId = '', chapterTitle = '', excerpt, anchor = null, format = 'markdown', color = 'yellow' }) {
  const quote = String(excerpt || '').trim()
  if (!quote) throw new Error('没有选中文本。')
  if (!bookId) throw new Error('当前书籍缺少稳定标识，暂时无法划线。')
  const now = new Date().toISOString()
  const id = makeId()
  await saveLocalRecord('note', id, {
    type: 'highlight',
    title: `${chapterTitle || '阅读'} · 划线`.slice(0, 120),
    content: '',
    excerpt: quote.slice(0, 3000),
    bookId: String(bookId),
    chapterId: String(chapterId || ''),
    chapterTitle: String(chapterTitle || ''),
    format,
    anchor: anchor || null,
    color,
    createdAt: now,
    updatedAt: now,
  })
  return id
}

export async function createReviewCardFromQuote({ bookId = '', chapterId = '', front, back = '' }) {
  const question = String(front || '').trim()
  if (!question) throw new Error('卡片正面不能为空。')
  const now = new Date().toISOString()
  const id = makeId()
  await saveLocalRecord('review', id, {
    front: question.slice(0, 2000),
    back: String(back || '').trim().slice(0, 4000),
    bookId: bookId ? String(bookId) : '',
    chapterId: chapterId ? String(chapterId) : '',
    dueAt: now,
    intervalDays: 0,
    repetitions: 0,
    easeFactor: 2.5,
    createdAt: now,
  })
  return id
}

export const highlightColors = {
  yellow: 'rgba(233, 217, 142, .55)',
  blue: 'rgba(169, 198, 234, .5)',
  green: 'rgba(175, 209, 184, .5)',
  pink: 'rgba(237, 189, 199, .55)',
}

export function highlightColor(color) {
  return highlightColors[color] || highlightColors.yellow
}
