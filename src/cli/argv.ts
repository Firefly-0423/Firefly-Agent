/**
 * 手写的参数解析，命令面很小，不引入 commander/yargs。
 * unknown 是正式的一类结果，这样 app.ts 里的分派表能做穷尽检查。
 */
export type Command =
  | { kind: "unknown"; name: string }
  | { kind: "placeholder"; name: "doctor" | "init" | "update" }
  | { kind: "run" }
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "about" }
  | { kind: "hello" }
  | { kind: "default" };

const PLAIN_COMMANDS = ["hello", "about", "version", "help", "run"] as const;
const PLACEHOLDER_COMMANDS = ["doctor", "init", "update"] as const;

function lookupSubcommand(name: string): Command | undefined {
  const plain = PLAIN_COMMANDS.find((candidate) => candidate === name);
  if (plain) return { kind: plain };
  const placeholder = PLACEHOLDER_COMMANDS.find((candidate) => candidate === name);
  if (placeholder) return { kind: "placeholder", name: placeholder };
  return undefined;
}

const looksLikeFlag = (token: string): boolean => token.startsWith("-");

export function parseArgv(argv: readonly string[]): Command {
  // --help/-h 与 --version/-v 位置不限，且优先于任何子命令；按出现顺序取第一个
  const global = argv.find((t) => ["--help", "-h", "--version", "-v"].includes(t));
  if (global !== undefined) {
    return { kind: global === "--help" || global === "-h" ? "help" : "version" };
  }

  // 第一个非标志参数是子命令；没有时，若有不认识的标志，把第一个当作未知命令
  const name = argv.find((t) => !looksLikeFlag(t));
  if (name === undefined) {
    const stray = argv.find(looksLikeFlag);
    return stray === undefined ? { kind: "default" } : { kind: "unknown", name: stray };
  }
  return lookupSubcommand(name) ?? { kind: "unknown", name };
}
