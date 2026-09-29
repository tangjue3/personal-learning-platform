const DAY_MS = 24 * 60 * 60 * 1000
const MAX_INSTANCES = 400

function keyToDate(key) {
  const [year, month, day] = String(key).split('-').map(Number)
  return new Date(year, month - 1, day)
}

function dateToKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/** 把重复日程（repeat: 'daily' | 'weekly'）展开成可见范围内的虚拟实例。
 *  实例只用于展示：id 加了日期后缀，repeatOf 指回原始记录，编辑时取回原事件。 */
export function expandRepeatingEvents(events, startKey, endKey) {
  if (!Array.isArray(events)) return []
  const start = keyToDate(startKey).getTime()
  const end = keyToDate(endKey).getTime()
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return events
  const result = []
  for (const event of events) {
    const repeat = event?.repeat === 'daily' || event?.repeat === 'weekly' ? event.repeat : 'none'
    const baseDate = keyToDate(event.date).getTime()
    if (repeat === 'none' || !Number.isFinite(baseDate)) {
      if (event.date >= startKey && event.date <= endKey) result.push(event)
      continue
    }
    if (event.date >= startKey && event.date <= endKey) result.push(event)
    const step = repeat === 'daily' ? DAY_MS : 7 * DAY_MS
    let cursor = baseDate
    for (let guard = 0; cursor <= end && guard < MAX_INSTANCES; guard += 1) {
      if (cursor >= start && cursor !== baseDate) {
        result.push({ ...event, id: `${event.id}~${dateToKey(new Date(cursor))}`, date: dateToKey(new Date(cursor)), repeatOf: event.id })
      }
      cursor += step
    }
  }
  return result
}
