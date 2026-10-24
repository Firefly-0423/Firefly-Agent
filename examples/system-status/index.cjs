"use strict";

const path = require("node:path");
const os = require("node:os");
const { execFile } = require("node:child_process");

// ---------------------------------------------------------------------------
// 模块内状态：几次采样之间需要记住的东西
// ---------------------------------------------------------------------------
const memo = {
  /** 状态窗口实例，open() 创建，unregister() 关闭 */
  win: null,
  /** nvidia-smi 失败一次后就不再尝试 */
  smiUsable: true,
  /** 上一次 CPU 时间累计（idle / total），用于差分 */
  cpu: null,
  /** 上一次网络累计字节与时间，用于算速率 */
  net: null,
};

const GIB = 1024 ** 3;
const round1 = (n) => Math.round(n * 10) / 10;

/** 在子进程里跑命令；无论成败都 resolve，出错时 ok 为 false */
function spawnQuiet(command, argv, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const opts = { timeout: timeoutMs, windowsHide: true };
    execFile(command, argv, opts, (err, out, errOut) => {
      resolve({ ok: !err, stdout: String(out || ""), stderr: String(errOut || "") });
    });
  });
}

/** 用 PowerShell 执行一段脚本 */
function powershell(script, timeoutMs) {
  const argv = ["-NoProfile", "-NonInteractive", "-Command", script];
  return timeoutMs === undefined ? spawnQuiet("powershell.exe", argv) : spawnQuiet("powershell.exe", argv, timeoutMs);
}

// ---------------------------------------------------------------------------
// CPU：靠 os.cpus() 前后两次累计值相减，不起子进程
// ---------------------------------------------------------------------------
function cpuUsagePercent() {
  let idle = 0;
  let total = 0;
  for (const { times } of os.cpus()) {
    idle += times.idle;
    total += times.user + times.nice + times.sys + times.idle + times.irq;
  }
  const previous = memo.cpu;
  memo.cpu = { idle, total };
  if (!previous) return null;
  const totalDelta = total - previous.total;
  if (!(totalDelta > 0)) return null;
  const busy = 1 - (idle - previous.idle) / totalDelta;
  return Math.max(0, Math.min(100, busy * 100));
}

// ---------------------------------------------------------------------------
// GPU：有 N 卡就问 nvidia-smi（温度、占用、显存一次取齐），否则返回空值
// ---------------------------------------------------------------------------
const NO_GPU = { percent: null, temperature: null, vramUsedMb: null, vramTotalMb: null };

async function queryNvidia() {
  const res = await spawnQuiet(
    "nvidia-smi",
    [
      "--query-gpu=temperature.gpu,utilization.gpu,memory.used,memory.total",
      "--format=csv,noheader,nounits",
    ],
    3000,
  );
  const fields = res.ok ? res.stdout.trim().split(/\s*,\s*/).map(Number) : [];
  if (fields.length !== 4 || !fields.every(Number.isFinite)) return null;
  const [temperature, percent, vramUsedMb, vramTotalMb] = fields;
  return { percent, temperature, vramUsedMb, vramTotalMb };
}

async function readGpu() {
  if (memo.smiUsable) {
    const reading = await queryNvidia();
    if (reading) return reading;
    memo.smiUsable = false; // 没有 N 卡驱动，之后不再尝试
  }
  return { ...NO_GPU };
}

