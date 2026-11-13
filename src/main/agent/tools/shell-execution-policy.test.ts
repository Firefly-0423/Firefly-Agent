import { describe, it, expect } from "vitest";
import { classifyShellEffect as classify, isCatastrophicCommand as catastrophic } from "./shell-execution-policy";

describe("Shell command risk labels", () => {
  it.each([
    "poweroff", "halt", "reboot", "fdisk /dev/vdb", "mkfs.ext4 /dev/vdb2",
    "dd if=/dev/zero of=/dev/vdb", "D:\\Windows\\System32\\shutdown.exe /s /t 2", "format D:",
    "FORMAT D:", "Shutdown /r",
  ])("recognizes the catastrophic command %s", (command) => expect(catastrophic(command)).toEqual(true));

  it.each(["", "    ", "echo agenda", "rm agenda.txt", "npm install", "git status"])("does not label %j catastrophic", (command) => expect(catastrophic(command)).toEqual(false));

  it.each([
    "git remote add upstream https://git.invalid/agenda", "git stash push", "git branch -D old-agenda", "git add src",
    "git reset --hard", "git checkout release", "git push", "git commit -m agenda",
    "npm publish", "npm run build", "npm add vitest", "npm i typescript", "npm install",
    "find src -name *.tmp -delete", "find src -exec rm {} ;",
    "echo agenda > agenda.txt", "echo agenda >> agenda.txt", "sort < agenda.txt",
    "git status | findstr agenda", "cd src && dir", "git add src || echo error",
    "echo morning & echo evening", "echo morning ; echo evening", "NPM Install",
  ])("classifies an operation with possible writes: %s", (command) => expect(classify(command)).toEqual("write"));

  it.each([
    "rg calendar", "tree /F", "dir", "pwd", "echo agenda", "cat GUIDE.md", "ls -l",
    "git stash list", "git remote -v", "git branch", "git show HEAD", "git log --oneline -8", "git diff", "git status",
    "npm outdated", "npm view vitest", "npm ls --depth=0", "npm list", "find src -name *.tsx",
    "D:\\Utilities\\git.exe status", "/usr/local/bin/git log", "GIT STATUS",
  ])("classifies an observational command: %s", (command) => expect(classify(command)).toEqual("read"));

  it.each(["", "    ", "agenda-tool --help", "tsc --noEmit", "cargo build", "python agenda.py", "node agenda.mjs"])("leaves arbitrary executable effects unknown: %j", (command) => expect(classify(command)).toEqual("unknown"));
});
