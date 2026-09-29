/**
 * 代码块语法高亮。
 *
 * 只注册课程里常见的语言，控制打包体积；未注册或不认识的语言返回空串，
 * 由调用方回退为转义后的纯文本，绝不抛错影响正文渲染。
 */
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import cpp from 'highlight.js/lib/languages/cpp'
import c from 'highlight.js/lib/languages/c'
import css from 'highlight.js/lib/languages/css'
import diff from 'highlight.js/lib/languages/diff'
import go from 'highlight.js/lib/languages/go'
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import python from 'highlight.js/lib/languages/python'
import rust from 'highlight.js/lib/languages/rust'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'
import 'highlight.js/styles/github.css'

const languages = {
  bash, c, cpp, css, diff, go, java, javascript, json, markdown, python, rust, sql, typescript, xml, yaml,
}
for (const [name, definition] of Object.entries(languages)) hljs.registerLanguage(name, definition)

const aliases = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  py: 'python', python3: 'python',
  sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash',
  html: 'xml', svg: 'xml', vue: 'xml',
  yml: 'yaml', golang: 'go', md: 'markdown', patch: 'diff', 'c++': 'cpp',
}

function normalizeLanguage(language) {
  const raw = String(language || '').trim().toLowerCase()
  return aliases[raw] || raw
}

/** 返回高亮 HTML；语言不受支持时返回空串，调用方回退为纯文本。 */
export function highlightToHtml(code, language) {
  const lang = normalizeLanguage(language)
  if (!lang || !hljs.getLanguage(lang)) return ''
  try {
    return hljs.highlight(String(code), { language: lang, ignoreIllegals: true }).value
  } catch {
    return ''
  }
}