// ---------------------------------------------------------------------------
// 磁盘、网络、电池以及 GPU 引擎回退值：合并成一次 PowerShell 调用
// ---------------------------------------------------------------------------
const MISC_SCRIPT = [
  // 初始化有序结果表
  "$r = [ordered]@{}",
  // 本地固定磁盘
  "$r.disks = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object DeviceID,Size,FreeSpace)",
  // 所有网卡累计收发字节
  "$net = Get-NetAdapterStatistics -ErrorAction SilentlyContinue | Measure-Object -Property ReceivedBytes,SentBytes -Sum",
  "$r.net = @{ r = [double]$net.ReceivedBytes; s = [double]$net.SentBytes }",
  // 电池（台式机没有）
  "$bat = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue",
  "if ($bat) { $r.bat = @{ p = [int]$bat.EstimatedChargeRemaining; charging = ($bat.BatteryStatus -eq 2) } } else { $r.bat = $null }",
  // GPU 引擎占用（非 N 卡时的兜底）
  "$g = Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine -ErrorAction SilentlyContinue | Measure-Object -Property UtilizationPercentage -Sum",
  "if ($g.Sum -ne $null) { $r.gpuEngine = [math]::Round([double]$g.Sum, 1) } else { $r.gpuEngine = $null }",
  // 输出紧凑 JSON
  "ConvertTo-Json -InputObject $r -Compress -Depth 4",
].join("; ");

