const DATABASE_NAME = 'zhixu-learning-library'
const DATABASE_VERSION = 1
const BOOKS_STORE = 'books'

let databasePromise

function openLibraryDatabase() {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('当前浏览器不支持本地课程存储。'))
  }

  if (!databasePromise) {
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)

      request.onupgradeneeded = () => {
        const database = request.result
        if (!database.objectStoreNames.contains(BOOKS_STORE)) {
          database.createObjectStore(BOOKS_STORE, { keyPath: 'id' })
        }
      }
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close()
        resolve(request.result)
      }
      request.onerror = () => reject(request.error || new Error('无法打开本地课程书架。'))
      request.onblocked = () => reject(new Error('课程书架正在更新，请关闭其他页面后重试。'))
    }).catch((error) => {
      databasePromise = undefined
      throw error
    })
  }

  return databasePromise
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('课程内容保存失败。'))
  })
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

/** Load imported course books from local storage. */
export async function listImportedBooks() {
  const database = await openLibraryDatabase()
  const transaction = database.transaction(BOOKS_STORE, 'readonly')
  const rows = await requestResult(transaction.objectStore(BOOKS_STORE).getAll())
  return rows.sort((a, b) => (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || ''))
}

/** Save a book in the same shape a future Agent/API adapter can provide. */
export async function saveImportedBook(book) {
  const database = await openLibraryDatabase()
  const transaction = database.transaction(BOOKS_STORE, 'readwrite')
  await transactionResult(transaction, transaction.objectStore(BOOKS_STORE).put(book))
  return book
}

/** Retrieve one imported book, including its Markdown documents. */
export async function getImportedBook(id) {
  const database = await openLibraryDatabase()
  const transaction = database.transaction(BOOKS_STORE, 'readonly')
  return requestResult(transaction.objectStore(BOOKS_STORE).get(id))
}

/** Remove an imported book from this browser's local library. */
export async function deleteImportedBook(id) {
  const database = await openLibraryDatabase()
  const transaction = database.transaction(BOOKS_STORE, 'readwrite')
  await transactionResult(transaction, transaction.objectStore(BOOKS_STORE).delete(id))
}
