import { describe, it, expect, vi } from "vitest";
import { createCodeGitTools, registerCodeGitTools } from "./git-tools";
import type { GitService } from "../../code-git/git-service";
import type { ToolContext } from "./registry/tool-context";

const trusted: ToolContext = { mode: "code", userQuery: "Record the reviewed changes", conversationId: "conversation-73", resolvedWorkspaceRoot: "E:\\reviewed-project" };
const api = () => ({ initRepository: vi.fn(async () => "repository created"), commit: vi.fn(async () => "revision recorded") }) as unknown as GitService;
const operations = ["git_status", "git_init", "git_commit", "git_switch_branch", "git_push", "git_revert", "git_diff", "git_log"];
describe("Git tools as a trusted service adapter", () => {
  it("creates and registers exactly the approved operations in order", () => {
    const service = api();
    expect(createCodeGitTools(service).map(tool => tool.id)).toEqual(operations);
    const received: string[] = [];
    registerCodeGitTools(service, { register: entry => { received.push(entry.id); } });
    expect(received).toEqual(operations);
  });
  it("refuses a mutation outside Code mode before calling the service", async () => {
    const service = api();
    const initialize = createCodeGitTools(service).find(tool => tool.id === "git_init")!;
    await expect(initialize.execute({}, { ...trusted, mode: "work" })).rejects.toThrow("Git 工具只允许在 Code 模式使用");
    expect(service.initRepository).not.toHaveBeenCalled();
  });
  it("uses the runtime binding instead of a root supplied in model arguments", async () => {
    const service = api();
    const commit = createCodeGitTools(service).find(tool => tool.id === "git_commit")!;
    await commit.execute({ message: "Record reviewed document", paths: ["docs/review.md"], workspaceRoot: "E:\\unapproved-project" }, trusted);
    expect(service.commit).toHaveBeenCalledTimes(1);
    expect(service.commit).toHaveBeenCalledWith({ sessionId: "conversation-73", mode: "code", workspaceRoot: "E:\\reviewed-project" }, "Record reviewed document", ["docs/review.md"]);
  });
});
