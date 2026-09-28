const manifests = import.meta.glob('../../content/books/**/book.json', {
  eager: true,
  import: 'default',
})

const markdownFiles = import.meta.glob('../../content/books/**/*.md', {
  eager: true,
  query: '?raw',
  import: 'default',
})

const naturalOrder = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })
const validCategories = new Set(['技术', '人工智能', '产品设计', '通用能力'])
const validThemes = new Set(['blue', 'sand', 'night', 'sky', 'peach', 'mist', 'forest'])

/** Load books and chapters committed in content/books. */
export function getRepositoryBooks() {
  const ids = new Set()
  return Object.entries(manifests).flatMap(([manifestPath, metadata]) => {
    try {
      const book = createRepositoryBook(manifestPath, metadata)
      if (ids.has(book.id)) throw new Error(`课程 ID "${book.id}" 已被其他书籍使用。`)
      ids.add(book.id)
      return [book]
    } catch (error) {
      console.warn(`无法加载课程书籍 ${manifestPath}。`, error)
      return []
    }
  })
}

export async function loadRepositoryBooks() {
  try {
    const response = await fetch('/api/books')
    if (!response.ok) throw new Error('本机课程服务暂不可用。')
    const payload = await response.json()
    if (!Array.isArray(payload.books)) throw new Error('本机课程服务返回的数据不完整。')
    return payload.books
  } catch {
    return getRepositoryBooks()
  }
}

function createRepositoryBook(manifestPath, metadata) {
  if (!metadata || typeof metadata !== 'object') throw new Error('book.json 必须包含 JSON 对象。')

  const directory = manifestPath.slice(0, manifestPath.lastIndexOf('/') + 1)
  const directoryName = directory.split('/').filter(Boolean).at(-1) || 'course'
  const id = asText(metadata.id, directoryName)
  const title = asText(metadata.title, '')
  if (!title) throw new Error('book.json 缺少 title。')

  const documents = Object.entries(markdownFiles)
    .filter(([path]) => path.startsWith(directory))
    .map(([path, content]) => {
      const relativePath = path.slice(directory.length)
      return {
        id: `${id}:${relativePath}`,
        file: relativePath,
        title: markdownTitle(content, relativePath),
        content: String(content),
      }
    })
    .sort((a, b) => naturalOrder.compare(a.file, b.file))
    .map((document, order) => ({ ...document, order }))

  if (!documents.length) throw new Error('课程目录中没有 Markdown 章节。')

  return {
    id,
    title,
    coverTitle: asText(metadata.coverTitle, title),
    subtitle: asText(metadata.subtitle, 'Markdown 学习课程'),
    category: validCategories.has(metadata.category) ? metadata.category : '通用能力',
    theme: validThemes.has(metadata.theme) ? metadata.theme : 'blue',
    chapters: documents.length,
    progress: 0,
    lastRead: false,
    repositoryManaged: true,
    documents,
  }
}

function markdownTitle(content, filePath) {
  const heading = String(content).match(/^\s*#\s+(.+?)\s*#*\s*$/m)?.[1]
  if (heading?.trim()) return heading.trim()
  return filePath.replace(/\\/g, '/').split('/').at(-1).replace(/\.(md|markdown)$/i, '') || '未命名章节'
}

function asText(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}
