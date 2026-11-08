import { readFileSync } from "node:fs";
import { resolve } from "path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
// Streamdown 的预置布局依赖 Tailwind 工具类；样式以 sd 前缀和局部容器隔离，
// 不会带入全局 preflight，也不让产品代码养成写 utility class 的习惯。
import tailwindcss from "@tailwindcss/vite";
import { fireflyEnvironment } from "./src/shared/firefly-environment";

const fromRoot = (...segments: string[]) => resolve(__dirname, ...segments);

/** 渲染进程的各个页面：Rollup 入口名 → 相对 src/renderer 的 HTML。 */
const PAGES: Record<string, string> = {
  renderer: "index.html",
  sidebar: "sidebar/index.html",
  settings: "settings/index.html",
  stickers: "sticker-manager/index.html",
  "chat-react": "react/index.html",
  toast: "toast/index.html",
};

/**
 * 聊天窗口（React 页）的内容安全策略，按指令逐条列出。
 * 脚本只允许本地且不放行 eval；样式保留 'unsafe-inline' 给 Ant Design 的运行时样式；
 * 字体随应用打包，不访问外部字体服务。frame-ancestors 只在响应头里有效，写进 <meta> 会被忽略，所以不列。
 * 开发时额外放行 Vite 热更新连接的 localhost。
 */
function chatPageCsp(developing: boolean): string {
  const policy: Array<[string, string]> = [
    ["default-src", "'self'"],
    ["script-src", "'self'"],
    ["style-src", "'self' 'unsafe-inline'"],
    ["img-src", "'self' data: blob: https:"],
    ["font-src", "'self' data:"],
    ["connect-src", developing ? "'self' http://localhost:* ws://localhost:* https: wss:" : "'self' https: wss:"],
    ["media-src", "'self' data: blob: https:"],
    ["worker-src", "'self' blob:"],
    ["object-src", "'none'"],
    ["base-uri", "'self'"],
  ];
  return policy.map(([directive, sources]) => `${directive} ${sources}`).join("; ");
}

/**
 * 构建时改写页面 HTML 的两件事：
 * 1. 把空的 `<span data-app-version></span>` 填成“Firefly_Agent v版本号”，版本取自 package.json；
 * 2. 只给聊天窗口页在 charset 声明后插入 CSP meta。
 */
function pageHtmlPlugin(): Plugin {
  const { version } = JSON.parse(readFileSync(fromRoot("package.json"), "utf8")) as { version: string };
  const versionLabel = `Firefly_Agent v${version}`;
  const charset = '<meta charset="UTF-8" />';
  const isChatPage = (pagePath: string) => pagePath === "/react/" || pagePath.endsWith("/react/index.html");
  return {
    name: "firefly-page-html",
    transformIndexHtml: {
      order: "pre",
      handler(html, context) {
        let page = html.replace(/<span data-app-version><\/span>/g, `<span data-app-version>${versionLabel}</span>`);
        if (isChatPage(context.path)) {
          const csp = chatPageCsp(Boolean(context.server));
          page = page.replace(charset, `${charset}\n  <meta http-equiv="Content-Security-Policy" content="${csp}" />`);
        }
        return page;
      },
    },
  };
}

/**
 * 性能基线 harness 的构建开关，普通构建不受影响：
 * - FIREFLY_PERF_HARNESS=1 只构建 react-perf 页；
 * - FIREFLY_PERF_PROFILE=1 把 react-dom/client 换成 react-dom/profiling，生产构建里 <Profiler onRender> 才有数据。
 *   只能换 react-dom/client：profiling 包内部会 require("react-dom") 取共享 internals，
 *   连裸 "react-dom" 一起换会循环引用，页面报 "Cannot read properties of undefined (reading 'd')"；
 * - FIREFLY_PERF_OUT_DIR 指定产物目录（相对项目根），默认 dist/renderer。
 */
const perf = {
  harness: fireflyEnvironment(process.env, "FIREFLY_PERF_HARNESS") === "1",
  profile: fireflyEnvironment(process.env, "FIREFLY_PERF_PROFILE") === "1",
  outDir: fireflyEnvironment(process.env, "FIREFLY_PERF_OUT_DIR"),
};

const rendererRoot = fromRoot("src/renderer");
const pageInputs = perf.harness
  ? { "chat-perf": resolve(rendererRoot, "react-perf/index.html") }
  : Object.fromEntries(Object.entries(PAGES).map(([name, html]) => [name, resolve(rendererRoot, html)]));

export default defineConfig({
  root: rendererRoot,
  base: "./",
  plugins: [react(), pageHtmlPlugin(), tailwindcss()],
  ...(perf.profile ? { resolve: { alias: [{ find: /^react-dom\/client$/, replacement: "react-dom/profiling" }] } } : {}),
  build: {
    outDir: perf.outDir ? fromRoot(perf.outDir) : fromRoot("dist/renderer"),
    emptyOutDir: true,
    rollupOptions: { input: pageInputs },
  },
  server: { port: 5173, strictPort: false },
});
