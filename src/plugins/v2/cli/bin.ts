import { runCli } from "./main";

runCli(process.argv.slice(2), {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
}).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`内部错误: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 3;
  },
);
