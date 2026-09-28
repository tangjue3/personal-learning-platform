import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'
import { createWriteStream, createReadStream } from 'node:fs'
import { Transform, pipeline } from 'node:stream'
import { open, readdir, readFile, writeFile, mkdir, rename, rm, stat, realpath, lstat, link, copyFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const localDataRoot = join(root, 'data', 'local')
const localRecordsPath = join(localDataRoot, 'records.json')
const localBackupsRoot = join(localDataRoot, 'backups')
const ebooksRoot = join(localDataRoot, 'ebooks')
const distDirectory = join(root, 'dist')
const maximumBodyBytes = 32 * 1024 * 1024
const maximumEbookBytes = 512 * 1024 * 1024
const bookIdPattern = /^[a-zA-Z0-9._-]{1,120}$/
const ebookFormats = new Set(['epub', 'pdf'])
const ebookMediaTypes = new Map([['epub', 'application/epub+zip'], ['pdf', 'application/pdf']])
const allowedRecordKinds = new Set(['reader', 'calendar', 'note', 'task', 'review', 'preference'])
const localBackupIdPattern = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9]{8}$/
const maximumLocalBackups = 30
const runtime = { syncing: false, writing: false, queuedWrites: 0 }
let repositoryWriteQueue = Promise.resolve()
const isApiOnly = process.argv.includes('--api-only')
const port = Number(process.env.ZHIXU_API_PORT || (isApiOnly ? 4174 : process.env.PORT || 4173))
const isProduction = !isApiOnly
const developmentOrigins = new Set(['http://127.0.0.1:5174', 'http://localhost:5174'])

function json(response, status, payload) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  })
  response.end(JSON.stringify(payload))
}

function fail(status, message) {
  const error = new Error(message)
  error.status = status
  return error
}

function failWith(status, message, extra = {}) {
  const error = fail(status, message)
  error.extra = extra
  return error
}

async function readJson(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > maximumBodyBytes) throw fail(413, '请求内容过大。')
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw fail(400, '请求内容不是有效的 JSON。')
  }
}

