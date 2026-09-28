/**
 * 旧版浏览器电子书存储（仅用于迁移）。
 *
 * 电子书原文件早期保存在 IndexedDB 的 `personal-learning-ebook-files`
 * 数据库中。现在主存储是本机目录 data/local/ebooks/<bookId>/，这里只保留
 * 读取与删除旧数据库的能力，供迁移使用。迁移只在应用且本机服务可用时执行，
 * 服务不可用时不会删除任何浏览器数据。
 *
 * 连接管理约定：
 * - 每次操作都新建一个连接，事务结束后立刻关闭，绝不复用已关闭的连接
 *   （复用会抛 InvalidStateError，导致后续读取被误判为“没有旧数据”）。
 * - 能通过 indexedDB.databases() 判断库不存在时，完全不调用 open()，
 *   避免给没有旧数据的新用户创建空数据库。
 * - 只有在无法判断时才退回到 open()；此时若 event.oldVersion === 0，说明
 *   是我们刚建出来的空库，关闭并删除它，同样不留下空数据库。
 */

const DATABASE_NAME = 'personal-learning-ebook-files'
const DATABASE_VERSION = 3
const FILES_STORE = 'files'
const PROGRESS_STORE = 'progress'
const NOTES_STORE = 'notes'

function createLegacyUnavailableError() {
  const error = new Error('当前浏览器没有旧版电子书存储，无需迁移。')
  error.legacyUnavailable = true
  return error
}

/** 旧库不存在或 store 缺失都按“没有旧数据”处理，不算迁移失败。 */
function isMissingLegacyData(error) {
  return Boolean(error?.legacyUnavailable)
    || error?.name === 'NotFoundError'
    || error?.name === 'VersionError'
}

function upgradeLegacySchema(database) {
  const filesStore = database.objectStoreNames.contains(FILES_STORE)
    ? database.transaction.objectStore(FILES_STORE)
    : database.createObjectStore(FILES_STORE, { keyPath: 'bookId' })
  if (!filesStore.indexNames.contains('checksum')) filesStore.createIndex('checksum', 'checksum', { unique: true })
  if (!filesStore.indexNames.contains('size')) filesStore.createIndex('size', 'size')
  if (!database.objectStoreNames.contains(PROGRESS_STORE)) database.createObjectStore(PROGRESS_STORE, { keyPath: 'bookId' })
  if (!database.objectStoreNames.contains(NOTES_STORE)) database.createObjectStore(NOTES_STORE, { keyPath: 'id' })
}

/** null 表示当前浏览器无法判断；false 表示确认没有旧库。 */
async function legacyDatabaseExists() {
  if (typeof indexedDB === 'undefined') return false
  if (typeof indexedDB.databases !== 'function') return null
  try {
    const databases = await indexedDB.databases()
    return databases.some((entry) => entry?.name === DATABASE_NAME)
  } catch {
    return null
  }
}

function discardEmptyLegacyDatabase() {
  try {
    const request = indexedDB.deleteDatabase(DATABASE_NAME)
    request.onerror = () => { /* Best effort: an empty database is harmless. */ }
    request.onblocked = () => { /* Another tab holds it; it stays empty and unused. */ }
  } catch { /* Deleting is only a cleanup, never a requirement. */ }
}

function openLegacyConnection() {
  return new Promise((resolve, reject) => {
    let createdEmptyDatabase = false
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)

    request.onupgradeneeded = (event) => {
      // oldVersion === 0 表示这个库是我们刚刚建出来的，里面没有任何旧数据；
      // 不能建 store，否则会留下一个空数据库。
      if (event.oldVersion === 0) {
        createdEmptyDatabase = true
        return
      }
      upgradeLegacySchema(request.result)
    }

    request.onsuccess = () => {
      const database = request.result
      // 其他标签页改动结构时主动让出连接，避免阻塞对方。
      database.onversionchange = () => {
        try { database.close() } catch { /* The connection is already closed. */ }
      }
      if (createdEmptyDatabase) {
        database.close()
        discardEmptyLegacyDatabase()
        reject(createLegacyUnavailableError())
        return
      }
      resolve(database)
    }

    request.onerror = () => reject(request.error ?? new Error('无法打开旧版电子书存储。'))
    request.onblocked = () => reject(new Error('旧版电子书存储正在被其他页面占用，请关闭重复打开的平台页面后重试。'))
  })
}

