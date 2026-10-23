/**
 * CLI 主流程：解析参数、分派到对应处理函数、返回退出码。
 * 测试直接导入这里的 main()；index.ts 只负责调用并退出进程。
 *
 * 版本号 __FIREFLY_VERSION__ 由 scripts/build/cli.mjs 通过 esbuild define 注入，
 * 测试环境没有注入，因此 main() 允许传入版本覆盖值。
 */
import { type Command, parseArgv } from "./argv.js";
import * as handlers from "./commands/handlers.js";
import { cmdRun } from "./commands/run.js";

declare const __FIREFLY_VERSION__: string;

const FALLBACK_VERSION = "0.0.0";

function resolveVersion(override?: string): string {
  if (override !== undefined) return override;
  try {
    return typeof __FIREFLY_VERSION__ === "string" ? __FIREFLY_VERSION__ : FALLBACK_VERSION;
  } catch {
    // vitest 下该标识符未定义，访问会抛 ReferenceError
    return FALLBACK_VERSION;
  }
}

type Ctx = handlers.HandlerCtx;
type Outcome = number | Promise<number>;
type KindOf<K extends Command["kind"]> = Extract<Command, { kind: K }>;

/** 每种命令对应一个入口；以 Command["kind"] 为键，新增命令不补处理就会编译报错 */
const ROUTES: { [K in Command["kind"]]: (cmd: KindOf<K>, ctx: Ctx) => Outcome } = {
  unknown: (cmd) => handlers.cmdUnknown(cmd.name),
  placeholder: (cmd) => handlers.cmdPlaceholder(cmd.name),
  run: () => cmdRun(),
  help: () => handlers.cmdHelp(),
  version: (_cmd, ctx) => handlers.cmdVersion(ctx),
  about: () => handlers.cmdAbout(),
  hello: () => handlers.cmdHello(),
  default: (_cmd, ctx) => handlers.cmdDefault(ctx),
};

export async function main(argv: readonly string[], versionOverride?: string): Promise<number> {
  const cmd = parseArgv(argv);
  const route = ROUTES[cmd.kind] as (c: Command, x: Ctx) => Outcome;
  return route(cmd, { version: resolveVersion(versionOverride) });
}
