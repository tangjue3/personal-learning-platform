/**
 * 旧版 IndexedDB 电子书迁移。
 *
 * 迁移规则：
 * 1. 只在本机文件服务可用时执行；服务不可用时保持旧数据不动，旧书仍在书架显示。
 * 2. 先把浏览器里的原文件复制到 data/local/ebooks/<bookId>/，服务端按流式
 *    写入并重算 SHA-256，客户端再核对大小与校验值。
 * 3. 只有本机副本校验通过，才删除对应的浏览器副本。
 * 4. 任一步骤失败都保留浏览器原副本，书籍继续显示，并记录失败原因供重试。
 */

import { reactive } from 'vue'
import { deleteEbookFile, getEbookFile, listEbookFiles, saveEbookFile } from './ebookFileStore.js'
import {
  deleteLegacyEbookFile,
  deleteLegacyReadingNote,
  deleteLegacyReadingProgress,
  getLegacyEbookFile,
  getLegacyReadingProgress,
  listLegacyEbookFiles,
  listLegacyReadingNotes,
} from './legacyEbookStore.js'
import { getLocalRecord, saveLocalRecord } from './localDataStore.js'

export const ebookMigrationState = reactive({
  status: 'idle', // idle | running | done | error
  serviceAvailable: false,
  pending: 0,
  migrated: 0,
  failures: [],
  error: '',
  lastRunAt: '',
  running: false,
})

/**
 * Ebook metadata for books that still live only in the browser database.
 *
 * 本机服务不可用时也返回旧库中的书目（标记 serviceOffline），让旧书继续在
 * 书架显示；此时不做任何删除，也不判定迁移成功。
 */
export async function listPendingEbooks() {
  const legacyRecords = await listLegacyEbookFiles()
  const localBooks = await listEbookFiles().catch(() => null)
  if (!Array.isArray(localBooks)) {
    return legacyRecords.map((record) => ({ ...record, serviceOffline: true }))
  }
  const localIds = new Set(localBooks.map((book) => String(book.bookId)))
  return legacyRecords
    .filter((record) => !localIds.has(String(record.bookId)))
    .map((record) => ({ ...record, serviceOffline: false }))
}

/**
 * 按旧版阅读器的规则恢复阅读进度：PDF 的字符串位置是页码，EPUB 的是 CFI；
 * 对象位置原样保留并补齐旧阅读器会补的字段。只有 records.json 写入成功后，
 * 才删除对应的旧进度记录。
 */
async function migrateLegacyProgress(bookId, format) {
  const legacy = await getLegacyReadingProgress(bookId).catch(() => null)
  if (!legacy) return
  const position = legacy.position
  // 空字符串是旧阅读器会接受的“无位置”，同样按旧规则恢复。
  if (position === undefined || position === null) return

  let restored = null
  if (typeof position === 'string') {
    restored = format === 'pdf' ? { page: Number(position) || 1 } : { cfi: position }
  } else if (typeof position === 'object' && !Array.isArray(position)) {
    restored = {
      ...position,
      page: Number(position.page) || 1,
      cfi: typeof position.cfi === 'string' ? position.cfi : '',
    }
  }
  if (!restored) return

  if (!getLocalRecord('reader', String(bookId))) {
    await saveLocalRecord('reader', String(bookId), restored)
  }
  await deleteLegacyReadingProgress(bookId)
}

async function migrateLegacyNotes(bookId, bookTitle) {
  const legacyNotes = await listLegacyReadingNotes(bookId).catch(() => [])
  for (const legacy of legacyNotes) {
    try {
      if (!getLocalRecord('note', legacy.id)) {
        await saveLocalRecord('note', legacy.id, {
          title: `${legacy.chapterTitle || bookTitle || '未命名书籍'} · 摘录`.slice(0, 120),
          content: String(legacy.content || '').trim(),
          excerpt: String(legacy.excerpt || '').trim(),
          bookId: legacy.bookId,
          chapterId: legacy.chapterId || '',
          chapterTitle: legacy.chapterTitle || '',
          format: legacy.format || 'markdown',
          anchor: legacy.anchor || null,
          color: legacy.color || 'yellow',
          createdAt: legacy.createdAt || new Date().toISOString(),
          updatedAt: legacy.updatedAt || legacy.createdAt || new Date().toISOString(),
        })
      }
      await deleteLegacyReadingNote(legacy.id)
    } catch (error) {
      console.warn('迁移旧版阅读笔记失败，笔记仍保留在浏览器存储中。', error)
    }
  }
}

/** 校验不通过时撤掉刚写的本机副本，让浏览器副本继续作为唯一可信来源，
 *  这样下次重试会重新复制，不会因为残留的半成品目录而永远跳过这本书。 */
async function discardLocalCopy(bookId) {
  try {
    await deleteEbookFile(bookId)
  } catch (error) {
    console.warn('清理未通过校验的本机副本失败，书架会显示为待迁移。', error)
  }
}