async function openLegacyDatabase() {
  if (typeof indexedDB === 'undefined') throw createLegacyUnavailableError()
  const exists = await legacyDatabaseExists()
  if (exists === false) throw createLegacyUnavailableError()
  return openLegacyConnection()
}

function runInStore(database, storeName, mode, operation) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, mode)
    const store = transaction.objectStore(storeName)
    let request

    try {
      request = operation(store)
    } catch (error) {
      reject(error)
      return
    }

    transaction.oncomplete = () => resolve(request?.result)
    transaction.onerror = () => reject(transaction.error ?? new Error('旧版电子书存储操作失败。'))
    transaction.onabort = () => reject(transaction.error ?? new Error('旧版电子书存储操作已取消。'))
  })
}

/** 打开一个新连接，执行一个事务，然后无论成败都关闭连接。 */
async function requestInStore(storeName, mode, operation) {
  const database = await openLegacyDatabase()
  try {
    return await runInStore(database, storeName, mode, operation)
  } finally {
    try { database.close() } catch { /* The connection is already closed. */ }
  }
}

/** List legacy ebook records without their file blobs. */
export async function listLegacyEbookFiles() {
  try {
    const records = await requestInStore(FILES_STORE, 'readonly', (store) => store.getAll())
    return (records ?? []).map(({ blob, ...metadata }) => metadata)
  } catch (error) {
    if (isMissingLegacyData(error)) return []
    throw error
  }
}

/** Read one legacy ebook record, including the file blob. */
export async function getLegacyEbookFile(bookId) {
  if (!bookId) return null
  try {
    return await requestInStore(FILES_STORE, 'readonly', (store) => store.get(String(bookId)))
  } catch (error) {
    if (isMissingLegacyData(error)) return null
    throw error
  }
}

/** Remove a legacy ebook file after a verified local copy exists. */
export async function deleteLegacyEbookFile(bookId) {
  if (!bookId) return
  try {
    await requestInStore(FILES_STORE, 'readwrite', (store) => store.delete(String(bookId)))
  } catch (error) {
    if (isMissingLegacyData(error)) return
    throw error
  }
}

export async function getLegacyReadingProgress(bookId) {
  if (!bookId) return null
  try {
    return await requestInStore(PROGRESS_STORE, 'readonly', (store) => store.get(String(bookId)))
  } catch (error) {
    if (isMissingLegacyData(error)) return null
    throw error
  }
}

export async function deleteLegacyReadingProgress(bookId) {
  if (!bookId) return
  try {
    await requestInStore(PROGRESS_STORE, 'readwrite', (store) => store.delete(String(bookId)))
  } catch (error) {
    if (isMissingLegacyData(error)) return
    throw error
  }
}

/** Read notes saved by the earlier IndexedDB prototype so they can be moved
 * into the canonical local records.json store without losing annotations. */
export async function listLegacyReadingNotes(bookId) {
  try {
    const records = await requestInStore(NOTES_STORE, 'readonly', (store) => store.getAll())
    return (records ?? [])
      .filter((record) => !bookId || record.bookId === bookId)
      .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))
  } catch (error) {
    if (isMissingLegacyData(error)) return []
    throw error
  }
}

export async function deleteLegacyReadingNote(noteId) {
  if (!noteId) return
  try {
    await requestInStore(NOTES_STORE, 'readwrite', (store) => store.delete(String(noteId)))
  } catch (error) {
    if (isMissingLegacyData(error)) return
    throw error
  }
}
