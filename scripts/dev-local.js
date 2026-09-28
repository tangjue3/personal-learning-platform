import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const processes = []
let stopping = false

function launch(label, script, args = []) {
  const child = spawn(process.execPath, [script, ...args], {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
    env: { ...process.env, ZHIXU_API_PORT: '4174' },
  })
  processes.push(child)
  child.on('error', (error) => {
    console.error(`${label} 启动失败：${error.message}`)
    stop(1)
  })
  child.on('exit', (code) => {
    if (!stopping && code !== 0) stop(code || 1)
  })
  return child
}

function stop(exitCode = 0) {
  if (stopping) return
  stopping = true
  for (const child of processes) {
    if (child.exitCode === null) child.kill('SIGTERM')
  }
  const pending = processes.filter((child) => child.exitCode === null)
  if (!pending.length) process.exit(exitCode)
  let remaining = pending.length
  for (const child of pending) child.once('exit', () => {
    remaining -= 1
    if (remaining === 0) process.exit(exitCode)
  })
  setTimeout(() => process.exit(exitCode), 3000).unref()
}

process.on('SIGINT', () => stop(0))
process.on('SIGTERM', () => stop(0))

console.log('正在启动知序本机服务和 Vue 预览……')
launch('本机服务', resolve(root, 'server/index.js'), ['--api-only'])
launch('Vue 预览', resolve(root, 'node_modules/vite/bin/vite.js'), ['--configLoader', 'native', '--host', '127.0.0.1', '--port', '5174', '--strictPort'])
