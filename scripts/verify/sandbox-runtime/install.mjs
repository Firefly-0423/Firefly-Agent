// SRT Windows 沙箱验证：第 2 步，安装（会触发 UAC）。
// 一次性动作：创建本地用户 srt-sandbox，并安装 WFP 网络过滤器，只会弹一次 UAC。
// 可以重复运行：重跑只会轮换沙箱用户的密码，不会重复安装。
// 用法：node scripts/verify/sandbox-runtime/install.mjs
//
// 在 UAC 弹窗里点"是"才会真正安装；点"否"不会报错，只是返回 cancelled: true。

const srt = await import('@anthropic-ai/sandbox-runtime')

/** 按 "标签: 值" 的格式输出 source 上的一组字段，字段路径用点号分隔。 */
function printFields(source, paths) {
  for (const dotted of paths) {
    const value = dotted.split('.').reduce((node, key) => node[key], source)
    console.log(`${dotted}:`, value)
  }
}

// 使用包内自带的 srt-win.exe
const srtWin = srt.resolveSrtWin({ path: srt.VENDORED_SRT_WIN_EXE })
console.log('srt-win.exe:', srtWin.exe)
console.log('prependArgs:', srtWin.prependArgs)

console.log('\n=== 装前状态 ===')
printFields(await srt.checkWindowsSandboxStatusAsync({ srtWin }), ['user.provisioned', 'wfp.state'])

console.log('\n=== 触发安装（请看 UAC 弹窗）===')
const installed = await srt.installWindowsSandboxAsync({ srtWin })

if (installed.cancelled) {
  console.log('\n[取消] 用户没点 UAC，安装没发生。准备好再重跑。')
  process.exit(0)
}

console.log('\n=== 安装结果 ===')
printFields(installed, ['user.provisioned', 'user.sid', 'wfp.state', 'wfp.filters', 'wfp.portRange'])

console.log('\n=== 装后状态复核 ===')
printFields(await srt.checkWindowsSandboxStatusAsync({ srtWin }), ['user.provisioned', 'user.sid', 'wfp.state'])

console.log('\n[完成] 安装成功。下一步跑 run-cmd.mjs 验证沙箱内执行。')
