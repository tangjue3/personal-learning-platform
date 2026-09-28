export function isReviewDue(card, now = Date.now()) {
  if (!card || typeof card !== 'object') return false
  if (!card.dueAt) return true
  const dueAt = Date.parse(card.dueAt)
  return !Number.isFinite(dueAt) || dueAt <= now
}