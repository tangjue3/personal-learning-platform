const DATABASE_NAME = 'zhixu-learning-library'
const BOOKS_STORE = 'books'

async function libraryDatabaseExists() {
  if (typeof indexedDB === 'undefined') return false
  if (typeof indexedDB.databases !== 'function') return null
  try {
    const databases = await indexedDB.databases()
    return databases.some((entry) => entry?.name === DATABASE_NAME)
  } catch {
    return null
  }
}

function discardEmptyLibraryDatabase() {
  try {
    const request = indexedDB.deleteDatabase(DATABASE_NAME)
    request.onerror = () => { /* Cleanup only; the empty database contains no user data. */ }
    request.onblocked = () => { /* Another tab may hold it open; it remains empty. */ }
  } catch { /* Best effort cleanup. */ }
}

async function openExistingLibraryDatabase() {
  if (typeof indexedDB === 'undefined') return null
  if (await libraryDatabaseExists() === false) return null
  return new Promise((resolve, reject) => {
    let createdEmptyDatabase = false
    const request = indexedDB.open(DATABASE_NAME)

    request.onupgradeneeded = (event) => {
      // Opening a missing legacy database creates an empty one; do not add a
      // store or keep that database around for new users.
      if (event.oldVersion === 0) createdEmptyDatabase = true
    }
    request.onsuccess = () => {
      const database = request.result
      database.onversionchange = () => database.close()
      if (createdEmptyDatabase) {
        database.close()
        discardEmptyLibraryDatabase()
        resolve(null)
        return
      }
      if (!database.objectStoreNames.contains(BOOKS_STORE)) {
        database.close()
        reject(new Error('旧版课程书架格式不受支持。'))
        return
      }
      resolve(database)
    }
    request.onerror = () => reject(request.error || new Error('无法读取旧版课程书架。'))
    request.onblocked = () => reject(new Error('旧版课程书架正在更新，请关闭其他页面后重试。'))
  })
}

async function runInLibraryStore(mode, operation) {
  const database = await openExistingLibraryDatabase()
  if (!database) return null
  try {
    const transaction = database.transaction(BOOKS_STORE, mode)
    return await transactionResult(transaction, operation(transaction.objectStore(BOOKS_STORE)))
  } finally {
    database.close()
  }
}

function transactionResult(transaction, request) {
  return new Promise((resolve, reject) => {
    let result
    request.onsuccess = () => { result = request.result }
    request.onerror = () => reject(request.error || new Error('课程内容保存失败。'))
    transaction.oncomplete = () => resolve(result)
    transaction.onabort = () => reject(transaction.error || new Error('课程内容保存失败。'))
    transaction.onerror = () => reject(transaction.error || new Error('课程内容保存失败。'))
  })
}

/** Read old browser-imported books only so the user can move them into content/books. */
export async function listImportedBooks() {
  const rows = await runInLibraryStore('readonly', (store) => store.getAll())
  return (rows || []).sort((a, b) => (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || ''))
}

/** Delete a legacy row only after a successful move into content/books. */
export async function deleteImportedBook(id) {
  await runInLibraryStore('readwrite', (store) => store.delete(id))
}
