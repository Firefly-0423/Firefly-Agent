// SRT Windows 沙箱验证：第 3 步，在沙箱里执行命令。
// 做法：先用 SandboxManager.wrapWithSandboxArgv 把命令包装好，再自己 spawn。
// 重点：spawn 必须传 { shell: false }，这是安全边界的一部分。
// 用法：node scripts/verify/sandbox-runtime/run-cmd.mjs

import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
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

// 沙箱用户对真实用户的文件默认没有权限，所以单独给它一个可写的临时目录。
// 目录必须先建好，initialize 才能为沙箱用户授予 ACL。
const workDir = path.join(os.tmpdir(), `srt-poc-${Date.now()}`)
mkdirSync(workDir, { recursive: true })

const sandboxConfig = {
  // 这次验证不需要联网，因此不放行任何域名
  network: { allowedDomains: [], deniedDomains: [] },
  // 唯一可写的位置就是上面的临时目录
  filesystem: { denyRead: [], allowWrite: [workDir], denyWrite: [] },
  windows: { srtWin: { path: srt.VENDORED_SRT_WIN_EXE } },
}

/** 在沙箱里运行一条命令，输出直通当前终端；resolve 退出码，spawn 失败时为 -1。 */
async function execInSandbox(title, command) {
  console.log(`\n=== ${title}: ${command} ===`)
  const { argv, env } = await SandboxManager.wrapWithSandboxArgv(
    command, undefined, undefined, undefined, workDir
  )
  const [program, ...args] = argv
  console.log('argv[0]:', program)
  console.log('argv.length:', argv.length)

  return new Promise((resolve) => {
    const proc = spawn(program, args, { shell: false, env, cwd: workDir, stdio: 'inherit' })
    proc.once('error', (err) => {
      console.error('[spawn 错误]', err.message)
      resolve(-1)
    })
    proc.once('close', (code) => {
      console.log(`[退出码] ${code}`)
      resolve(code)
    })
  })
}

console.log('=== 初始化 SandboxManager ===')
console.log('临时可写目录:', workDir)
await SandboxManager.initialize(sandboxConfig)
console.log('[初始化完成]')

try {
  // whoami 应当输出 srt-sandbox，说明命令确实跑在沙箱用户下
  await execInSandbox('身份验证', 'whoami')
  // 最初交接时要验证的目标命令
  await execInSandbox('pip 版本', 'pip --version')
} catch (err) {
  printUnexpectedError(err)
} finally {
  await SandboxManager.reset()
  console.log('\n[完成] SandboxManager 已重置。')
}
