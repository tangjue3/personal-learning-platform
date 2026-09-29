import { highlightToHtml } from './codeHighlight.js'

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character])
}

function codeBlockHtml(code, language) {
  const highlighted = highlightToHtml(code, language)
  const classes = [highlighted ? 'hljs' : '', language ? 'language-' + escapeHtml(language) : ''].filter(Boolean).join(' ')
  return '<pre><code' + (classes ? ' class="' + classes + '"' : '') + '>' + (highlighted || escapeHtml(code)) + '</code></pre>'
}

function renderInline(source, { links = true } = {}) {
  const fragments = []
  const protect = (html) => {
    const index = fragments.push(html) - 1
    return '\u0000' + index + '\u0000'
  }
  let text = String(source)
  text = text.replace(/\x60([^\x60\n]+)\x60/g, (_, code) => protect('<code>' + escapeHtml(code) + '</code>'))
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)(?:\s+"[^"]*")?\)/gi, (_, label, href) => {
    const safeLabel = escapeHtml(label)
    return protect(links
      ? '<a href="' + escapeHtml(href) + '" target="_blank" rel="noopener noreferrer">' + safeLabel + '</a>'
      : '<span class="note-markdown-link">' + safeLabel + '</span>')
  })

  text = escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__(.+?)__/g, '<strong>$1</strong>')
    .replace(/~~(.+?)~~/g, '<del>$1</del>')
    .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
    .replace(/_([^_\n]+)_/g, '<em>$1</em>')

  return text.replace(/\u0000(\d+)\u0000/g, (_, index) => fragments[Number(index)] || '')
}

export function renderNoteInline(source) {
  return renderInline(source, { links: false }).replace(/\r\n?|\n/g, '<br>')
}

export function renderNoteMarkdown(source) {
  const lines = String(source || '').replace(/\r\n?/g, '\n').split('\n')
  const output = []
  let paragraph = []
  let quote = []
  let listType = ''
  let listItems = []
  let codeLines = []
  let codeLanguage = ''
  let inCode = false

  const flushParagraph = () => {
    if (!paragraph.length) return
    output.push('<p>' + paragraph.map((line) => renderInline(line)).join('<br>') + '</p>')
    paragraph = []
  }
  const flushQuote = () => {
    if (!quote.length) return
    output.push('<blockquote>' + quote.map((line) => '<p>' + renderInline(line) + '</p>').join('') + '</blockquote>')
    quote = []
  }
  const flushList = () => {
    if (!listType) return
    output.push('<' + listType + '>' + listItems.map((item) => '<li>' + item + '</li>').join('') + '</' + listType + '>')
    listType = ''
    listItems = []
  }
  const flushTextBlocks = () => {
    flushParagraph()
    flushQuote()
    flushList()
  }

  for (const line of lines) {
    if (inCode) {
      if (/^\s*\x60{3}/.test(line)) {
        output.push(codeBlockHtml(codeLines.join('\n'), codeLanguage))
        codeLines = []
        codeLanguage = ''
        inCode = false
      } else {
        codeLines.push(line)
      }
      continue
    }

    const fence = line.match(/^\s*\x60{3}\s*([\w+-]*)\s*$/)
    if (fence) {
      flushTextBlocks()
      inCode = true
      codeLanguage = fence[1] || ''
      continue
    }

    const heading = line.match(/^\s{0,3}(#{1,4})\s+(.+?)\s*#*\s*$/)
    if (heading) {
      flushTextBlocks()
      const level = heading[1].length
      output.push('<h' + level + '>' + renderInline(heading[2]) + '</h' + level + '>')
      continue
    }

    if (/^\s{0,3}(---+|\*\*\*+|___+)\s*$/.test(line)) {
      flushTextBlocks()
      output.push('<hr>')
      continue
    }

    const quoteLine = line.match(/^\s{0,3}>\s?(.*)$/)
    if (quoteLine) {
      flushParagraph()
      flushList()
      quote.push(quoteLine[1])
      continue
    }

    const listLine = line.match(/^\s{0,3}([-+*]|\d+[.)])\s+(.+)$/)
    if (listLine) {
      flushParagraph()
      flushQuote()
      const nextListType = /^\d/.test(listLine[1]) ? 'ol' : 'ul'
      if (listType && listType !== nextListType) flushList()
      listType = nextListType
      const taskItem = listLine[2].match(/^\[([ xX])\]\s+(.+)$/)
      listItems.push(taskItem
        ? '<span class="note-task-mark">' + (taskItem[1].trim() ? '☑' : '☐') + '</span> ' + renderInline(taskItem[2])
        : renderInline(listLine[2]))
      continue
    }

    if (!line.trim()) {
      flushTextBlocks()
      continue
    }

    flushQuote()
    flushList()
    paragraph.push(line)
  }

  if (inCode) output.push(codeBlockHtml(codeLines.join('\n'), codeLanguage))
  flushTextBlocks()
  return output.join('')
}
