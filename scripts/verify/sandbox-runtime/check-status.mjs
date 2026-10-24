// SRT Windows 沙箱验证：第 1 步，查看当前状态。
// 全程只读：不会弹 UAC，也不改系统配置。
// 用法：node scripts/verify/sandbox-runtime/check-status.mjs

const srt = await import('@anthropic-ai/sandbox-runtime')

/** 统一的失败输出：先打印提示和错误信息，必要时补充错误码与调用栈。 */
function reportFailure(prefix, err, { detailed = false } = {}) {
  console.error(prefix, err.message)
  if (!detailed) return
  if (err.code) console.error('错误码:', err.code)
  console.error(err.stack)
}

/** 打印一个分节标题，节与节之间空一行。 */
const heading = (title, first = false) => console.log(`${first ? '' : '\n'}=== ${title} ===`)

heading('SRT 可用导出', true)
console.log(Object.keys(srt).sort().join('\n'))

heading('Windows 沙箱状态')
try {
  const srtWin = srt.resolveSrtWin({ path: srt.VENDORED_SRT_WIN_EXE })
  console.log('解析 srtWin:', JSON.stringify(srtWin))
  console.log(JSON.stringify(await srt.checkWindowsSandboxStatusAsync({ srtWin }), null, 2))
} catch (err) {
  reportFailure('查状态失败:', err, { detailed: true })
}

heading('srt-win.exe 路径')
try {
  // 不同版本导出的函数不同，按可用性依次尝试
  console.log(srt.getSrtWinPath?.() || srt.resolveSrtWin?.() || '(未找到函数)')
} catch (err) {
  reportFailure('取路径失败:', err)
}
