import { expect, it, describe } from "vitest";
import { parseArgv } from "./argv";

describe("command selection from shell arguments", () => {
  it("selects the welcome flow when there are no arguments", () => {
    expect(parseArgv([])).toStrictEqual({ kind: "default" });
  });
  it.each(["run", "help", "version", "about", "hello"])("recognizes the %s verb", kind => {
    expect(parseArgv([kind])).toStrictEqual({ kind });
  });
  it.each(["update", "doctor", "init"])("identifies reserved verb %s", name => {
    expect(parseArgv([name])).toStrictEqual({ name, kind: "placeholder" });
  });
  it.each([
    ["help", ["--help"]], ["help", ["-h"]], ["help", ["about", "--help"]], ["help", ["-h", "run"]],
    ["version", ["--version"]], ["version", ["-v"]], ["version", ["about", "-v"]],
  ] as const)("gives the %s flag precedence for %j", (kind, args) => {
    expect(parseArgv(args)).toStrictEqual({ kind });
  });
  it.each(["unrecognized-verb", "--unsupported"])("preserves unknown token %s for diagnostics", name => {
    expect(parseArgv([name])).toStrictEqual({ name, kind: "unknown" });
  });
});
