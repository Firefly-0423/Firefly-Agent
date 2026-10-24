// SRT Windows 沙箱验证：第 4 步，越界测试（文件系统隔离）。
// 两组对照：
//   A. 写 C:\Windows\srt-poc-test.txt，应当被拒（沙箱用户没有 Windows 目录的写权限）
//   B. 写 <临时目录>\ok.txt，应当成功（该目录在 allowWrite 里）
// 用法：node scripts/verify/sandbox-runtime/boundary-test.mjs

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const srt = await import('@anthropic-ai/sandbox-runtime')
const { SandboxManager } = srt

/** 未预期异常的统一输出：消息、可选的错误码、调用栈。 */
function printUnexpectedError(err) {
  console.error('\n[错误]', err.message)
  if (err.code) console.error('错误码:', err.code)
  console.error(err.stack)
}

const writableDir = path.join(os.tmpdir(), `srt-poc-boundary-${Date.now()}`)
mkdirSync(writableDir, { recursive: true })

const sandboxConfig = {
  network: { allowedDomains: [], deniedDomains: [] },
  // 只放行这一个目录的写权限
  filesystem: { denyRead: [], allowWrite: [writableDir], denyWrite: [] },
  windows: { srtWin: { path: srt.VENDORED_SRT_WIN_EXE } },
}

console.log('=== 越界测试 ===')
console.log('可写目录:', writableDir)
await SandboxManager.initialize(sandboxConfig)

/** 在沙箱里执行命令并打印捕获到的输出；返回退出码，spawn 失败时为 -1。 */
async function execInSandbox(title, command) {
  console.log(`\n--- ${title} ---`)
  console.log('命令:', command)
  const { argv, env } = await SandboxManager.wrapWithSandboxArgv(
    command, undefined, undefined, undefined, writableDir
  )
  const [program, ...args] = argv
  const output = { stdout: '', stderr: '' }

  return new Promise((resolve) => {
    const proc = spawn(program, args, {
      shell: false,
      env,
      cwd: writableDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    for (const stream of ['stdout', 'stderr']) {
      proc[stream].on('data', (chunk) => { output[stream] += chunk.toString() })
    }
    proc.once('error', (err) => {
      console.log('spawn 错误:', err.message)
      resolve(-1)
    })
    proc.once('close', (code) => {
      for (const stream of ['stdout', 'stderr']) {
        const text = output[stream].trim()
        if (text) console.log(`${stream}:`, text)
      }
      console.log('退出码:', code)
      resolve(code)
    })
  })
}

try {
  // A. 越界写：期望被拒（退出码非 0）
  const outsidePath = 'C:\\Windows\\srt-poc-test.txt'
  console.log('\n[A] 越界写（应被拒）:', outsidePath)
  const outsideCode = await execInSandbox('越界写', `echo srt-poc > "${outsidePath}"`)
  console.log('文件是否存在:', existsSync(outsidePath) ? '是（危险！隔离失败）' : '否（隔离生效）')

  // B. 合法写：期望成功（退出码 0）
  const insidePath = path.join(writableDir, 'ok.txt')
  console.log('\n[B] 合法写（应成功）:', insidePath)
  const insideCode = await execInSandbox('合法写', `echo hello-from-sandbox > "${insidePath}"`)
  if (!existsSync(insidePath)) {
    console.log('文件不存在（合法写也失败了，配置有问题）')
  } else {
    console.log('文件内容:', readFileSync(insidePath, 'utf8').trim())
    console.log('合法写成功 ✓')
  }

  console.log('\n=== 汇总 ===')
  console.log('越界写退出码:', outsideCode, outsideCode !== 0 ? '→ 被拒 ✓' : '→ 通过（隔离失效！）')
  console.log('合法写退出码:', insideCode, insideCode === 0 ? '→ 成功 ✓' : '→ 失败')
} catch (err) {
  printUnexpectedError(err)
} finally {
  await SandboxManager.reset()
  // 清理临时目录，失败时忽略
  try { rmSync(writableDir, { recursive: true, force: true }) } catch {}
  console.log('\n[完成] 已重置并清理。')
}
