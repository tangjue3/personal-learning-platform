/**
 * 本机电子书文件服务。
 *
 * EPUB/PDF 原文件保存在项目本机目录 data/local/ebooks/<bookId>/ 下，由
 * server/index.js 提供读写接口；浏览器不再保存电子书文件，也不再把文件
 * 转成 Base64 或写进 data/local/records.json。
 */

const EBOOK_API = '/api/ebooks'
const SUPPORTED_FORMATS = new Set(['epub', 'pdf'])

/**
 * 超过这个大小时跳过浏览器端的 EPUB/PDF 结构预检。
 *
 * 结构预检必须把整份文件读进内存（file.arrayBuffer()），对几百 MB 的电子书
 * 来说是一次性占用接近一份文件大小的堆内存。文件头由服务端落盘后再次校验，
 * 真正的可读性在阅读器打开时也会暴露，因此大文件不值得为一次预检付出这份
 * 代价。服务端始终是全链路流式的，与这个阈值无关。
 */
export const STRUCTURE_PRECHECK_LIMIT_BYTES = 64 * 1024 * 1024

async function requestEbookApi(path, options = {}) {
  const headers = new Headers(options.headers || {})
  headers.set('X-Zhixu-Client', 'local-ui')

  let response
  try {
    response = await fetch(`${EBOOK_API}${path}`, { ...options, headers, credentials: 'same-origin' })
  } catch {
    throw new Error('本机电子书服务未连接。请从平台目录运行 npm run dev:app 后重试。')
  }

  if (response.status === 204) return null
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(payload.error || '本机电子书服务暂时无法完成操作。')
    if (payload.duplicateBookId) {
      error.duplicateBookId = payload.duplicateBookId
      error.duplicateBookTitle = payload.duplicateBookTitle
    }
    throw error
  }
  return payload
}

function resolveFormat(fileName, requestedFormat) {
  const format = String(requestedFormat || String(fileName || '').split('.').pop() || '').toLowerCase()
  if (!SUPPORTED_FORMATS.has(format)) {
    throw new Error('目前只支持导入 EPUB 和 PDF 文件。')
  }

  const extension = String(fileName || '').split('.').pop()?.toLowerCase()
  if (extension && extension !== format) {
    throw new Error('文件格式与文件扩展名不一致，请检查后重试。')
  }

  return format
}

async function validateSignature(file, format) {
  const bytes = new Uint8Array(await file.slice(0, 8).arrayBuffer())

  if (format === 'pdf') {
    const signature = String.fromCharCode(...bytes.slice(0, 5))
    if (signature !== '%PDF-') {
      throw new Error('这个文件没有有效的 PDF 文件头，无法导入。')
    }
    return
  }

  const isZipContainer = bytes[0] === 0x50
    && bytes[1] === 0x4b
    && bytes[2] === 0x03
    && bytes[3] === 0x04
  if (!isZipContainer) {
    throw new Error('这个文件不像有效的 EPUB 电子书，请确认文件没有损坏。')
  }
}

async function validateDocumentStructure(file, format) {
  if (format === 'epub') {
    let book
    try {
      const epubModule = await import('epubjs')
      const createBook = epubModule.default || epubModule
      book = createBook(await file.arrayBuffer())
      await book.ready
      const spine = await book.loaded.spine
      if (!spine?.spineItems?.length) throw new Error('EPUB 中没有可阅读的章节。')
    } catch (error) {
      if (error?.message === 'EPUB 中没有可阅读的章节。') throw error
      throw new Error('EPUB 目录或章节内容无法读取，文件可能已损坏。')
    } finally {
      try { book?.destroy() } catch { /* Validation has already completed or failed. */ }
    }
    return
  }

  let loadingTask
  let document
  try {
    const [pdfModule, workerModule] = await Promise.all([
      import('pdfjs-dist'),
      import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
    ])
    pdfModule.GlobalWorkerOptions.workerSrc = workerModule.default
    loadingTask = pdfModule.getDocument({
      data: new Uint8Array(await file.arrayBuffer()),
      isEvalSupported: false,
      enableXfa: false,
    })
    document = await loadingTask.promise
    if (!document.numPages) throw new Error('PDF 中没有页面。')
    await document.getPage(1)
  } catch (error) {
    if (error?.message === 'PDF 中没有页面。') throw error
    if (error?.name === 'PasswordException') throw new Error('这份 PDF 设置了打开密码，当前版本暂不支持导入。')
    throw new Error('PDF 页面无法读取，文件可能已损坏或格式不受支持。')
  } finally {
    try { await document?.destroy() } catch { /* Release validation resources if they were created. */ }
    if (!document) try { await loadingTask?.destroy() } catch { /* Ignore a partially opened document. */ }
  }
}

