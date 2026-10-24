// 聊天渲染性能基线（阶段 0）的运行脚本。
//
// 做的事：
//   1. 按需构建两个版本：通道 B 是普通生产构建，通道 A 是带 react-dom/profiling 的构建
//      （由 vite 环境变量切换）
//   2. 起本地静态服务器托管产物，用 Playwright 驱动一组固定 seed、可重放的 fixture
//   3. 每个页面等 window.__perfDone 给出报告，同时取水合前后的 CDP Performance 指标做差
//   4. 同一配置的多次运行取中位数，写出 JSON 报告并在控制台打印摘要
//
// 用法：
//   npm run perf:chat-baseline                       # 完整基线（B：3 数据集 × 2 规模 × 2 滚动 × 5 次；A：缩减矩阵 × 3 次）
//   npm run perf:chat-baseline -- --smoke            # 冒烟：单个配置跑通构建、驱动、报告全链路
//   npm run perf:chat-baseline -- --runs 1 --only-b  # 快速验证：只跑 B 通道 12 个配置各 1 次（探针计数很稳定，适合阶段间验收）
//   npm run perf:chat-baseline -- --skip-build       # 复用已有的 dist/perf-* 产物（调试 harness 用）
//   npm run perf:chat-baseline -- --out <file>       # 指定报告输出路径
//   npm run perf:chat-baseline -- --headed --record-video <dir>  # 把每次可见窗口的回放录成 WebM

import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createRecordingContextOptions, installLiveMessageFollow, recordingFileName } from "./chat-renderer-recording.mjs";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

// ───────────── 命令行 ─────────────

/** 取 flag 后面紧跟的那个参数；没有该 flag 返回 undefined，flag 在末尾则值也是 undefined。 */
function flagValue(argv, flag) {
  const at = argv.indexOf(flag);
  return at === -1 ? undefined : argv[at + 1];
}

/** 逗号分隔的列表参数；没传该 flag 返回 undefined。 */
function flagList(argv, flag) {
  if (!argv.includes(flag)) return undefined;
  return (flagValue(argv, flag) ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseCommandLine(argv) {
  const options = {
    smoke: argv.includes("--smoke"),
    skipBuild: argv.includes("--skip-build"),
    onlyB: argv.includes("--only-b"),
    headed: argv.includes("--headed"),
    out: flagValue(argv, "--out"),
    runs: argv.includes("--runs") ? Number.parseInt(flagValue(argv, "--runs") ?? "", 10) : undefined,
    // A0 归因实验：覆盖默认矩阵（参数经 URL 传给 harness，见 react-perf/main.tsx）
    datasets: flagList(argv, "--datasets"),
    scrolls: flagList(argv, "--scrolls"),
    counts: argv.includes("--counts")
      ? (flagValue(argv, "--counts") ?? "")
          .split(",")
          .map((item) => Number.parseInt(item.trim(), 10))
          .filter((n) => Number.isFinite(n) && n >= 0)
      : undefined,
    recordVideoDir: undefined,
  };

  if (argv.includes("--record-video")) {
    const dir = flagValue(argv, "--record-video");
    if (!dir) throw new Error("--record-video 后必须提供输出目录");
    options.recordVideoDir = resolve(dir);
  }
  return options;
}

const cli = parseCommandLine(process.argv.slice(2));

// ───────────── 测试矩阵 ─────────────

const SEED = 42;
// 流式脚本时长：完整基线 15 秒（几百个 delta，接近真实的长回复）；冒烟只需 6 秒验证链路
const STREAM_DURATION_MS = cli.smoke ? 6_000 : 15_000;

const SMOKE_MATRIX = { datasets: ["mixed"], counts: [200], scrolls: ["bottom"], runs: 1 };

/** 通道 B（普通生产构建）：支持命令行覆盖数据集、规模、滚动方式和运行次数。 */
function matrixForChannelB() {
  if (cli.smoke) return SMOKE_MATRIX;
  const runs = Number.isFinite(cli.runs) && cli.runs > 0 ? cli.runs : 5;
  return {
    datasets: cli.datasets ?? ["plain", "markdown", "mixed"],
    counts: cli.counts ?? [200, 500],
    scrolls: cli.scrolls ?? ["bottom", "top"],
    runs,
  };
}

/**
 * 通道 A（profiling 构建）自带额外开销，绝对耗时偏慢，只用来看 React 侧指标
 * （commit 频率与时长、探针计数），所以矩阵缩减到最重的配置。
 */
function matrixForChannelA() {
  if (cli.smoke) return SMOKE_MATRIX;
  return { datasets: ["plain", "markdown", "mixed"], counts: [500], scrolls: ["bottom"], runs: 3 };
}

const MATRIX_B = matrixForChannelB();
const MATRIX_A = matrixForChannelA();

const CHANNELS = {
  B: { outDir: "dist/perf-normal", port: 5199 },
  A: { outDir: "dist/perf-profiling", port: 5200 },
};

// ───────────── 构建 ─────────────

function buildChannel(outDirRelative, withProfiling) {
  const label = withProfiling ? "A（react-dom/profiling）" : "B（普通生产）";
  console.log(`[build] 通道 ${label} → ${outDirRelative}`);

  const viteEntry = join(REPO_ROOT, "node_modules", "vite", "bin", "vite.js");
  if (!existsSync(viteEntry)) throw new Error(`未找到 vite：${viteEntry}`);

  const env = { ...process.env, FIREFLY_PERF_HARNESS: "1" };
  env.FIREFLY_PERF_OUT_DIR = outDirRelative;
  if (withProfiling) env.FIREFLY_PERF_PROFILE = "1";
  const build = spawnSync(process.execPath, [viteEntry, "build"], { cwd: REPO_ROOT, stdio: "inherit", env });
  if (build.status !== 0) throw new Error(`vite build 失败（${outDirRelative}）`);
}

// ───────────── 静态服务器 ─────────────

const CONTENT_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript"],
  [".mjs", "text/javascript"],
  [".css", "text/css"],
  [".json", "application/json"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".ttf", "font/ttf"],
  [".otf", "font/otf"],
  [".ico", "image/x-icon"],
  [".txt", "text/plain; charset=utf-8"],
]);

