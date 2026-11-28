/**
 * firefly-plugin 命令行（随 @firefly_wu/plugin-sdk 发布，见 scripts/plugin-sdk/build-sdk.mjs）。
 *
 *   firefly-plugin validate <dir>            校验清单与包边界
 *   firefly-plugin pack <dir> -o <file>      校验通过后打成 .ffplugin（ZIP）
 *
 * 退出码：0 成功；1 包不合法；2 命令用法错误；3 意外的内部错误。
 */
import type { ManifestError } from "../../../shared/plugin-manifest";
import { inspectPackage } from "../package/inspect";
import { packPackage } from "../package/pack";

/** 清单的 sdk 范围默认对照这个宿主版本；SDK 与应用同版本号（1.2.x），可用 --host-version 覆盖。 */
export const DEFAULT_HOST_VERSION = "1.2.0";

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

const USAGE = [
  "用法:",
  "  firefly-plugin validate <目录> [--host-version <版本>]",
  "  firefly-plugin pack <目录> -o <输出文件.ffplugin> [--host-version <版本>]",
  "",
  `--host-version 默认 ${DEFAULT_HOST_VERSION}：清单的 sdk 范围要满足这个宿主版本。`,
].join("\n");

interface ParsedArgs {
  positional: string[];
  output?: string;
  hostVersion: string;
}

function parseArgs(args: string[]): ParsedArgs | string {
  const parsed: ParsedArgs = { positional: [], hostVersion: DEFAULT_HOST_VERSION };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-o" || arg === "--output" || arg === "--host-version") {
      const value = args[++i];
      if (value === undefined || value.startsWith("-")) return `${arg} 需要一个值`;
      if (arg === "--host-version") parsed.hostVersion = value;
      else parsed.output = value;
    } else if (arg.startsWith("-")) {
      return `未知选项 ${arg}`;
    } else {
      parsed.positional.push(arg);
    }
  }
  return parsed;
}

function reportErrors(io: CliIo, errors: ManifestError[]): void {
  for (const error of errors) {
    const where = error.path === "" ? "(清单)" : error.path;
    const file = error.file ? ` [${error.file}]` : "";
    io.err(`错误 ${error.code} ${where}: ${error.message}${file}`);
  }
  io.err(`共 ${errors.length} 个错误`);
}

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    (command === undefined ? io.err : io.out)(USAGE);
    return command === undefined ? 2 : 0;
  }
  if (command !== "validate" && command !== "pack") {
    io.err(`未知命令 ${command}\n${USAGE}`);
    return 2;
  }

  const parsed = parseArgs(rest);
  if (typeof parsed === "string") {
    io.err(`${parsed}\n${USAGE}`);
    return 2;
  }
  if (parsed.positional.length !== 1) {
    io.err(`${command} 需要且只需要一个包目录\n${USAGE}`);
    return 2;
  }
  if (command === "validate" && parsed.output !== undefined) {
    io.err(`validate 不接受 -o\n${USAGE}`);
    return 2;
  }
  if (command === "pack" && parsed.output === undefined) {
    io.err(`pack 需要 -o <输出文件>\n${USAGE}`);
    return 2;
  }

  const dir = parsed.positional[0];
  try {
    if (command === "validate") {
      const result = await inspectPackage(dir, { hostVersion: parsed.hostVersion });
      if (!result.ok) {
        reportErrors(io, result.errors);
        return 1;
      }
      io.out(`通过: ${result.manifest.id}@${result.manifest.version}（${result.files.length} 个文件）`);
      return 0;
    }

    const packed = await packPackage(dir, parsed.output as string, { hostVersion: parsed.hostVersion });
    if (!packed.ok) {
      reportErrors(io, packed.errors);
      io.err("未生成任何文件");
      return 1;
    }
    io.out(`已生成 ${packed.outFile}（${packed.entries.length} 个文件，${packed.bytes} 字节）`);
    return 0;
  } catch (error) {
    io.err(`内部错误: ${error instanceof Error ? error.message : String(error)}`);
    return 3;
  }
}
