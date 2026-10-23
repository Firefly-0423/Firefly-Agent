/**
 * process.stdout / process.stderr 的薄封装。
 * 不用 console.log：Windows 旧代码页（cp936、cp950）下它会转码，
 * cmd.exe 里的制表符可能乱码；直接写流并补 \n 更稳。
 */
import process from "node:process";

export const out = (s: string): void => {
  process.stdout.write(s);
};

export const err = (s: string): void => {
  process.stderr.write(s);
};

export const outLine = (s = ""): void => {
  process.stdout.write(`${s}\n`);
};

export const errLine = (s = ""): void => {
  process.stderr.write(`${s}\n`);
};