function startStaticServer(rootDir, port) {
  const rootPrefix = normalize(rootDir);

  const handleRequest = (req, res) => {
    try {
      const { pathname } = new URL(req.url ?? "/", "http://localhost");
      let target = normalize(join(rootDir, decodeURIComponent(pathname)));

      // 防止通过 .. 跳出产物目录
      if (!target.startsWith(rootPrefix)) {
        res.writeHead(403).end("forbidden");
        return;
      }
      if (pathname.endsWith("/")) target = join(target, "index.html");
      if (!existsSync(target) || !statSync(target).isFile()) {
        res.writeHead(404).end("not found");
        return;
      }
      const contentType = CONTENT_TYPES.get(extname(target).toLowerCase()) ?? "application/octet-stream";
      res.writeHead(200, { "content-type": contentType }).end(readFileSync(target));
    } catch {
      res.writeHead(500).end();
    }
  };

  return new Promise((resolveServer, rejectServer) => {
    const server = createServer(handleRequest);
    server.once("error", rejectServer);
    server.listen(port, "127.0.0.1", () => resolveServer(server));
  });
}

// ───────────── CDP 指标 ─────────────

const CDP_METRIC_NAMES = "TaskDuration ScriptDuration LayoutDuration RecalcStyleDuration LayoutCount RecalcStyleCount".split(" ");

const metricsByName = ({ metrics }) => Object.fromEntries(metrics.map(({ name, value }) => [name, value]));

/** 水合之后的差值：只计入流式窗口（含发送驱动）里的任务、布局和样式开销。 */
function metricDelta(before, after) {
  const delta = {};
  for (const name of CDP_METRIC_NAMES) {
    if (typeof before[name] !== "number" || typeof after[name] !== "number") continue;
    delta[name] = Math.round((after[name] - before[name]) * 1000) / 1000;
  }
  return delta;
}

// ───────────── 单个页面的运行 ─────────────

async function runOnePage(context, baseUrl, { dataset, count, scroll }, recordingName) {
  const page = await context.newPage();
  const recording = page.video();
  if (cli.recordVideoDir) await page.addInitScript(installLiveMessageFollow);

  const cdpSession = await context.newCDPSession(page);
  await cdpSession.send("Performance.enable");

  const query = `dataset=${dataset}&count=${count}&seed=${SEED}&duration=${STREAM_DURATION_MS}&scroll=${scroll}`;
  await page.goto(`${baseUrl}/react-perf/index.html?${query}`, { waitUntil: "domcontentloaded", timeout: 60_000 });

  await page.waitForFunction(() => window.__perfHydrated === true, null, { timeout: 120_000 });
  const before = metricsByName(await cdpSession.send("Performance.getMetrics"));

  const reportHandle = await page.waitForFunction(
    () => (window.__perfDone !== undefined && window.__perfDone !== null ? window.__perfDone : null),
    null,
    { timeout: STREAM_DURATION_MS + 150_000 },
  );
  const report = await reportHandle.jsonValue();
  const after = metricsByName(await cdpSession.send("Performance.getMetrics"));
  await page.close();

  if (!report || report.ok !== true) {
    const reason = report && typeof report === "object" ? report.error : "无报告";
    throw new Error(`harness 报告失败: ${reason}`);
  }

  const result = { ...report, cdp: metricDelta(before, after) };
  if (recording && recordingName && cli.recordVideoDir) {
    result.videoPath = join(cli.recordVideoDir, recordingName);
    renameSync(await recording.path(), result.videoPath);
  }
  return result;
}

