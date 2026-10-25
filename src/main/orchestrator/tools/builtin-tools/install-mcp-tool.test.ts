import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  addMcpServer: vi.fn(async () => ({ ok: true, toolIds: ["demo__echo"] })),
  requestUserChoice: vi.fn(async (_question: string, _options: unknown, _fallback: string, _scope?: unknown) => "install"),
}));

vi.mock("../../mcp-manager", () => ({ addMcpServer: mocks.addMcpServer }));
vi.mock("../../../chat/user-choice", () => ({ requestUserChoice: mocks.requestUserChoice }));

import { installMcpServerTool } from "./install-mcp-tool";

const args = { id: "demo", name: "demo", command: "node", args: ["server.js"], env: { API_TOKEN: "secret-value" }, cwd: "E:\\work" };

describe("install_mcp_server confirmation", () => {
  beforeEach(() => {
    mocks.addMcpServer.mockClear();
    mocks.requestUserChoice.mockClear();
    mocks.requestUserChoice.mockResolvedValue("install");
  });

  it("asks before installing, whatever the permission level, and shows names but never env values", async () => {
    await installMcpServerTool.execute(args);
    expect(mocks.requestUserChoice).toHaveBeenCalledTimes(1);
    const [question, options, fallback] = mocks.requestUserChoice.mock.calls[0]!;
    expect(question).toContain("node");
    expect(question).toContain("server.js");
    expect(question).toContain("E:\\work");
    expect(question).toContain("API_TOKEN");
    expect(question).not.toContain("secret-value");
    expect(options).toEqual([{ label: "安装并连接", value: "install" }, { label: "取消", value: "cancel" }]);
    expect(fallback).toBe("cancel");
  });

  it("installs only after the user confirms", async () => {
    const result = await installMcpServerTool.execute(args);
    expect(mocks.addMcpServer).toHaveBeenCalledTimes(1);
    expect(result).toContain("已连接");
  });

  it("does not start the command while approval is pending", async () => {
    let approve!: (choice: string) => void;
    mocks.requestUserChoice.mockReturnValueOnce(new Promise(resolve => { approve = resolve; }));
    const pending = installMcpServerTool.execute(args);
    expect(mocks.addMcpServer).not.toHaveBeenCalled();
    approve("install");
    await pending;
    expect(mocks.addMcpServer).toHaveBeenCalledTimes(1);
  });

  it("scopes the card to the run so cancelling the run voids it", async () => {
    const controller = new AbortController();
    await installMcpServerTool.execute(args, { userQuery: "", runId: "run-1", signal: controller.signal });
    expect(mocks.requestUserChoice.mock.calls[0]![3]).toEqual({ runId: "run-1", signal: controller.signal });
  });

  it("never installs when the run was aborted by the time the answer arrives", async () => {
    const controller = new AbortController();
    mocks.requestUserChoice.mockImplementation(async () => { controller.abort(); return "install"; });
    await expect(installMcpServerTool.execute(args, { userQuery: "", runId: "run-1", signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.addMcpServer).not.toHaveBeenCalled();
  });

  it("propagates the abort of a pending card without installing", async () => {
    mocks.requestUserChoice.mockRejectedValue(Object.assign(new Error("aborted"), { name: "AbortError" }));
    await expect(installMcpServerTool.execute(args, { userQuery: "", runId: "run-1" })).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.addMcpServer).not.toHaveBeenCalled();
  });

  it("does nothing when the user cancels or the card times out", async () => {
    mocks.requestUserChoice.mockResolvedValue("cancel");
    expect(await installMcpServerTool.execute(args)).toContain("用户取消");
    expect(mocks.addMcpServer).not.toHaveBeenCalled();
  });

  it.each(["result", "throw"])("does not send raw %s errors back to the model", async kind => {
    const error = "TOKEN=synthetic-private-credential";
    if (kind === "throw") mocks.addMcpServer.mockRejectedValueOnce(new Error(error));
    else mocks.addMcpServer.mockResolvedValueOnce({ ok: false, error, reason: "timeout" } as never);
    const result = await installMcpServerTool.execute(args);
    expect(result).toContain("安装");
    expect(result).not.toContain("synthetic-private-credential");
  });

  it("does not log command arguments that can contain credentials", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await installMcpServerTool.execute({ ...args, args: ["--token", "synthetic-private-credential"] });
      expect(JSON.stringify(log.mock.calls)).not.toContain("synthetic-private-credential");
    } finally { log.mockRestore(); }
  });
});