/**
 * Import an EPUB/PDF file into the local project directory
 * data/local/ebooks/<bookId>/.
 *
 * 上传是把文件对象直接作为 fetch body 交给浏览器，由本机 Node 服务边收边写盘
 * 并重算 SHA-256，不转 Base64、不整份读进内存。重复文件由服务端按 SHA-256
 * 判定（返回 409 与 duplicateBookId），因此这里不再为预检重复而先把整份文件
 * 读成 ArrayBuffer。
 */
export async function saveEbookFile({
  bookId,
  file,
  format,
  title,
  author = '',
  fileName = '',
  skipStructureValidation = false,
}) {
  if (!bookId || typeof bookId !== 'string') {
    throw new Error('缺少书籍标识，无法保存电子书。')
  }
  if (!(file instanceof Blob)) {
    throw new Error('请选择有效的 EPUB 或 PDF 文件。')
  }

  const resolvedFileName = String(fileName || file.name || '')
  const resolvedFormat = resolveFormat(resolvedFileName, format)
  await validateSignature(file, resolvedFormat)

  // 大文件跳过浏览器端结构预检，避免为一次性校验占用接近一份文件大小的内存。
  let structurePrecheckSkipped = false
  if (!skipStructureValidation) {
    if (file.size > STRUCTURE_PRECHECK_LIMIT_BYTES) structurePrecheckSkipped = true
    else await validateDocumentStructure(file, resolvedFormat)
  }

  const normalizedTitle = String(title || resolvedFileName.replace(/\.[^.]+$/, '')).trim()
  if (!normalizedTitle) {
    throw new Error('请填写书名。')
  }
  const mediaType = file.type || (resolvedFormat === 'pdf' ? 'application/pdf' : 'application/epub+zip')

  const params = new URLSearchParams({
    bookId,
    format: resolvedFormat,
    title: normalizedTitle,
    author: String(author).trim(),
    fileName: resolvedFileName || `ebook.${resolvedFormat}`,
    size: String(file.size),
  })

  const payload = await requestEbookApi(`?${params.toString()}`, {
    method: 'POST',
    headers: { 'Content-Type': mediaType },
    body: file,
  })
  return { ...payload.book, structurePrecheckSkipped }
}

/** Read ebook metadata (title, author, format, size, checksum) from the local directory. */
export async function getEbookFile(bookId) {
  if (!bookId) return null
  const payload = await requestEbookApi(`/${encodeURIComponent(String(bookId))}`)
  return payload.book
}

/** 本机电子书原文件的接口地址；服务端支持 HTTP Range，可供 PDF.js 分块加载。 */
export function getEbookFileUrl(bookId) {
  if (!bookId) throw new Error('缺少书籍标识，无法读取电子书文件。')
  return `${EBOOK_API}/${encodeURIComponent(String(bookId))}/file`
}

async function fetchEbookFile(bookId) {
  let response
  try {
    response = await fetch(getEbookFileUrl(bookId), {
      headers: { 'X-Zhixu-Client': 'local-ui' },
      credentials: 'same-origin',
    })
  } catch {
    throw new Error('本机电子书服务未连接。请从平台目录运行 npm run dev:app 后重试。')
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}))
    throw new Error(payload.error || '找不到这本电子书的本机文件，请重新导入。')
  }
  return response
}

/** 把 EPUB 原文件整份读成 ArrayBuffer。JSZip 需要完整缓冲区，但直接从网络
 *  流读成一份 ArrayBuffer，避免先落 Blob 再复制一份的双倍内存。 */
export async function loadEbookArrayBuffer(bookId) {
  if (!bookId) throw new Error('缺少书籍标识，无法读取电子书文件。')
  return (await fetchEbookFile(bookId)).arrayBuffer()
}

/** Load the original EPUB/PDF file as a Blob for EPUB.js / PDF.js. */
export async function loadEbookBlob(bookId) {
  if (!bookId) throw new Error('缺少书籍标识，无法读取电子书文件。')
  return (await fetchEbookFile(bookId)).blob()
}

/** Create a temporary blob URL for the original file (used by export). */
export async function createEbookObjectUrl(bookId) {
  return URL.createObjectURL(await loadEbookBlob(bookId))
}

export async function listEbookFiles() {
  const payload = await requestEbookApi('')
  return Array.isArray(payload.books) ? payload.books : []
}

export async function updateEbookMetadata(bookId, changes = {}) {
  if (!bookId) throw new Error('缺少书籍标识，无法更新书目信息。')
  const payload = await requestEbookApi(`/${encodeURIComponent(String(bookId))}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: changes.title,
      author: changes.author,
    }),
  })
  return payload.book
}

export async function deleteEbookFile(bookId) {
  if (!bookId) return
  await requestEbookApi(`/${encodeURIComponent(String(bookId))}`, { method: 'DELETE' })
}