// ───────────── 聚合 ─────────────

const valueAt = (obj, dottedPath) =>
  dottedPath.split(".").reduce((node, key) => (node == null ? undefined : node[key]), obj);

function medianOf(numbers) {
  if (numbers.length === 0) return null;
  const ordered = numbers.toSorted((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 1 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

// 要聚合的指标，按所在的 report 子对象分组；同一配置的 5（或 3）次运行逐项取中位数。
// 键是 report 里的点路径前缀，值是该对象下的叶子字段；展开后的顺序就是聚合结果里的键顺序。
const METRIC_GROUPS = [
  ["timings", ["firstBubbleMs", "hydratedMs"]],
  ["userChannel.frameTimesDuringStreaming", ["median", "p95", "max"]],
  ["userChannel.longTasks", ["median", "max", "countOver32ms", "countOver100ms"]],
  ["userChannel.eventToPaint", ["median", "p95", "max"]],
  ["reactChannel.commitsDuringStreaming", ["commitCount", "commitsPerSecond", "median", "p95"]],
  // A0 归因实验：listRenders 是列表外壳（Bubble.List 与全部 footer）的执行次数，补足 markdownRenders 覆盖不到的路径
  ["reactChannel.probeDeltaDuringStreaming", ["markdownRenders", "listRenders"]],
  // 导航与侧栏的验收口径：只算事件流到达期间（RUN_FINISHED 之后的合法列表刷新不算流式成本）
  ["reactChannel.probeDeltaDuringEventStream", ["navigationRenders", "sidebarRenders"]],
  ["reactChannel", ["expectedDeltaEvents"]],
  ["memory", ["heapUsedAfterHydrationBytes", "heapUsedFinalBytes", "domNodeCountFinal"]],
  ["cdp", CDP_METRIC_NAMES],
];
const AGGREGATED_METRICS = METRIC_GROUPS.flatMap(([prefix, leaves]) => leaves.map((leaf) => `${prefix}.${leaf}`));

function summarizeRuns(runs) {
  const summary = {};
  for (const metric of AGGREGATED_METRICS) {
    const samples = runs.map((run) => valueAt(run, metric)).filter((v) => typeof v === "number");
    summary[metric] = medianOf(samples);
  }
  return summary;
}

// ───────────── 执行矩阵 ─────────────

/** 展开矩阵的所有配置，顺序为：数据集 → 规模 → 滚动方式。 */
function* configurationsOf(matrix) {
  for (const dataset of matrix.datasets) {
    for (const count of matrix.counts) {
      for (const scroll of matrix.scrolls) yield { dataset, count, scroll };
    }
  }
}

const configurationCount = (matrix) => matrix.datasets.length * matrix.counts.length * matrix.scrolls.length;

async function executeMatrix(browser, baseUrl, matrix, channelName) {
  const results = [];
  for (const params of configurationsOf(matrix)) {
    const label = `${params.dataset}/${params.count}/${params.scroll}`;
    const runs = [];

    for (let attempt = 1; attempt <= matrix.runs; attempt++) {
      const context = await browser.newContext(createRecordingContextOptions(cli.recordVideoDir));
      const recordingName = cli.recordVideoDir ? recordingFileName(params, attempt) : undefined;
      try {
        // 偶发的调度抖动不该废掉整轮基线，所以失败后重试一次
        try {
          runs.push(await runOnePage(context, baseUrl, params, recordingName));
        } catch (error) {
          console.log(`  [${channelName}] ${label} #${attempt} 失败，重试: ${error.message}`);
          runs.push(await runOnePage(context, baseUrl, params, recordingName));
        }
        console.log(`  [${channelName}] ${label} #${attempt}/${matrix.runs} 完成`);
      } finally {
        await context.close();
      }
    }

    results.push({ params, aggregated: summarizeRuns(runs), runs });
  }
  return results;
}

// ───────────── 控制台摘要 ─────────────

const formatNumber = (value, digits) => (typeof value === "number" ? value.toFixed(digits) : "-");

// 摘要表的列：[表头, 列宽, 指标路径, 小数位]。
// A0 归因实验最关心的是 scriptS / layoutS（CDP 脚本与布局耗时）以及 mdDelta / listDelta（正文与列表外壳的执行次数）
const SUMMARY_COLUMNS = [
  ["frameP95ms", 10, "userChannel.frameTimesDuringStreaming.p95", 1],
  ["LT>32", 6, "userChannel.longTasks.countOver32ms", 0],
  ["LT>100", 7, "userChannel.longTasks.countOver100ms", 0],
  ["mdDelta", 8, "reactChannel.probeDeltaDuringStreaming.markdownRenders", 0],
  ["listDelta", 10, "reactChannel.probeDeltaDuringStreaming.listRenders", 0],
  ["navDelta", 9, "reactChannel.probeDeltaDuringEventStream.navigationRenders", 0],
  ["sideDelta", 10, "reactChannel.probeDeltaDuringEventStream.sidebarRenders", 0],
  ["commit/s", 9, "reactChannel.commitsDuringStreaming.commitsPerSecond", 1],
  ["cmtP95ms", 9, "reactChannel.commitsDuringStreaming.p95", 1],
  ["scriptS", 8, "cdp.ScriptDuration", 2],
  ["layoutS", 8, "cdp.LayoutDuration", 2],
  ["evtP95ms", 9, "userChannel.eventToPaint.p95", 1],
];
const CONFIG_COLUMN_WIDTH = 26;

function printSummary(report, reportPath) {
  console.log("\n================ 聊天渲染性能基线摘要（每配置取中位数） ================");

  const headerLine = ["config".padEnd(CONFIG_COLUMN_WIDTH), ...SUMMARY_COLUMNS.map(([name, width]) => name.padEnd(width))].join(" ");

  const sections = [
    ["channelB", "通道 B（普通生产构建）"],
    ["channelA", "通道 A（react-dom/profiling）"],
  ];
  for (const [key, title] of sections) {
    console.log(`\n-- ${title} --`);
    console.log(headerLine);
    for (const { params, aggregated } of report[key].perConfig) {
      const cells = SUMMARY_COLUMNS.map(([, width, metric, digits]) =>
        formatNumber(aggregated[metric], digits).padEnd(width),
      );
      const configCell = `${params.dataset}/${params.count}/${params.scroll}`.padEnd(CONFIG_COLUMN_WIDTH);
      console.log([configCell, ...cells].join(" "));
    }
  }
  console.log(`\n报告已写入: ${reportPath}`);
}

// ───────────── 主流程 ─────────────

async function main() {
  const reportPath = resolve(REPO_ROOT, cli.out ?? "output/perf/baseline-report.json");
  if (cli.recordVideoDir) mkdirSync(cli.recordVideoDir, { recursive: true });

  const modeLabel = cli.smoke ? "冒烟" : "完整基线";
  const windowLabel = cli.headed ? "可见窗口" : "headless";
  console.log(`[perf] 模式: ${modeLabel}，${windowLabel}，seed=${SEED}，流式时长 ${STREAM_DURATION_MS}ms`);

  if (!cli.skipBuild) {
    buildChannel(CHANNELS.B.outDir, false);
    if (!cli.onlyB) buildChannel(CHANNELS.A.outDir, true);
  }

  const servers = [await startStaticServer(resolve(REPO_ROOT, CHANNELS.B.outDir), CHANNELS.B.port)];
  if (!cli.onlyB) servers.push(await startStaticServer(resolve(REPO_ROOT, CHANNELS.A.outDir), CHANNELS.A.port));

  const report = {
    meta: {
      generatedAt: new Date().toISOString(),
      smoke: cli.smoke,
      headed: cli.headed,
      recordVideoDir: cli.recordVideoDir,
      seed: SEED,
      durationMs: STREAM_DURATION_MS,
      bMatrix: MATRIX_B,
      aMatrix: MATRIX_A,
      note: "frameTimesDuringStreaming/LT/eventToPaint 为流式窗口统计；cdp.* 为水合后差值；探针 delta 为流式期间历史组件执行次数",
    },
    channelB: { perConfig: [] },
    channelA: { perConfig: [] },
  };

  let browser;
  try {
    browser = await chromium.launch({ headless: !cli.headed });

    console.log(`\n[perf] 通道 B：${configurationCount(MATRIX_B)} 配置 × ${MATRIX_B.runs} 次`);
    report.channelB.perConfig = await executeMatrix(browser, `http://127.0.0.1:${CHANNELS.B.port}`, MATRIX_B, "B");

    if (cli.onlyB) {
      console.log("\n[perf] 跳过通道 A（profiling 构建）");
    } else {
      console.log(`\n[perf] 通道 A：${configurationCount(MATRIX_A)} 配置 × ${MATRIX_A.runs} 次`);
      report.channelA.perConfig = await executeMatrix(browser, `http://127.0.0.1:${CHANNELS.A.port}`, MATRIX_A, "A");
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    for (const server of servers) server.close();
  }

  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
  printSummary(report, reportPath);
}

main().catch((error) => {
  console.error(`[perf] 基线执行失败: ${error instanceof Error ? error.stack : String(error)}`);
  process.exitCode = 1;
});
