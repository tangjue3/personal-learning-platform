import { reactive } from 'vue'

const allowedLocalRecordKinds = new Set(['reader', 'calendar', 'note', 'task', 'review', 'preference'])

export const localDataState = reactive({
  serviceAvailable: false,
  events: [],
  git: { canSync: false, syncing: false, saving: false },
  error: '',
})

async function request(path, options = {}) {
  const headers = new Headers(options.headers || {})
  headers.set('X-Zhixu-Client', 'local-ui')
  if (options.body) headers.set('Content-Type', 'application/json')

  let response
  try {
    response = await fetch(path, { ...options, headers, credentials: 'same-origin' })
  } catch {
    localDataState.serviceAvailable = false
    throw new Error('本机数据服务未连接。请从平台目录运行 npm run dev:app。')
  }

  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.error || '本机服务暂时无法完成操作。')
  return payload
}

function compactLocalEvents(events) {
  const latestIndexByIdentity = new Map()
  const malformedIdentities = new Set()
  const identities = events.map((event, index) => {
    if (!event || typeof event.kind !== 'string' || typeof event.entityId !== 'string') return null
    const identity = `${event.kind}:${event.entityId}`
    const isValidEvent = allowedLocalRecordKinds.has(event.kind)
      && /^[a-zA-Z0-9._-]{1,120}$/.test(event.entityId)
      && typeof event.id === 'string' && Boolean(event.id)
      && typeof event.changedAt === 'string' && Number.isFinite(Date.parse(event.changedAt))
      && ['upsert', 'delete'].includes(event.operation)
      && (event.operation === 'delete'
        ? event.data === null
        : event.data && typeof event.data === 'object' && !Array.isArray(event.data))
    if (!isValidEvent) {
      malformedIdentities.add(identity)
      return identity
    }

    const previousIndex = latestIndexByIdentity.get(identity)
    const previous = previousIndex === undefined ? null : events[previousIndex]
    if (!previous || event.changedAt > previous.changedAt || (event.changedAt === previous.changedAt && event.id > previous.id)) {
      latestIndexByIdentity.set(identity, index)
    }
    return identity
  })

  return events.filter((event, index) => {
    const identity = identities[index]
    if (!identity || malformedIdentities.has(identity)) return true
    return latestIndexByIdentity.get(identity) === index
  })
}

function rememberLatestEvent(event) {
  localDataState.events = compactLocalEvents([...localDataState.events, event])
}

export async function refreshLocalDataState() {
  try {
    const [status, localPayload] = await Promise.all([
      request('/api/status'),
      request('/api/local/events'),
    ])
    localDataState.serviceAvailable = true
    localDataState.events = Array.isArray(localPayload.events) ? localPayload.events : []
    localDataState.git = status.git || { canSync: false, syncing: false, saving: false }
    localDataState.error = ''
    return status
  } catch (error) {
    localDataState.serviceAvailable = false
    localDataState.git = { canSync: false, syncing: false, saving: false }
    localDataState.error = error.message
    return null
  }
}

export function getLocalRecords(kind) {
  const latest = new Map()
  for (const event of localDataState.events) {
    if (event.kind !== kind) continue
    const previous = latest.get(event.entityId)
    if (!previous || event.changedAt > previous.changedAt || (event.changedAt === previous.changedAt && event.id > previous.id)) {
      latest.set(event.entityId, event)
    }
  }
  return [...latest.values()]
    .filter((event) => event.operation === 'upsert')
    .map((event) => ({ ...event.data, id: event.entityId, updatedAt: event.changedAt }))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
}

export function getLocalRecord(kind, entityId) {
  return getLocalRecords(kind).find((record) => record.id === entityId) || null
}

export async function saveLocalRecord(kind, entityId, data) {
  const payload = await request('/api/local/events', {
    method: 'POST',
    body: JSON.stringify({ kind, entityId, operation: 'upsert', data }),
  })
  rememberLatestEvent(payload.event)
  return payload.event
}

export async function deleteLocalRecord(kind, entityId) {
  const payload = await request('/api/local/events', {
    method: 'POST',
    body: JSON.stringify({ kind, entityId, operation: 'delete' }),
  })
  rememberLatestEvent(payload.event)
  return payload.event
}

export async function importLocalEvents(events) {
  if (!Array.isArray(events) || events.length === 0) return { imported: 0 }
  const payload = await request('/api/local/import', {
    method: 'POST',
    body: JSON.stringify({ events }),
  })
  await refreshLocalDataState()
  return payload
}

export async function synchronizeCourses() {
  const payload = await request('/api/sync', { method: 'POST', body: '{}' })
  await refreshLocalDataState()
  return payload
}
