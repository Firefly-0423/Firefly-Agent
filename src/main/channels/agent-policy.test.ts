import { it, expect } from "vitest";
import { resolveChannelAgentPolicy, enforceChannelAgentPolicy } from "./agent-policy";
import type { FireflyRunOptions } from "../orchestrator/firefly-agent";

it("uses a noninteractive work run when channel tools are enabled", () => {
  expect(resolveChannelAgentPolicy("all")).toStrictEqual({
    permissionMode: "allow_all", includeInteractiveTools: false, exposeTools: true, executionMode: "work",
  });
});

it("uses a plain chat run when channel tools are disabled", () => {
  expect(resolveChannelAgentPolicy("off")).toStrictEqual({
    permissionMode: "normal", includeInteractiveTools: false, exposeTools: false, executionMode: "chat",
  });
});

it.each(["qq", "qqbot"] as const)("removes tools and their model-visible catalogs from %s groups", channel => {
  const restriction = resolveChannelAgentPolicy("all", { channel, chatType: "group" });
  expect(restriction).toStrictEqual({
    permissionMode: "normal", includeInteractiveTools: false, exposeTools: false, executionMode: "chat",
  });
  const run = {
    tools: [{ id: "filesystem_read" }], toolSystemContent: "Available operations", skillLayerContent: "Available workflows",
    capabilities: { mode: "chat", tools: [{ id: "filesystem_read" }], toolIds: new Set(["filesystem_read"]), skills: [], skillIds: new Set<string>() },
  } as unknown as FireflyRunOptions;
  enforceChannelAgentPolicy(run, restriction);
  expect(run.tools).toStrictEqual([]);
  expect(run.toolSystemContent).toEqual("");
  expect(run.skillLayerContent).toEqual("");
  expect(run.capabilities?.tools).toStrictEqual([]);
  expect(run.capabilities?.toolIds.size).toEqual(0);
  expect(run.permissionMode).toEqual("normal");
  expect(run.harnessInteractiveTools).toEqual(false);
});