async function migrateOneEbook(record) {
  const bookId = String(record.bookId)
  const legacyFile = await getLegacyEbookFile(bookId)
  if (!legacyFile?.blob) {
    throw new Error('浏览器中的电子书原文件已缺失，无法复制到本机目录。')
  }

  const saved = await saveEbookFile({
    bookId,
    file: legacyFile.blob,
    format: legacyFile.format,
    title: legacyFile.title,
    author: legacyFile.author || '',
    fileName: legacyFile.fileName,
    // 这份文件在首次导入时已经校验过，迁移时不再重复做浏览器端结构预检；
    // 大小与 SHA-256 仍会与浏览器副本逐项核对。
    skipStructureValidation: true,
  })

  const localCopy = await getEbookFile(saved.bookId).catch(() => null)
  if (!localCopy) throw new Error('本机目录中没有找到刚保存的电子书，迁移未完成。')

  const legacySize = Number(legacyFile.size)
  const mismatch = Number.isFinite(legacySize) && legacySize > 0 && legacySize !== Number(localCopy.size)
    ? new Error('本机副本大小与浏览器副本不一致，迁移未完成。')
    : legacyFile.checksum && localCopy.checksum && legacyFile.checksum !== localCopy.checksum
      ? new Error('本机副本 SHA-256 与浏览器副本不一致，迁移未完成。')
      : null
  if (mismatch) {
    await discardLocalCopy(bookId)
    throw mismatch
  }

  await migrateLegacyProgress(bookId, legacyFile.format)
  await migrateLegacyNotes(bookId, legacyFile.title)

  // Only now, with a verified local copy in place, drop the browser copy.
  await deleteLegacyEbookFile(bookId)
  return saved
}

/**
 * 通知书架重新装载电子书条目。只要这一轮迁移正常跑完就发事件（包括“没有
 * 需要迁移的书”），否则重试后已经在本机目录里的书会一直留着过期的
 * “待迁移”角标。
 */
function notifyEbooksMigrated(count) {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent('zhixu:ebooks-migrated', { detail: { count } }))
}

/**
 * Migrate every legacy ebook that has no verified local copy yet.
 * Never throws: failures are reported through ebookMigrationState.failures.
 */
export async function runEbookMigration() {
  if (ebookMigrationState.running) {
    return { migrated: [], failures: ebookMigrationState.failures }
  }

  ebookMigrationState.running = true
  ebookMigrationState.status = 'running'
  ebookMigrationState.error = ''
  const migrated = []
  const failures = []

  try {
    const localBooks = await listEbookFiles()
    ebookMigrationState.serviceAvailable = true
    const legacyRecords = await listLegacyEbookFiles()
    const localIds = new Set(localBooks.map((book) => String(book.bookId)))
    const targets = legacyRecords.filter((record) => !localIds.has(String(record.bookId)))
    ebookMigrationState.pending = targets.length

    for (const record of targets) {
      try {
        migrated.push(await migrateOneEbook(record))
      } catch (error) {
        failures.push({
          bookId: String(record.bookId),
          title: String(record.title || record.fileName || '未命名电子书'),
          reason: error?.message || '迁移失败，请重试。',
        })
      }
    }

    ebookMigrationState.migrated = migrated.length
    ebookMigrationState.failures = failures
    // pending 表示“仍未迁到本机目录”的数量，成功后必须归零。
    ebookMigrationState.pending = failures.length
    ebookMigrationState.status = failures.length ? 'error' : 'done'
    ebookMigrationState.lastRunAt = new Date().toISOString()
    notifyEbooksMigrated(migrated.length)
    return { migrated, failures }
  } catch (error) {
    // 本机服务不可用：旧数据一条都不动，也不宣称迁移成功。
    ebookMigrationState.serviceAvailable = false
    ebookMigrationState.status = 'error'
    ebookMigrationState.error = error?.message || '无法连接本机电子书服务，旧数据保持不变。'
    ebookMigrationState.failures = []
    ebookMigrationState.migrated = 0
    const legacyCount = await listLegacyEbookFiles()
      .then((records) => records.length)
      .catch(() => ebookMigrationState.pending)
    ebookMigrationState.pending = legacyCount
    ebookMigrationState.lastRunAt = new Date().toISOString()
    return { migrated, failures }
  } finally {
    ebookMigrationState.running = false
  }
}

/** Retry the migrations that failed on the previous run. */
export async function retryEbookMigration() {
  return runEbookMigration()
}

/**
 * Make sure a local copy exists for one book, migrating it on demand when the
 * automatic run could not finish. Throws with a readable reason when the file
 * cannot be recovered, so the reader can keep the browser copy untouched.
 */
export async function ensureEbookAvailable(bookId) {
  const existing = await getEbookFile(bookId).catch(() => null)
  if (existing) return existing
  const legacy = await getLegacyEbookFile(bookId).catch(() => null)
  if (!legacy?.blob) {
    throw new Error('本机目录中没有这本电子书，浏览器里也找不到可迁移的原文件，请重新导入。')
  }
  await migrateOneEbook(legacy)
  const migrated = await getEbookFile(bookId).catch(() => null)
  if (!migrated) throw new Error('这本电子书没能保存到本机目录，浏览器中的副本已保留。')
  return migrated
}