function assertLocalBrowser(request, { requireClientHeader = false } = {}) {
  const host = String(request.headers.host || '').split(':')[0].toLowerCase()
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]') {
    throw fail(403, '本机服务只接受来自本机的请求。')
  }

  const origin = request.headers.origin
  if (origin) {
    const allowed = isProduction
      ? new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`])
      : developmentOrigins
    if (!allowed.has(origin)) throw fail(403, '请求来源不受信任。')
  } else if (request.method !== 'GET') {
    throw fail(403, '缺少本机页面来源信息。')
  }

  if (requireClientHeader && request.headers['x-zhixu-client'] !== 'local-ui') {
    throw fail(403, '请求缺少本机应用标记。')
  }
}

async function atomicWrite(path, contents) {
  await mkdir(resolve(path, '..'), { recursive: true })
  const temporaryPath = `${path}.${randomUUID()}.tmp`
  await writeFile(temporaryPath, contents, { flag: 'wx' })
  await rename(temporaryPath, path)
}

function validateRecordInput(body) {
  if (!body || typeof body !== 'object' || !allowedRecordKinds.has(body.kind)) {
    throw fail(400, '个人学习记录类型不受支持。')
  }
  if (typeof body.entityId !== 'string' || !/^[a-zA-Z0-9._-]{1,120}$/.test(body.entityId)) {
    throw fail(400, '个人学习记录标识不合法。')
  }
  if (!['upsert', 'delete'].includes(body.operation)) throw fail(400, '操作类型不受支持。')
  const data = body.operation === 'delete' ? null : body.data
  if (body.operation === 'upsert' && (!data || typeof data !== 'object' || Array.isArray(data))) {
    throw fail(400, '个人学习记录内容不合法。')
  }
  const size = Buffer.byteLength(JSON.stringify(data ?? null), 'utf8')
  if (size > 256 * 1024) throw fail(413, '单条私人记录不能超过 256 KB。')
  return {
    id: randomUUID(),
    kind: body.kind,
    entityId: body.entityId,
    operation: body.operation,
    changedAt: new Date().toISOString(),
    data,
  }
}

async function listLocalEvents() {
  try {
    const payload = JSON.parse(await readFile(localRecordsPath, 'utf8'))
    if (payload.version !== 1 || !Array.isArray(payload.events)) throw new Error('本机学习数据文件格式不正确。')
    return payload.events
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

function compactLocalEvents(events) {
  const latestIndexByIdentity = new Map()
  const malformedIdentities = new Set()
  const identities = events.map((event, index) => {
    if (!event || typeof event.kind !== 'string' || typeof event.entityId !== 'string') return null
    const identity = `${event.kind}:${event.entityId}`
    const isValidEvent = allowedRecordKinds.has(event.kind)
      && /^[a-zA-Z0-9._-]{1,120}$/.test(event.entityId)
      && typeof event.id === 'string' && Boolean(event.id)
      && typeof event.changedAt === 'string' && Number.isFinite(Date.parse(event.changedAt))
      && (event.operation === 'delete'
        ? event.data === null
        : event.operation === 'upsert' && event.data && typeof event.data === 'object' && !Array.isArray(event.data))
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

async function appendLocalEvent(body) {
  return withRepositoryWrite(async () => {
    const event = validateRecordInput(body)
    const events = await listLocalEvents()
    events.push(event)
    const compactedEvents = compactLocalEvents(events)
    await atomicWrite(localRecordsPath, `${JSON.stringify({ version: 1, events: compactedEvents }, null, 2)}\n`)
    return event
  })
}

async function appendLocalEvents(body) {
  return withRepositoryWrite(async () => {
    if (!body || !Array.isArray(body.events) || body.events.length === 0) {
      throw fail(400, '备份中没有可恢复的个人记录。')
    }
    if (body.events.length > 10000) throw fail(413, '单次最多恢复 10000 条个人记录。')

    const identities = new Set()
    const importedEvents = body.events.map((entry) => {
      if (entry?.operation && entry.operation !== 'upsert') throw fail(400, '备份只能包含有效的个人记录。')
      const event = validateRecordInput({ ...entry, operation: 'upsert' })
      const identity = `${event.kind}:${event.entityId}`
      if (identities.has(identity)) throw fail(400, '备份中包含重复的个人记录标识。')
      identities.add(identity)
      return event
    })

    const events = await listLocalEvents()
    const latestByIdentity = new Map()
    for (const event of events) {
      const identity = `${event.kind}:${event.entityId}`
      const previous = latestByIdentity.get(identity)
      if (!previous || event.changedAt > previous.changedAt || (event.changedAt === previous.changedAt && event.id > previous.id)) {
        latestByIdentity.set(identity, event)
      }
    }
    const existingIdentities = new Set([...latestByIdentity.values()]
      .filter((event) => event.operation === 'upsert')
      .map((event) => `${event.kind}:${event.entityId}`))
    const additions = importedEvents.filter((event) => !existingIdentities.has(`${event.kind}:${event.entityId}`))
    const skipped = importedEvents.length - additions.length
    let preRestoreBackup = null
    if (additions.length) {
      preRestoreBackup = await createLocalBackup('before-restore')
      events.push(...additions)
      const compactedEvents = compactLocalEvents(events)
      await atomicWrite(localRecordsPath, `${JSON.stringify({ version: 1, events: compactedEvents }, null, 2)}\n`)
    }
    return { imported: additions.length, skipped, preRestoreBackupId: preRestoreBackup?.id || null }
  })
}

async function withRepositoryWrite(operation) {
  if (runtime.syncing) throw fail(423, '课程同步正在进行，请稍后再保存。')
  runtime.queuedWrites += 1
  const previousWrite = repositoryWriteQueue
  let releaseWrite
  repositoryWriteQueue = new Promise((resolve) => { releaseWrite = resolve })
  try {
    await previousWrite
    if (runtime.syncing) throw fail(423, '课程同步正在进行，请稍后再保存。')
    runtime.writing = true
    return await operation()
  } finally {
    runtime.writing = false
    runtime.queuedWrites -= 1
    releaseWrite()
  }
}

function isValidLocalRecordEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)
    || typeof event.id !== 'string' || !event.id
    || typeof event.changedAt !== 'string' || !Number.isFinite(Date.parse(event.changedAt))) return false
  if (event.operation === 'delete' && event.data !== null) return false
  if (!['upsert', 'delete'].includes(event.operation)) return false
  try {
    validateRecordInput(event)
    return true
  } catch {
    return false
  }
}

async function cloneLocalTree(source, destination, totals = { files: 0, bytes: 0 }) {
  const sourceInfo = await lstat(source)
  if (sourceInfo.isSymbolicLink() || !sourceInfo.isDirectory()) throw new Error('本机快照目录包含不受支持的链接。')
  const entries = await readdir(source, { withFileTypes: true })

  await mkdir(destination, { recursive: true })
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new Error('本机快照不能包含符号链接。')
    const sourcePath = join(source, entry.name)
    const targetPath = join(destination, entry.name)
    if (entry.isDirectory()) {
      await cloneLocalTree(sourcePath, targetPath, totals)
      continue
    }
    if (!entry.isFile()) throw new Error('本机快照目录包含不支持的文件类型。')

    try { await link(sourcePath, targetPath) }
    catch { await copyFile(sourcePath, targetPath) }
    const fileInfo = await stat(sourcePath)
    totals.files += 1
    totals.bytes += fileInfo.size
  }
  return totals
}

async function cloneLocalEbooks(source, destination) {
  let sourceInfo
  try { sourceInfo = await lstat(source) }
  catch (error) {
    if (error.code === 'ENOENT') {
      await mkdir(destination, { recursive: true })
      return { ebookCount: 0, files: 0, bytes: 0 }
    }
    throw error
  }
  if (sourceInfo.isSymbolicLink() || !sourceInfo.isDirectory()) throw new Error('本机电子书目录不是有效的普通目录。')
  await mkdir(destination, { recursive: true })
  const entries = await readdir(source, { withFileTypes: true })

  const totals = { ebookCount: 0, files: 0, bytes: 0 }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new Error('电子书目录不能包含符号链接。')
    if (!entry.isDirectory() || entry.name.startsWith('.') || !bookIdPattern.test(entry.name)) continue
    await cloneLocalTree(join(source, entry.name), join(destination, entry.name), totals)
    totals.ebookCount += 1
  }
  return totals
}

async function listLocalBackups() {
  let entries
  try { entries = await readdir(localBackupsRoot, { withFileTypes: true }) }
  catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }

  const backups = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !localBackupIdPattern.test(entry.name)) continue
    try {
      const manifestPath = join(localBackupsRoot, entry.name, 'manifest.json')
      const manifestInfo = await lstat(manifestPath)
      if (manifestInfo.isSymbolicLink() || !manifestInfo.isFile()) continue
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
      if (manifest?.format !== 'zhixu-local-snapshot' || manifest.version !== 1 || manifest.id !== entry.name) continue
      backups.push({
        id: manifest.id,
        createdAt: manifest.createdAt,
        reason: manifest.reason,
        recordsValid: manifest.recordsValid === true,
        recordCount: Number.isInteger(manifest.recordCount) && manifest.recordCount >= 0 ? manifest.recordCount : null,
        ebookCount: Number.isInteger(manifest.ebookCount) && manifest.ebookCount >= 0 ? manifest.ebookCount : 0,
        ebookBytes: Number.isFinite(manifest.ebookBytes) ? manifest.ebookBytes : 0,
      })
    } catch {
      // 忽略未完成或损坏的快照目录；它不会影响本机数据读取。
    }
  }
  return backups.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
}

async function pruneLocalBackups(protectedIds = []) {
  const backups = await listLocalBackups()
  const protectedSet = new Set(protectedIds)
  const protectedBackups = backups.filter((backup) => protectedSet.has(backup.id))
  const remainingSlots = Math.max(0, maximumLocalBackups - protectedBackups.length)
  const retained = new Set([
    ...protectedBackups.map((backup) => backup.id),
    ...backups.filter((backup) => !protectedSet.has(backup.id)).slice(0, remainingSlots).map((backup) => backup.id),
  ])
  for (const backup of backups) {
    if (retained.has(backup.id)) continue
    await rm(join(localBackupsRoot, backup.id), { recursive: true, force: true })
  }
}

async function createLocalBackup(reason = 'manual', { allowInvalidRecords = false, protectedIds = [] } = {}) {
  if (!['manual', 'automatic', 'before-restore'].includes(reason)) throw fail(400, '本机快照类型不受支持。')
  let recordsBuffer
  try { recordsBuffer = await readFile(localRecordsPath) }
  catch (error) {
    if (error.code !== 'ENOENT') throw error
    recordsBuffer = Buffer.from(`${JSON.stringify({ version: 1, events: [] }, null, 2)}\n`)
  }

  let recordPayload = null
  try { recordPayload = JSON.parse(recordsBuffer.toString('utf8')) } catch { /* Mark invalid below. */ }
  const recordsValid = recordPayload?.version === 1 && Array.isArray(recordPayload.events)
    && recordPayload.events.every(isValidLocalRecordEvent)
  if (!recordsValid && !allowInvalidRecords) throw fail(500, '本机记录文件格式异常，未创建快照。')
  const compactedEvents = recordsValid ? compactLocalEvents(recordPayload.events) : []
  const recordCount = recordsValid ? compactedEvents.filter((event) => event.operation === 'upsert').length : null

  const createdAt = new Date().toISOString()
  const id = `${createdAt.replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`
  const stagingDirectory = join(localBackupsRoot, `.pending-${id}`)
  const snapshotDirectory = join(localBackupsRoot, id)
  await mkdir(localBackupsRoot, { recursive: true })
  await mkdir(stagingDirectory)
  try {
    await writeFile(join(stagingDirectory, 'records.json'), recordsBuffer, { flag: 'wx' })
    const ebookTotals = await cloneLocalEbooks(ebooksRoot, join(stagingDirectory, 'ebooks'))
    const manifest = {
      format: 'zhixu-local-snapshot',
      version: 1,
      id,
      createdAt,
      reason,
      recordsValid,
      recordCount,
      ebookCount: ebookTotals.ebookCount,
      ebookFiles: ebookTotals.files,
      ebookBytes: ebookTotals.bytes,
    }
    await writeFile(join(stagingDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' })
    await rename(stagingDirectory, snapshotDirectory)
  } catch (error) {
    await rm(stagingDirectory, { recursive: true, force: true }).catch(() => {})
    throw error
  }
  await pruneLocalBackups(protectedIds).catch((error) => console.warn('清理过期本机快照失败。', error))
  return JSON.parse(await readFile(join(snapshotDirectory, 'manifest.json'), 'utf8'))
}

async function readLocalBackup(id) {
  if (!localBackupIdPattern.test(String(id))) throw fail(400, '本机快照标识不正确。')
  const backups = await listLocalBackups()
  const backup = backups.find((item) => item.id === id)
  if (!backup) throw fail(404, '没有找到这份本机快照。')
  if (!backup.recordsValid) throw fail(400, '这份快照中的个人记录文件无法验证，不能用于恢复。')
  return {
    ...backup,
    directory: join(localBackupsRoot, id),
    recordsPath: join(localBackupsRoot, id, 'records.json'),
    ebooksPath: join(localBackupsRoot, id, 'ebooks'),
  }
}

async function validateLocalBackupEbooks(backup) {
  let entries
  try { entries = await readdir(backup.ebooksPath, { withFileTypes: true }) }
  catch (error) {
    if (error.code === 'ENOENT') throw fail(400, '快照缺少电子书目录。')
    throw error
  }
  let ebookCount = 0
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !bookIdPattern.test(entry.name)) throw fail(400, '快照中的电子书目录不合法。')
    const directory = join(backup.ebooksPath, entry.name)
    const metadataPath = join(directory, 'book.json')
    const metadataInfo = await lstat(metadataPath).catch(() => null)
    if (!metadataInfo?.isFile() || metadataInfo.isSymbolicLink()) throw fail(400, '快照中的电子书信息文件不合法。')
    const metadata = await readEbookMetadata(directory).catch(() => null)
    if (!metadata || metadata.bookId !== entry.name) throw fail(400, '快照中的电子书信息不完整。')
    const sourcePath = join(directory, `source.${metadata.format}`)
    const fileInfo = await lstat(sourcePath).catch(() => null)
    if (!fileInfo) throw fail(400, '快照中的电子书原文件缺失。')
    if (fileInfo.isSymbolicLink()) throw fail(400, '快照中的电子书原文件不能是符号链接。')
    if (!fileInfo.isFile() || fileInfo.size !== metadata.size) throw fail(400, '快照中的电子书文件大小不一致。')
    await assertEbookSignature(sourcePath, metadata.format)
    if (metadata.checksum) {
      if (!/^[a-f0-9]{64}$/i.test(metadata.checksum) || await digestLocalFile(sourcePath) !== metadata.checksum.toLowerCase()) {
        throw fail(400, '快照中的电子书 SHA-256 校验失败。')
      }
    }
    ebookCount += 1
  }
  if (ebookCount !== backup.ebookCount) throw fail(400, '快照中的电子书数量与清单不一致。')
}

async function digestLocalFile(filePath) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk)
  return hash.digest('hex')
}

async function restoreLocalBackupSnapshot(id) {
  const backup = await readLocalBackup(id)
  let recordsPayload
  let recordsBuffer
  try {
    const recordsInfo = await lstat(backup.recordsPath)
    if (recordsInfo.isSymbolicLink() || !recordsInfo.isFile()) throw new Error('records file is not a regular file')
    recordsBuffer = await readFile(backup.recordsPath)
    recordsPayload = JSON.parse(recordsBuffer.toString('utf8'))
  } catch { throw fail(400, '快照中的个人记录文件无法读取。') }
  if (recordsPayload?.version !== 1 || !Array.isArray(recordsPayload.events)
    || !recordsPayload.events.every(isValidLocalRecordEvent)) throw fail(400, '快照中的个人记录格式不合法。')
  await validateLocalBackupEbooks(backup)

  const safetyBackup = await createLocalBackup('before-restore', { allowInvalidRecords: true, protectedIds: [id] })
  const stagingDirectory = join(localDataRoot, `.restore-${randomUUID()}`)
  const rollbackDirectory = join(localDataRoot, `.rollback-${randomUUID()}`)
  let recordsMoved = false
  let ebooksMoved = false
  let recordsInstalled = false
  let ebooksInstalled = false
  let preserveRollbackDirectory = false
  try {
    await mkdir(stagingDirectory, { recursive: true })
    await mkdir(rollbackDirectory, { recursive: true })
    await writeFile(join(stagingDirectory, 'records.json'), recordsBuffer, { flag: 'wx' })
    await cloneLocalEbooks(backup.ebooksPath, join(stagingDirectory, 'ebooks'))
    if (existsSync(localRecordsPath)) {
      await rename(localRecordsPath, join(rollbackDirectory, 'records.json'))
      recordsMoved = true
    }
    if (existsSync(ebooksRoot)) {
      await rename(ebooksRoot, join(rollbackDirectory, 'ebooks'))
      ebooksMoved = true
    }
    await rename(join(stagingDirectory, 'records.json'), localRecordsPath)
    recordsInstalled = true
    await rename(join(stagingDirectory, 'ebooks'), ebooksRoot)
    ebooksInstalled = true
  } catch (error) {
    if (recordsInstalled) await rm(localRecordsPath, { force: true }).catch(() => {})
    if (ebooksInstalled) await rm(ebooksRoot, { recursive: true, force: true }).catch(() => {})
    let rollbackFailed = false
    if (recordsMoved) {
      try { await rename(join(rollbackDirectory, 'records.json'), localRecordsPath) }
      catch { rollbackFailed = true }
    }
    if (ebooksMoved) {
      try { await rename(join(rollbackDirectory, 'ebooks'), ebooksRoot) }
      catch { rollbackFailed = true }
    }
    if (rollbackFailed) {
      preserveRollbackDirectory = true
      console.error(`本机快照恢复回滚未完成，原始数据保留在 ${rollbackDirectory}`)
      throw fail(500, `快照恢复失败，回滚数据暂存在 data/local/${basename(rollbackDirectory)}，请勿删除。`)
    }
    throw error
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true }).catch(() => {})
    if (!preserveRollbackDirectory) await rm(rollbackDirectory, { recursive: true, force: true }).catch(() => {})
  }
  return {
    restored: true,
    recordCount: compactLocalEvents(recordsPayload.events).filter((event) => event.operation === 'upsert').length,
    ebookCount: backup.ebookCount,
    preRestoreBackupId: safetyBackup.id,
  }
}

async function ensureDailyLocalBackup() {
  if (!existsSync(localRecordsPath) && !existsSync(ebooksRoot)) return null
  const backups = await listLocalBackups()
  const newest = backups[0]
  if (newest && Date.now() - Date.parse(newest.createdAt) < 24 * 60 * 60 * 1000) return newest
  return withRepositoryWrite(() => createLocalBackup('automatic'))
}
function naturalCompare(a, b) {
  return new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' }).compare(a, b)
}

function markdownTitle(content, filename) {
  const heading = String(content).match(/^\s*#\s+(.+?)\s*#*\s*$/m)?.[1]
  return heading?.trim() || basename(filename, extname(filename)) || '未命名章节'
}

async function walkMarkdown(directory) {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  const result = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) result.push(...await walkMarkdown(path))
    else if (entry.isFile() && /\.(md|markdown)$/i.test(entry.name)) result.push(path)
  }
  return result
}

async function listBooks() {
  const booksRoot = join(root, 'content', 'books')
  let entries
  try {
    entries = await readdir(booksRoot, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }

  const books = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.incoming-')) continue
    const directory = join(booksRoot, entry.name)
    const manifestPath = join(directory, 'book.json')
    if (!existsSync(manifestPath)) continue
    try {
      const metadata = JSON.parse(await readFile(manifestPath, 'utf8'))
      if (!metadata || typeof metadata.title !== 'string' || !metadata.title.trim()) continue
      const paths = (await walkMarkdown(directory)).sort((a, b) => naturalCompare(relative(directory, a), relative(directory, b)))
      const documents = await Promise.all(paths.map(async (path, order) => {
        const file = relative(directory, path).split(sep).join('/')
        const content = await readFile(path, 'utf8')
        return { id: `${metadata.id || entry.name}:${file}`, file, title: markdownTitle(content, file), content, order }
      }))
      if (!documents.length) continue
      books.push({
        id: String(metadata.id || entry.name),
        title: metadata.title.trim(),
        coverTitle: typeof metadata.coverTitle === 'string' ? metadata.coverTitle : metadata.title.trim(),
        subtitle: typeof metadata.subtitle === 'string' ? metadata.subtitle : 'Markdown 学习课程',
        category: typeof metadata.category === 'string' ? metadata.category : '通用能力',
        theme: typeof metadata.theme === 'string' ? metadata.theme : 'blue',
        chapters: documents.length,
        documents,
        repositoryManaged: true,
      })
    } catch (error) {
      console.warn(`跳过无法读取的课程目录 ${entry.name}。`, error)
    }
  }
  return books.sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'))
}

function safeChapterFilename(value, index) {
  const rawSegments = String(value || `章节-${index + 1}.md`).replace(/\\/g, '/').split('/')
  if (rawSegments.some((segment) => segment === '..')) throw fail(400, `第 ${index + 1} 篇文档的路径不合法。`)
  const segments = rawSegments.filter((segment) => segment && segment !== '.')
  const sourceName = segments.pop() || `章节-${index + 1}.md`
  const extensionless = sourceName.replace(/\.(md|markdown)$/i, '')
  const safeName = extensionless.normalize('NFKC')
    .replace(/[^\p{L}\p{N}._ -]/gu, '-')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 90) || `章节-${index + 1}`
  const safeFolders = segments.map((segment) => segment.normalize('NFKC')
    .replace(/[^\p{L}\p{N}._ -]/gu, '-')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 80))
    .filter(Boolean)
  const extension = /\.markdown$/i.test(sourceName) ? '.markdown' : '.md'
  return [...safeFolders, `${safeName}${extension}`].join('/')
}

function safeRelativeAssetPath(value) {
  const segments = String(value || '').replace(/\\/g, '/').split('/')
  if (!segments.length || segments.some((segment) => segment === '..')) throw fail(400, '课程图片路径不合法。')
  const safeSegments = segments.filter((segment) => segment && segment !== '.').map((segment) => segment.normalize('NFKC')
    .replace(/[^\p{L}\p{N}._ -]/gu, '-')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 100))
  if (!safeSegments.length || safeSegments.some((segment) => !segment)) throw fail(400, '课程图片路径不合法。')
  return safeSegments.join('/')
}

async function createRepositoryBook(body) {
  if (!body || typeof body.title !== 'string' || !body.title.trim() || body.title.trim().length > 100) {
    throw fail(400, '请填写 1 到 100 个字符的课程名称。')
  }
  if (!Array.isArray(body.documents) || !body.documents.length || body.documents.length > 500) {
    throw fail(400, '课程需要包含 1 到 500 篇 Markdown 文档。')
  }

  const documents = body.documents.map((document, index) => {
    if (!document || typeof document.content !== 'string' || !/\.(md|markdown)$/i.test(String(document.file || ''))) {
      throw fail(400, `第 ${index + 1} 篇文档格式不正确。`)
    }
    return {
      file: safeChapterFilename(document.file, index),
      content: document.content,
      title: markdownTitle(document.content, String(document.file)),
    }
  })
  const documentPaths = new Set()
  for (const document of documents) {
    const normalizedPath = document.file.toLocaleLowerCase()
    if (documentPaths.has(normalizedPath)) throw fail(400, `多个章节的文件名重复：${document.file}。请改名后重新导入。`)
    documentPaths.add(normalizedPath)
  }
  const totalBytes = documents.reduce((sum, document) => sum + Buffer.byteLength(document.content, 'utf8'), 0)
  if (totalBytes > 15 * 1024 * 1024) throw fail(413, '整门课程不能超过 15 MB。')
  if (body.assets !== undefined && (!Array.isArray(body.assets) || body.assets.length > 500)) {
    throw fail(400, '课程图片数量不能超过 500 个。')
  }
  const assets = (body.assets || []).map((asset, index) => {
    if (!asset || typeof asset.content !== 'string') throw fail(400, `第 ${index + 1} 张课程图片格式不正确。`)
    const file = safeRelativeAssetPath(asset.file)
    if (!new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif']).has(extname(file).toLowerCase())) {
      throw fail(400, `课程图片 ${basename(file)} 的格式不受支持。`)
    }
    const bytes = Buffer.from(asset.content, 'base64')
    if (!bytes.length || bytes.toString('base64') !== asset.content) throw fail(400, `课程图片 ${basename(file)} 的内容不正确。`)
    return { file, bytes }
  })
  const assetPaths = new Set()
  for (const asset of assets) {
    const normalizedPath = asset.file.toLocaleLowerCase()
    if (assetPaths.has(normalizedPath)) throw fail(400, `多张图片的文件名重复：${asset.file}。请改名后重新导入。`)
    assetPaths.add(normalizedPath)
  }
  const totalAssetBytes = assets.reduce((sum, asset) => sum + asset.bytes.length, 0)
  if (totalAssetBytes > 10 * 1024 * 1024) throw fail(413, '课程图片总大小不能超过 10 MB。')

  const booksRoot = join(root, 'content', 'books')
  if (body.id !== undefined && (typeof body.id !== 'string' || !/^[a-zA-Z0-9._-]{1,120}$/.test(body.id))) {
    throw fail(400, '课程标识不合法。')
  }
  const id = body.id || `course-${randomUUID()}`
  if (existsSync(join(booksRoot, id)) || (await listBooks()).some((book) => book.id === id)) {
    throw fail(409, '这门课程的标识已经存在，请刷新书架后重试。')
  }
  const finalDirectory = join(booksRoot, id)
  const temporaryDirectory = join(booksRoot, `.incoming-${randomUUID()}`)
  const categories = new Set(['技术', '人工智能', '产品设计', '通用能力'])
  const themes = new Set(['blue', 'sand', 'night', 'sky', 'peach', 'mist', 'forest'])
  const metadata = {
    id,
    title: body.title.trim(),
    coverTitle: body.title.trim(),
    subtitle: typeof body.subtitle === 'string' && body.subtitle.trim().length <= 140
      ? body.subtitle.trim() || `Markdown 学习课程 · ${documents.length} 篇文档`
      : `Markdown 学习课程 · ${documents.length} 篇文档`,
    category: categories.has(body.category) ? body.category : '通用能力',
    theme: themes.has(body.theme) ? body.theme : 'blue',
  }

  await mkdir(booksRoot, { recursive: true })
  await mkdir(temporaryDirectory)
  try {
    await writeFile(join(temporaryDirectory, 'book.json'), `${JSON.stringify(metadata, null, 2)}\n`, { flag: 'wx' })
    for (const document of documents) {
      await mkdir(join(temporaryDirectory, dirname(document.file)), { recursive: true })
      await writeFile(join(temporaryDirectory, document.file), document.content, { flag: 'wx' })
    }
    for (const asset of assets) {
      await mkdir(join(temporaryDirectory, dirname(asset.file)), { recursive: true })
      await writeFile(join(temporaryDirectory, asset.file), asset.bytes, { flag: 'wx' })
    }
    await rename(temporaryDirectory, finalDirectory)
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {})
    throw error
  }

  return {
    ...metadata,
    chapters: documents.length,
    repositoryManaged: true,
    documents: documents.map((document, order) => ({
      id: `${id}:${document.file}`,
      file: document.file,
      title: document.title,
      content: document.content,
      order,
    })),
  }
}

async function updateRepositoryBook(bookId, body) {
  if (!body || typeof body !== 'object') throw fail(400, '书籍信息不正确。')
  const booksRoot = resolve(root, 'content', 'books')
  const bookDirectory = resolve(booksRoot, bookId)
  if (bookDirectory === booksRoot || !bookDirectory.startsWith(booksRoot + sep)) throw fail(404, '没有找到这本书。')
  let actualDirectory
  try { actualDirectory = await realpath(bookDirectory) }
  catch { throw fail(404, '没有找到这本仓库书籍。') }
  const directoryFromRoot = relative(booksRoot, actualDirectory)
  if (!directoryFromRoot || directoryFromRoot === '..' || directoryFromRoot.startsWith('..' + sep)) throw fail(404, '没有找到这本仓库书籍。')
  const manifestPath = join(actualDirectory, 'book.json')
  let metadata
  try { metadata = JSON.parse(await readFile(manifestPath, 'utf8')) }
  catch { throw fail(404, '没有找到这本仓库书籍。') }
  if (metadata.id !== bookId) throw fail(404, '没有找到这本仓库书籍。')

  if (typeof body.title !== 'string' || !body.title.trim() || body.title.trim().length > 100) {
    throw fail(400, '书名需要为 1 到 100 个字符。')
  }
  if (body.subtitle !== undefined && (typeof body.subtitle !== 'string' || body.subtitle.trim().length > 140)) {
    throw fail(400, '副标题不能超过 140 个字符。')
  }
  const categories = new Set(['技术', '人工智能', '产品设计', '通用能力'])
  const themes = new Set(['blue', 'sand', 'night', 'sky', 'peach', 'mist', 'forest'])
  metadata.title = body.title.trim()
  metadata.coverTitle = metadata.title
  metadata.subtitle = typeof body.subtitle === 'string' ? body.subtitle.trim() : metadata.subtitle
  if (categories.has(body.category)) metadata.category = body.category
  if (themes.has(body.theme)) metadata.theme = body.theme
  await atomicWrite(manifestPath, `${JSON.stringify(metadata, null, 2)}\n`)
  const books = await listBooks()
  return books.find((book) => book.id === bookId) || null
}

async function deleteRepositoryBook(bookId) {
  const booksRoot = resolve(root, 'content', 'books')
  const bookDirectory = resolve(booksRoot, bookId)
  if (bookDirectory === booksRoot || !bookDirectory.startsWith(booksRoot + sep)) throw fail(404, '没有找到这本书。')
  let actualDirectory
  try { actualDirectory = await realpath(bookDirectory) }
  catch { throw fail(404, '没有找到这本仓库书籍。') }
  const pathFromBooksRoot = relative(booksRoot, actualDirectory)
  if (!pathFromBooksRoot || pathFromBooksRoot === '..' || pathFromBooksRoot.startsWith('..' + sep)) {
    throw fail(404, '没有找到这本仓库书籍。')
  }
  try {
    const metadata = JSON.parse(await readFile(join(actualDirectory, 'book.json'), 'utf8'))
    if (metadata.id !== bookId) throw fail(404, '没有找到这本仓库书籍。')
  } catch (error) {
    if (error.status) throw error
    throw fail(404, '没有找到这本仓库书籍。')
  }
  await rm(actualDirectory, { recursive: true, force: false })
}

async function serveBookImage(bookId, encodedPath, request, response) {
  assertLocalBrowser(request)
  let relativePath
  try { relativePath = decodeURIComponent(encodedPath) }
  catch { throw fail(400, '图片路径不合法。') }
  const extension = extname(relativePath).toLowerCase()
  const imageTypes = new Map([
    ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
    ['.webp', 'image/webp'], ['.gif', 'image/gif'], ['.avif', 'image/avif'],
  ])
  const contentType = imageTypes.get(extension)
  if (!contentType || relativePath.includes('\0')) throw fail(404, '没有找到该课程图片。')

  const booksRoot = resolve(root, 'content', 'books')
  const bookDirectory = resolve(booksRoot, bookId)
  if (bookDirectory === booksRoot || !bookDirectory.startsWith(booksRoot + sep)) throw fail(404, '没有找到该课程图片。')
  let actualBookDirectory
  let actualImagePath
  try {
    actualBookDirectory = await realpath(bookDirectory)
    actualImagePath = await realpath(resolve(actualBookDirectory, relativePath))
  } catch {
    throw fail(404, '没有找到该课程图片。')
  }
  const pathFromBook = relative(actualBookDirectory, actualImagePath)
  if (!pathFromBook || pathFromBook === '..' || pathFromBook.startsWith('..' + sep)) throw fail(404, '没有找到该课程图片。')
  const imageStat = await stat(actualImagePath)
  if (!imageStat.isFile() || imageStat.size > 20 * 1024 * 1024) throw fail(413, '课程图片不能超过 20 MB。')
  const image = await readFile(actualImagePath)
  response.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': image.length,
    'Cache-Control': 'public, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  })
  response.end(image)
}

/* ------------------------------------------------------------------ *
 * 本机电子书文件
 *
 * EPUB/PDF 原文件保存在 data/local/ebooks/<bookId>/source.<format>，
 * 书目元数据保存在同目录的 book.json。此目录由 .gitignore 排除，
 * 不进入 content/books，也不会随课程同步上传 GitHub。
 * ------------------------------------------------------------------ */

function assertEbookBookId(value) {
  const bookId = String(value ?? '')
  if (!bookIdPattern.test(bookId)) throw fail(400, '电子书标识不合法。')
  return bookId
}

function assertEbookFormat(value) {
  const format = String(value ?? '').trim().toLowerCase()
  if (!ebookFormats.has(format)) throw fail(400, '目前只支持 EPUB 和 PDF 电子书。')
  return format
}

function sanitizeEbookFileName(value, format) {
  const cleaned = String(value ?? '')
    .replace(/[\\/\r\n\t\u0000-\u001f\u007f]/g, ' ')
    .replace(/\.{2,}/g, '.')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 120)
    .trim()
  return cleaned || `ebook.${format}`
}

function assertEbookChecksum(value) {
  const checksum = String(value ?? '').trim().toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(checksum)) throw fail(400, '电子书校验值不正确。')
  return checksum
}

async function resolveEbookDirectory(bookId) {
  const directory = resolve(ebooksRoot, bookId)
  if (directory === ebooksRoot || !directory.startsWith(ebooksRoot + sep)) throw fail(404, '没有找到这本电子书。')
  let actualDirectory
  try { actualDirectory = await realpath(directory) }
  catch { throw fail(404, '没有找到这本电子书。') }
  const pathFromRoot = relative(ebooksRoot, actualDirectory)
  if (!pathFromRoot || pathFromRoot === '..' || pathFromRoot.startsWith('..' + sep)) throw fail(404, '没有找到这本电子书。')
  return actualDirectory
}

function normalizeEbookMetadata(metadata) {
  const format = assertEbookFormat(metadata.format)
  return {
    bookId: String(metadata.bookId),
    title: typeof metadata.title === 'string' && metadata.title.trim() ? metadata.title.trim() : '未命名电子书',
    author: typeof metadata.author === 'string' ? metadata.author : '',
    format,
    fileName: typeof metadata.fileName === 'string' && metadata.fileName.trim()
      ? metadata.fileName.trim()
      : `ebook.${format}`,
    mediaType: typeof metadata.mediaType === 'string' && metadata.mediaType
      ? metadata.mediaType
      : ebookMediaTypes.get(format),
    size: Number(metadata.size) || 0,
    checksum: typeof metadata.checksum === 'string' ? metadata.checksum : '',
    importedAt: typeof metadata.importedAt === 'string' ? metadata.importedAt : '',
    updatedAt: typeof metadata.updatedAt === 'string' ? metadata.updatedAt : '',
    source: typeof metadata.source === 'string' ? metadata.source : 'local',
  }
}

async function readEbookMetadata(directory) {
  const metadata = JSON.parse(await readFile(join(directory, 'book.json'), 'utf8'))
  if (!metadata || typeof metadata !== 'object' || !bookIdPattern.test(String(metadata.bookId || ''))) {
    throw new Error('电子书书目信息不完整。')
  }
  return normalizeEbookMetadata(metadata)
}

async function listEbookBooks() {
  let entries
  try {
    entries = await readdir(ebooksRoot, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }

  const books = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    try {
      books.push(await readEbookMetadata(join(ebooksRoot, entry.name)))
    } catch (error) {
      console.warn(`跳过无法读取的电子书目录 ${entry.name}。`, error)
    }
  }
  return books.sort((left, right) => String(right.importedAt).localeCompare(String(left.importedAt))
    || naturalCompare(left.title, right.title))
}

function validateEbookSignature(head, format) {
  if (!head || head.length < 4) throw fail(400, '电子书文件太小，无法识别。')
  if (format === 'pdf') {
    if (head.slice(0, 5).toString('latin1') !== '%PDF-') throw fail(400, '这个文件没有有效的 PDF 文件头，无法导入。')
    return
  }
  const isZipContainer = head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04
  if (!isZipContainer) throw fail(400, '这个文件不像有效的 EPUB 电子书，请确认文件没有损坏。')
}

async function assertEbookSignature(filePath, format) {
  let handle
  try {
    handle = await open(filePath, 'r')
    const { buffer } = await handle.read(Buffer.alloc(8), 0, 8, 0)
    validateEbookSignature(buffer, format)
  } catch (error) {
    if (error?.status) throw error
    throw fail(400, '无法读取电子书文件头，请确认文件没有损坏。')
  } finally {
    await handle?.close().catch(() => { /* The handle is already closed or never opened. */ })
  }
}

function createEbookDigestCounter(limitBytes) {
  const hash = createHash('sha256')
  let size = 0
  const transform = new Transform({
    transform(chunk, encoding, callback) {
      size += chunk.length
      if (size > limitBytes) {
        callback(fail(413, `电子书文件不能超过 ${Math.floor(limitBytes / (1024 * 1024))} MB。`))
        return
      }
      hash.update(chunk)
      callback(null, chunk)
    },
  })
  return { transform, getSize: () => size, getDigest: () => hash.digest('hex') }
}

async function writeEbookStream(source, target, limitBytes) {
  const counter = createEbookDigestCounter(limitBytes)
  await new Promise((resolvePromise, rejectPromise) => {
    pipeline(source, counter.transform, createWriteStream(target, { flags: 'wx' }), (error) => {
      if (error) rejectPromise(error)
      else resolvePromise()
    })
  })
  return { size: counter.getSize(), digest: counter.getDigest() }
}

async function importEbookBook(request, params) {
  const bookId = assertEbookBookId(params.get('bookId'))
  const format = assertEbookFormat(params.get('format'))
  const title = String(params.get('title') ?? '').trim()
  if (!title || title.length > 160) throw fail(400, '请填写 1 到 160 个字符的书名。')
  const author = String(params.get('author') ?? '').trim().slice(0, 120)
  const fileName = sanitizeEbookFileName(params.get('fileName'), format)
  const checksum = params.get('checksum') ? assertEbookChecksum(params.get('checksum')) : ''
  const rawSize = params.get('size')
  const expectedSize = Number(rawSize)
  if (rawSize !== null && rawSize !== '' && (!Number.isFinite(expectedSize) || expectedSize < 0)) {
    throw fail(400, '电子书文件大小不正确。')
  }
  // 只拦明显的非二进制类型；具体格式由文件头和扩展名判断，避免把
  // application/x-pdf 之类浏览器自报类型误判为不合法。
  const mediaType = String(request.headers['content-type'] || '').split(';')[0].trim().toLowerCase()
  if (mediaType && !(mediaType === 'application/octet-stream' || mediaType.startsWith('application/'))) {
    throw fail(400, '电子书文件类型不受支持。')
  }

  const existing = await listEbookBooks()
  const sameIdentity = existing.find((book) => book.bookId === bookId)
  if (sameIdentity) {
    throw failWith(409, `《${sameIdentity.title}》已经保存在本机书架中。`, {
      duplicateBookId: sameIdentity.bookId,
      duplicateBookTitle: sameIdentity.title,
    })
  }
  if (checksum) {
    const sameContent = existing.find((book) => book.checksum && book.checksum === checksum)
    if (sameContent) {
      throw failWith(409, `这本文件已经在书架中：${sameContent.title}。`, {
        duplicateBookId: sameContent.bookId,
        duplicateBookTitle: sameContent.title,
      })
    }
  }

  await mkdir(ebooksRoot, { recursive: true })
  const temporaryDirectory = join(ebooksRoot, `.incoming-${randomUUID()}`)
  await mkdir(temporaryDirectory, { recursive: true })
  const target = join(temporaryDirectory, `source.${format}`)

  try {
    const written = await writeEbookStream(request, target, maximumEbookBytes)
    if (!written.size) throw fail(400, '电子书文件是空的，请重新选择文件。')
    if (expectedSize > 0 && expectedSize !== written.size) {
      throw fail(400, '电子书文件在传输过程中大小不一致，请重新导入。')
    }
    if (checksum && written.digest !== checksum) {
      throw fail(400, '电子书文件在传输过程中校验失败，请重新导入。')
    }
    await assertEbookSignature(target, format)
    // 判重以服务端自己算出的 SHA-256 为准：客户端可以不传校验值，
    // 文件先落盘到临时目录，发现重复再删掉，不会留下残留。
    const metadata = await withRepositoryWrite(async () => {
      const currentBooks = await listEbookBooks()
      const duplicateIdentity = currentBooks.find((book) => book.bookId === bookId)
      if (duplicateIdentity || existsSync(join(ebooksRoot, bookId))) {
        throw failWith(409, `《${duplicateIdentity?.title || title}》已经保存在本机书架中。`, { duplicateBookId: bookId })
      }
      const sameContent = currentBooks.find((book) => book.checksum && book.checksum === written.digest)
      if (sameContent) {
        throw failWith(409, `这本文件已经在书架中：${sameContent.title}。`, {
          duplicateBookId: sameContent.bookId,
          duplicateBookTitle: sameContent.title,
        })
      }
      const now = new Date().toISOString()
      const newMetadata = {
        bookId,
        title,
        author,
        format,
        fileName,
        mediaType: ebookMediaTypes.get(format),
        size: written.size,
        checksum: written.digest,
        importedAt: now,
        updatedAt: now,
        source: 'local',
      }
      await writeFile(join(temporaryDirectory, 'book.json'), `${JSON.stringify(newMetadata, null, 2)}\n`, { flag: 'wx' })
      await rename(temporaryDirectory, join(ebooksRoot, bookId))
      return newMetadata
    })
    return metadata
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

async function updateEbookBook(bookId, body) {
  if (!body || typeof body !== 'object') throw fail(400, '电子书信息不正确。')
  const directory = await resolveEbookDirectory(bookId)
  const metadata = await readEbookMetadata(directory)
  if (typeof body.title !== 'string' || !body.title.trim() || body.title.trim().length > 160) {
    throw fail(400, '书名需要为 1 到 160 个字符。')
  }
  metadata.title = body.title.trim()
  metadata.author = typeof body.author === 'string' ? body.author.trim().slice(0, 120) : metadata.author
  metadata.updatedAt = new Date().toISOString()
  await atomicWrite(join(directory, 'book.json'), `${JSON.stringify(metadata, null, 2)}\n`)
  return metadata
}

async function deleteEbookBook(bookId) {
  const directory = await resolveEbookDirectory(bookId)
  await rm(directory, { recursive: true, force: false })
}

async function serveEbookFile(bookId, response) {
  const directory = await resolveEbookDirectory(bookId)
  const metadata = await readEbookMetadata(directory)
  const filePath = join(directory, `source.${metadata.format}`)
  let fileStat
  try { fileStat = await stat(filePath) }
  catch { throw fail(404, '没有找到这本电子书的原文件，请重新导入。') }
  if (!fileStat.isFile()) throw fail(404, '没有找到这本电子书的原文件，请重新导入。')

  const downloadName = sanitizeEbookFileName(metadata.fileName, metadata.format)
  response.writeHead(200, {
    'Content-Type': metadata.mediaType || ebookMediaTypes.get(metadata.format),
    'Content-Length': fileStat.size,
    'Content-Disposition': `attachment; filename="ebook.${metadata.format}"; filename*=UTF-8''${encodeURIComponent(downloadName)}`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  })
  await new Promise((resolvePromise, rejectPromise) => {
    const stream = createReadStream(filePath)
    stream.on('error', rejectPromise)
    response.on('error', rejectPromise)
    response.on('close', resolvePromise)
    stream.pipe(response)
  })
}

function runGit(args, { timeout = 45_000, trimOutput = true } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('git', args, {
      cwd: root,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
    const stdout = []
    const stderr = []
    let outputBytes = 0
    const timer = setTimeout(() => child.kill(), timeout)
    child.stdout.on('data', (chunk) => { outputBytes += chunk.length; if (outputBytes <= 1024 * 1024) stdout.push(chunk) })
    child.stderr.on('data', (chunk) => { outputBytes += chunk.length; if (outputBytes <= 1024 * 1024) stderr.push(chunk) })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const stdoutText = Buffer.concat(stdout).toString('utf8')
      const stderrText = Buffer.concat(stderr).toString('utf8')
      const result = { code, stdout: trimOutput ? stdoutText.trim() : stdoutText, stderr: stderrText.trim() }
      if (code === 0) resolvePromise(result)
      else {
        const error = new Error(result.stderr || result.stdout || `Git 命令退出码 ${code}`)
        error.gitResult = result
        reject(error)
      }
    })
  })
}

function isManagedPath(filePath) {
  const normalized = filePath.replace(/\\/g, '/').replace(/^\?\? /, '')
  return normalized === 'content/books' || normalized.startsWith('content/books/')
}

function parseGitStatus(output) {
  const tokens = String(output || '').split('\0').filter(Boolean)
  const entries = []
  for (let index = 0; index < tokens.length; index += 1) {
    const record = tokens[index]
    if (record.length < 4) continue
    const status = record.slice(0, 2)
    entries.push({ status, path: record.slice(3) })
    if (status.includes('R') || status.includes('C')) {
      const originalPath = tokens[index + 1]
      if (originalPath) entries.push({ status, path: originalPath })
      index += 1
    }
  }
  return entries
}

function parseGitPathList(output) {
  return String(output || '').split('\0').filter(Boolean)
}

async function getGitStatus() {
  try {
    const [rootResult, statusResult, branchResult, upstreamResult] = await Promise.all([
      runGit(['rev-parse', '--show-toplevel']),
      runGit(['status', '--porcelain=v1', '-z', '--untracked-files=all'], { trimOutput: false }),
      runGit(['branch', '--show-current']),
      runGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']).catch(() => null),
    ])
    const repositoryRoot = resolve(rootResult.stdout)
    const isRepository = repositoryRoot.toLowerCase() === root.toLowerCase()
    const changes = parseGitStatus(statusResult.stdout)
    const hasUnmanagedChanges = changes.some(({ path }) => !isManagedPath(path))
    const remoteResult = await runGit(['remote']).catch(() => ({ stdout: '' }))
    return {
      isRepository,
      branch: branchResult.stdout,
      hasUpstream: Boolean(upstreamResult),
      hasRemote: Boolean(remoteResult.stdout),
      changedFiles: changes.length,
      canSync: isRepository && Boolean(upstreamResult) && !hasUnmanagedChanges && !runtime.syncing && runtime.queuedWrites === 0,
      hasUnmanagedChanges,
      syncing: runtime.syncing,
      saving: runtime.queuedWrites > 0,
    }
  } catch {
    return { isRepository: false, branch: '', hasUpstream: false, hasRemote: false, changedFiles: 0, canSync: false, hasUnmanagedChanges: false, syncing: runtime.syncing, saving: runtime.queuedWrites > 0 }
  }
}

async function synchronizeRepository() {
  if (runtime.syncing || runtime.queuedWrites > 0) throw fail(409, '本机数据保存正在排队或进行，请稍后再同步。')
  runtime.syncing = true
  try {
    const rootResult = await runGit(['rev-parse', '--show-toplevel'])
    if (resolve(rootResult.stdout).toLowerCase() !== root.toLowerCase()) throw fail(409, '当前目录不是学习平台仓库。')
    await runGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
      .catch(() => { throw fail(409, '当前分支还没有配置 GitHub 上游分支。') })

    const before = await runGit(['status', '--porcelain=v1', '-z', '--untracked-files=all'], { trimOutput: false })
    const changes = parseGitStatus(before.stdout)
    const unmanaged = changes.filter(({ path }) => !isManagedPath(path))
    if (unmanaged.length) throw fail(409, '仓库还有课程书籍以外的改动。请先单独整理这些改动，再同步课程。')

    const stagedBefore = await runGit(['diff', '--cached', '--name-only', '-z'], { trimOutput: false })
    if (parseGitPathList(stagedBefore.stdout).some((path) => !isManagedPath(path))) {
      throw fail(409, '仓库暂存区包含平台数据以外的文件，请先完成代码提交后再同步。')
    }

    await runGit(['add', '--', 'content/books'])
    const staged = await runGit(['diff', '--cached', '--name-only', '-z'], { trimOutput: false })
    if (parseGitPathList(staged.stdout).some((path) => !isManagedPath(path))) {
      throw fail(409, '同步范围包含了课程书籍以外的文件，已停止。')
    }
    const hasChanges = await runGit(['diff', '--cached', '--quiet']).then(() => false).catch(() => true)
    if (hasChanges) await runGit(['commit', '-m', 'sync: learning course content'])

    try {
      await runGit(['pull', '--rebase'])
    } catch (error) {
      await runGit(['rebase', '--abort']).catch(() => {})
      throw fail(409, `拉取时发生合并冲突，本机提交已保留。请先处理课程文件冲突后重试。${error.message}`)
    }
    await runGit(['push'])
    return { message: '同步完成。' }
  } finally {
    runtime.syncing = false
  }
}

async function handleApi(request, response, url) {
  const { pathname } = url
  const imageRoute = pathname.match(/^\/api\/books\/([a-zA-Z0-9._-]{1,120})\/assets\/(.+)$/)
  if (imageRoute && request.method === 'GET') {
    await serveBookImage(imageRoute[1], imageRoute[2], request, response)
    return true
  }
  if (pathname === '/api/status' && request.method === 'GET') {
    const git = await getGitStatus()
    json(response, 200, {
      recordCount: await listLocalEvents().then((events) => events.length).catch(() => null),
      git,
    })
    return true
  }

  if (pathname === '/api/books' && request.method === 'GET') {
    json(response, 200, { books: await listBooks() })
    return true
  }

  if (pathname === '/api/books' && request.method === 'POST') {
    assertLocalBrowser(request, { requireClientHeader: true })
    const book = await withRepositoryWrite(async () => createRepositoryBook(await readJson(request)))
    json(response, 201, { book })
    return true
  }

  const bookRoute = pathname.match(/^\/api\/books\/([a-zA-Z0-9._-]{1,120})$/)
  if (bookRoute && request.method === 'PATCH') {
    assertLocalBrowser(request, { requireClientHeader: true })
    const book = await withRepositoryWrite(async () => updateRepositoryBook(bookRoute[1], await readJson(request)))
    json(response, 200, { book })
    return true
  }
  if (bookRoute && request.method === 'DELETE') {
    assertLocalBrowser(request, { requireClientHeader: true })
    await withRepositoryWrite(() => deleteRepositoryBook(bookRoute[1]))
    json(response, 200, { deleted: true })
    return true
  }

  if (pathname === '/api/local/events' && request.method === 'GET') {
    assertLocalBrowser(request, { requireClientHeader: true })
    json(response, 200, { events: await listLocalEvents() })
    return true
  }

  if (pathname === '/api/local/events' && request.method === 'POST') {
    assertLocalBrowser(request, { requireClientHeader: true })
    const event = await appendLocalEvent(await readJson(request))
    json(response, 201, { event })
    return true
  }

  if (pathname === '/api/local/import' && request.method === 'POST') {
    assertLocalBrowser(request, { requireClientHeader: true })
    const result = await appendLocalEvents(await readJson(request))
    json(response, 201, result)
    return true
  }

  if (pathname === '/api/local/backups' && request.method === 'GET') {
    assertLocalBrowser(request, { requireClientHeader: true })
    json(response, 200, { backups: await listLocalBackups() })
    return true
  }

  if (pathname === '/api/local/backups' && request.method === 'POST') {
    assertLocalBrowser(request, { requireClientHeader: true })
    const backup = await withRepositoryWrite(() => createLocalBackup('manual'))
    json(response, 201, { backup })
    return true
  }

  const localBackupRoute = pathname.match(/^\/api\/local\/backups\/([0-9TZ-]+-[a-f0-9]{8})\/restore$/)
  if (localBackupRoute && request.method === 'POST') {
    assertLocalBrowser(request, { requireClientHeader: true })
    const result = await withRepositoryWrite(() => restoreLocalBackupSnapshot(localBackupRoute[1]))
    json(response, 200, result)
    return true
  }

  if (pathname === '/api/ebooks' && request.method === 'GET') {
    assertLocalBrowser(request)
    json(response, 200, { books: await listEbookBooks() })
    return true
  }

  if (pathname === '/api/ebooks' && request.method === 'POST') {
    assertLocalBrowser(request, { requireClientHeader: true })
    const book = await importEbookBook(request, url.searchParams)
    json(response, 201, { book })
    return true
  }

  const ebookRoute = pathname.match(/^\/api\/ebooks\/([a-zA-Z0-9._-]{1,120})$/)
  if (ebookRoute && request.method === 'GET') {
    assertLocalBrowser(request)
    json(response, 200, { book: await readEbookMetadata(await resolveEbookDirectory(ebookRoute[1])) })
    return true
  }
  if (ebookRoute && request.method === 'PATCH') {
    assertLocalBrowser(request, { requireClientHeader: true })
    const book = await withRepositoryWrite(async () => updateEbookBook(ebookRoute[1], await readJson(request)))
    json(response, 200, { book })
    return true
  }
  if (ebookRoute && request.method === 'DELETE') {
    assertLocalBrowser(request, { requireClientHeader: true })
    await withRepositoryWrite(() => deleteEbookBook(ebookRoute[1]))
    json(response, 200, { deleted: true })
    return true
  }

  const ebookFileRoute = pathname.match(/^\/api\/ebooks\/([a-zA-Z0-9._-]{1,120})\/file$/)
  if (ebookFileRoute && request.method === 'GET') {
    assertLocalBrowser(request)
    await serveEbookFile(ebookFileRoute[1], response)
    return true
  }

  if (pathname === '/api/sync/status' && request.method === 'GET') {
    assertLocalBrowser(request)
    json(response, 200, { git: await getGitStatus() })
    return true
  }

  if (pathname === '/api/sync' && request.method === 'POST') {
    assertLocalBrowser(request, { requireClientHeader: true })
    const result = await synchronizeRepository()
    json(response, 200, { ...result, git: await getGitStatus() })
    return true
  }

  return false
}

const contentTypes = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'],
  // PDF.js 的 worker 是 .mjs；缺少这一项会被当成 application/octet-stream，
  // 浏览器会拒绝动态 import，正式模式下 PDF 无法打开。
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'], ['.svg', 'image/svg+xml'], ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.webp', 'image/webp'],
  ['.woff2', 'font/woff2'], ['.ico', 'image/x-icon'],
])

async function serveApplication(request, response, url) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false
  const requestedPath = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)
  const candidate = resolve(distDirectory, `.${requestedPath}`)
  if (candidate !== distDirectory && !candidate.startsWith(`${distDirectory}${sep}`)) {
    json(response, 400, { error: '请求路径不合法。' })
    return true
  }
  let filePath = candidate
  try {
    if (!(await stat(filePath)).isFile()) filePath = join(distDirectory, 'index.html')
  } catch {
    filePath = join(distDirectory, 'index.html')
  }
  try {
    const body = await readFile(filePath)
    response.writeHead(200, {
      'Content-Type': contentTypes.get(extname(filePath)) || 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': filePath.endsWith('index.html') ? 'no-store' : 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    })
    response.end(request.method === 'HEAD' ? undefined : body)
    return true
  } catch {
    json(response, 503, { error: '尚未生成前端文件，请先运行 npm run build。' })
    return true
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || '/', `http://${request.headers.host || `127.0.0.1:${port}`}`)
  try {
    if (url.pathname.startsWith('/api/')) {
      const handled = await handleApi(request, response, url)
      if (!handled) json(response, 404, { error: '没有找到该接口。' })
      return
    }
    if (isProduction && await serveApplication(request, response, url)) return
    json(response, 404, { error: '没有找到该页面。' })
  } catch (error) {
    const status = Number.isInteger(error.status) ? error.status : 500
    if (status >= 500) console.error('本机服务请求失败。', error)
    if (!response.headersSent) {
      json(response, status, status >= 500 ? { error: '本机服务暂时无法完成操作。' } : { error: error.message, ...(error.extra || {}) })
    }
    else response.destroy()
  }
})

server.listen(port, '127.0.0.1', () => {
  console.log(`知序本机服务已启动：http://127.0.0.1:${port}`)
  if (isApiOnly) console.log('API 模式：课程接口与本机个人数据接口已就绪。')
  void ensureDailyLocalBackup().catch((error) => console.warn('本机自动快照暂未完成。', error))
  const backupTimer = setInterval(() => {
    void ensureDailyLocalBackup().catch((error) => console.warn('本机自动快照暂未完成。', error))
  }, 24 * 60 * 60 * 1000)
  backupTimer.unref()
})

server.on('error', (error) => {
  console.error(`无法启动本机服务：${error.message}`)
  process.exitCode = 1
})

process.on('SIGINT', () => {
  server.close(() => process.exit(0))
})
process.on('SIGTERM', () => {
  server.close(() => process.exit(0))
})