async function readWindowsMisc() {
  const res = await powershell(MISC_SCRIPT, 8000);
  const text = res.stdout.trim();
  if (!res.ok || !text) return null;
  try {
    return JSON.parse(res.stdout);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 网络速率：当前累计字节减去上次累计字节，再除以间隔秒数
// ---------------------------------------------------------------------------
function networkRate(counters) {
  if (!counters || !Number.isFinite(counters.r) || !Number.isFinite(counters.s)) return null;
  const at = Date.now();
  const bytes = counters.r + counters.s;
  const before = memo.net;
  memo.net = { total: bytes, time: at };
  if (!before) return null; // 第一次没有基准，无法算速率
  const seconds = (at - before.time) / 1000;
  const grown = bytes - before.total;
  return seconds <= 0 || grown < 0 ? null : grown / seconds;
}

// ---------------------------------------------------------------------------
// 文字格式化
// ---------------------------------------------------------------------------
function humanBytes(n) {
  const inGb = n / 1024 / 1024 / 1024;
  return inGb >= 1 ? `${inGb.toFixed(1)} GB` : `${(n / 1024 / 1024).toFixed(0)} MB`;
}

function describeUptime(totalSeconds) {
  const hours = Math.floor(totalSeconds / 3600);
  if (hours > 24) {
    return `已运行 ${Math.floor(hours / 24)} 天 ${hours % 24} 小时`;
  }
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  return `已运行 ${hours} 小时 ${minutes} 分钟`;
}

const mbToGb = (mb) => round1(mb / 1024);

// ---------------------------------------------------------------------------
// 完整快照：给弹窗界面用，字段与 ui.html 约定一致
// ---------------------------------------------------------------------------
function shapeDisks(rows) {
  return rows
    .filter((row) => Number.isFinite(row.Size) && row.Size > 0)
    .map((row) => {
      const used = row.Size - row.FreeSpace;
      return {
        name: row.DeviceID || "?",
        usedGb: round1(used / GIB),
        totalGb: round1(row.Size / GIB),
        percent: Math.round((used / row.Size) * 100),
      };
    })
    .slice(0, 6);
}

/** 先用 nvidia-smi 的占用，没有再用 WMI 引擎计数 */
function pickGpuPercent(gpu, misc) {
  if (gpu.percent != null) return Math.round(gpu.percent);
  if (misc && Number.isFinite(misc.gpuEngine)) return Math.round(Math.min(100, misc.gpuEngine));
  return null;
}

async function collectSnapshot() {
  const cpuPercent = cpuUsagePercent();
  const memTotal = os.totalmem();
  const memUsed = memTotal - os.freemem();
  const firstCpu = os.cpus()[0];

  const [gpu, misc] = await Promise.all([readGpu(), readWindowsMisc()]);

  const snap = {
    cpuPercent: cpuPercent == null ? null : Math.round(cpuPercent),
    gpuPercent: null,
    memoryPercent: Math.round((memUsed / memTotal) * 100),
    memoryUsedGb: round1(memUsed / GIB),
    memoryTotalGb: round1(memTotal / GIB),
    // 磁盘列表在 misc 可用时才会填充
    disks: [],
    // 以下三项来自 GPU 读数
    gpuTemperature: gpu.temperature,
    vramUsedGb: gpu.vramUsedMb == null ? null : mbToGb(gpu.vramUsedMb),
    vramTotalGb: gpu.vramTotalMb == null ? null : mbToGb(gpu.vramTotalMb),
    // 网络与电池同样依赖 misc，缺省为空值与“台式机”
    networkBytesPerSecond: null,
    batteryPercent: null,
    batteryLabel: "台式机",
    uptime: describeUptime(os.uptime()),
    cpuModel: firstCpu ? `${firstCpu.model.trim()} · ${os.cpus().length} 核` : null,
  };

  const gpuPercent = pickGpuPercent(gpu, misc);
  if (gpuPercent != null) snap.gpuPercent = gpuPercent;

  if (misc) {
    if (Array.isArray(misc.disks)) snap.disks = shapeDisks(misc.disks);
    snap.networkBytesPerSecond = networkRate(misc.net);
    if (misc.bat && Number.isFinite(misc.bat.p)) {
      snap.batteryPercent = misc.bat.p;
      snap.batteryLabel = misc.bat.charging ? "充电中" : "使用电池";
    }
  }
  return snap;
}

// ---------------------------------------------------------------------------
// 文本版状态：给 AI 工具返回的简短多行输出
// ---------------------------------------------------------------------------
function gpuSummary(s) {
  let text = `GPU: 占用 ${s.gpuPercent}%`;
  if (s.gpuTemperature != null) text += ` · 温度 ${s.gpuTemperature}°C`;
  if (s.vramUsedGb != null) text += ` · 显存 ${s.vramUsedGb}/${s.vramTotalGb} GB`;
  return text;
}

async function collectStatus() {
  const s = await collectSnapshot();
  const cpuLoad = s.cpuPercent != null ? ` · 当前占用 ${s.cpuPercent}%` : "";
  const out = [
    `系统: ${os.type()} ${os.release()} (${os.arch()})`,
    `CPU: ${s.cpuModel || "未知"}${cpuLoad}`,
    `内存: ${s.memoryUsedGb} / ${s.memoryTotalGb} GB（使用率 ${s.memoryPercent}%）`,
  ];
  if (s.gpuPercent != null) out.push(gpuSummary(s));
  out.push(`已运行: ${s.uptime.replace("已运行 ", "")}`);
  out.push(
    s.batteryPercent != null
      ? `电池: ${s.batteryPercent}%（${s.batteryLabel}）`
      : "电池: 未检测到（台式机或未上报）",
  );
  return out;
}

async function diskUsage(drive) {
  const letter = drive ? drive.toUpperCase() : "C";
  const res = await powershell(
    `$d = Get-PSDrive -Name "${letter}" -ErrorAction SilentlyContinue; if ($d) { "$($d.Used) $($d.Free)" } else { Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${letter}:'" -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Size - $_.FreeSpace) $($_.FreeSpace)" } }`,
  );
  if (!res.ok || !res.stdout.trim()) return null;
  const [usedText, freeText] = res.stdout.trim().split(/\s+/);
  const used = Number(usedText);
  const free = Number(freeText);
  const sane = Number.isFinite(used) && Number.isFinite(free) && used + free > 0;
  return sane ? { drive: letter, used, free, total: used + free } : null;
}

async function collectDisk(drive) {
  const usage = await diskUsage(drive);
  if (!usage) return `磁盘 ${drive ? drive.toUpperCase() : "系统"}: 无法读取`;
  const percent = ((usage.used / usage.total) * 100).toFixed(1);
  return `磁盘 ${usage.drive}: 已用 ${humanBytes(usage.used)} / ${humanBytes(usage.total)}（${percent}%），剩余 ${humanBytes(usage.free)}`;
}

// ---------------------------------------------------------------------------
// 工具定义
// ---------------------------------------------------------------------------
const makeStatusTool = () => ({
  id: "system-status_status",
  // 展示给用户与模型的名称和用途说明
  name: "系统状态查询",
  description: "查询本机系统状态，包括操作系统、CPU 占用、内存、GPU、电池与开机时长。用户问电脑还剩多少电、内存占用、CPU 温度负载、开了多久等问题时使用。",
  enabled: true,
  // 只读、无副作用
  risk: "safe",
  effectKind: "read",
  // 无需参数
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
  },
  async execute() {
    return (await collectStatus()).join("\n");
  },
});

const makeDiskTool = () => ({
  id: "system-status_disk",
  // 展示给用户与模型的名称和用途说明
  name: "磁盘占用查询",
  description: "查询磁盘空间占用情况。可选指定盘符（如 C、D、E），不指定则查询系统盘。",
  enabled: true,
  // 只读、无副作用
  risk: "safe",
  effectKind: "read",
  // 参数：可选盘符
  inputSchema: {
    type: "object",
    properties: {
      drive: { type: "string", description: "Windows 盘符字母，例如 C、D、E；留空查询系统所在盘" },
    },
    required: [],
  },
  async execute(args) {
    // 只接受单个英文字母，其余视为未指定
    const given = typeof args.drive === "string" ? args.drive.trim() : "";
    const drive = typeof args.drive === "string" && /^[a-z]$/i.test(given) ? given.toUpperCase() : undefined;
    return collectDisk(drive);
  },
});

// ---------------------------------------------------------------------------
// 状态窗口
// ---------------------------------------------------------------------------
const WINDOW_CHANNELS = {
  minimize: "plugin:system-status:win-minimize",
  maximize: "plugin:system-status:win-maximize",
  close: "plugin:system-status:win-close",
};

const windowAlive = () => Boolean(memo.win) && !memo.win.isDestroyed();

/** 自绘标题栏发来的窗口控制命令 */
const windowActions = {
  minimize() {
    if (windowAlive()) memo.win.minimize();
  },
  maximize() {
    if (!windowAlive()) return;
    if (memo.win.isMaximized()) memo.win.unmaximize();
    else memo.win.maximize();
  },
  close() {
    if (windowAlive()) memo.win.close();
  },
};

const systemStatusPlugin = {
  register(ctx) {
    ctx.registerTool(makeStatusTool());
    ctx.registerTool(makeDiskTool());
    ctx.registerIpc("snapshot", () => collectSnapshot());
    ctx.log("系统状态插件已注册: system-status_status / system-status_disk");
  },

  async open() {
    if (windowAlive()) {
      memo.win.focus();
      return;
    }
    const { BrowserWindow, ipcMain } = require("electron");
    memo.win = new BrowserWindow({
      // 尺寸与最小尺寸
      width: 860,
      height: 600,
      minWidth: 380,
      minHeight: 420,
      // 不要系统边框，标题栏由 ui.html 自己画
      frame: false,
      // 外观
      backgroundColor: "#fff9fc",
      autoHideMenuBar: true,
      resizable: true,
      // 界面直接使用 Node 的 ipcRenderer，所以不隔离上下文
      webPreferences: {
        contextIsolation: false,
        nodeIntegration: true,
      },
    });
    // 渲染进程发事件，主进程在这里执行窗口控制
    const wiring = Object.keys(WINDOW_CHANNELS).map((name) => [WINDOW_CHANNELS[name], windowActions[name]]);
    for (const [channel, handler] of wiring) ipcMain.on(channel, handler);
    memo.win.on("closed", () => {
      for (const [channel, handler] of wiring) ipcMain.removeListener(channel, handler);
      memo.win = null;
    });
    await memo.win.loadFile(path.join(__dirname, "ui.html"));
  },

  unregister() {
    if (windowAlive()) memo.win.close();
  },
};

module.exports = systemStatusPlugin;
module.exports.default = systemStatusPlugin;
