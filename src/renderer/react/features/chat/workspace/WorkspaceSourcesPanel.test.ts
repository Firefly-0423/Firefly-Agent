import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkspaceSourcesPanel, type WorkspaceSourcesLabels } from "./WorkspaceSourcesPanel";

const labels: WorkspaceSourcesLabels = {
  panel: "输出来源", empty: "未提供结构化来源", pending: "来源待确认",
  success: "工具成功", failure: "工具失败", unknown: "结果不确定", notExecuted: "未执行",
  fileRead: "文件读取", fileChange: "文件变更", webSearch: "搜索结果",
};

describe("WorkspaceSourcesPanel presentation proposal", () => {
  it("shows an explicit empty state instead of inferring sources", () => {
    const html = renderToStaticMarkup(createElement(WorkspaceSourcesPanel, { rows: [], labels }));
    expect(html).toContain(labels.empty);
  });

  it.each([
    ["success", "工具成功"], ["failure", "工具失败"], ["unknown", "结果不确定"], ["not_executed", "未执行"],
  ] as const)("preserves the %s tool outcome without claiming durable completion", (outcome, label) => {
    const html = renderToStaticMarkup(createElement(WorkspaceSourcesPanel, {
      labels, rows: [{ id: "row-a", toolLabel: "读取文件", outcome, refs: [{ kind: "file_read", display: "src/example.ts:1–10" }] }],
    }));
    expect(html).toContain(label);
    expect(html).toContain(labels.pending);
    expect(html).not.toContain("已保存");
    expect(html).not.toContain("已提交");
  });

  it("renders supplied source types but creates no file or URL opening affordance", () => {
    const html = renderToStaticMarkup(createElement(WorkspaceSourcesPanel, {
      labels, rows: [{ id: "row-a", toolLabel: "工具", outcome: "success", refs: [
        { kind: "file_read", display: "src/example.ts" },
        { kind: "file_change", display: "src/changed.ts" },
        { kind: "web_search", display: "https://example.com/search-result" },
      ] }],
    }));
    expect(html).toContain(labels.fileRead);
    expect(html).toContain(labels.fileChange);
    expect(html).toContain(labels.webSearch);
    expect(html).not.toContain("href=");
    expect(html).not.toContain("<button");
  });

  it("escapes untrusted display text", () => {
    const html = renderToStaticMarkup(createElement(WorkspaceSourcesPanel, {
      labels, rows: [{ id: "row-a", toolLabel: '<img src=x onerror="alert(1)">', outcome: "failure",
        refs: [{ kind: "web_search", display: "<script>alert(1)</script>" }] }],
    }));
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img ");
    expect(html).toContain("&lt;script&gt;");
  });

  it("keeps a tool result visible when it has no supplied structured references", () => {
    const html = renderToStaticMarkup(createElement(WorkspaceSourcesPanel, {
      labels, rows: [{ id: "row-a", toolLabel: "run_shell", outcome: "unknown", refs: [] }],
    }));
    expect(html).toContain("run_shell");
    expect(html).toContain(labels.unknown);
    expect(html).toContain(labels.empty);
  });
});
