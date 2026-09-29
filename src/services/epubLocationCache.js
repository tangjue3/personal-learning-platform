/**
 * EPUB 分页定位表缓存。
 *
 * epub.js 的 locations.generate(900) 要把整本书按 900 字符一页重新切分，
 * 大书每次打开都要花数秒。定位表只由书的内容决定（与视口、字号无关），
 * 因此按书籍缓存进 IndexedDB，并以电子书 SHA-256 作为失效依据：文件换过
 * 就重新生成，缓存读写失败都静默降级，不影响打开书本。
 */

const DATABASE_NAME = 'zhixu-epub-locations'
const DATABASE_VERSION = 1
const LOCATIONS_STORE = 'locations'

let databasePromise

function openDatabase() {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('当前浏览器不支持本地缓存。'))
  }
  if (!databasePromise) {
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
      request.onupgradeneeded = () => {
        const database = request.result
        if (!database.objectStoreNames.contains(LOCATIONS_STORE)) {
          database.createObjectStore(LOCATIONS_STORE, { keyPath: 'bookId' })
        }
      }
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close()
        resolve(request.result)
      }
      request.onerror = () => reject(request.error || new Error('无法打开定位缓存。'))
      request.onblocked = () => reject(new Error('定位缓存正在被其他页面占用。'))
    }).catch((error) => {
      databasePromise = undefined
      throw error
    })
  }
  return databasePromise
}

function runInStore(mode, operation) {
  return openDatabase().then((database) => new Promise((resolve, reject) => {
    const transaction = database.transaction(LOCATIONS_STORE, mode)
    const request = operation(transaction.objectStore(LOCATIONS_STORE))
    transaction.oncomplete = () => resolve(request?.result)
    transaction.onerror = () => reject(transaction.error ?? new Error('定位缓存操作失败。'))
    transaction.onabort = () => reject(transaction.error ?? new Error('定位缓存操作已取消。'))
  }))
}

/** 读取某本书的定位表缓存；没有缓存或出错时返回 null。 */
export async function getEpubLocations(bookId) {
  if (!bookId) return null
  try {
    return await runInStore('readonly', (store) => store.get(String(bookId))) || null
  } catch {
    return null
  }
}

/** 保存定位表；失败静默，缓存只是加速手段。 */
export async function saveEpubLocations(bookId, checksum, locations) {
  if (!bookId || !locations) return
  try {
    await runInStore('readwrite', (store) => store.put({
      bookId: String(bookId),
      checksum: String(checksum || ''),
      locations,
      savedAt: new Date().toISOString(),
    }))
  } catch { /* 缓存写入失败不影响阅读。 */ }
}
