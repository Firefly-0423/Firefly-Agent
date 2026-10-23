import { EventEmitter } from "node:events";
import type { WebContents } from "electron";
import { describe, expect, test, vi } from "vitest";
import {
  type ActiveChatTargetInvalidReason,
  createActiveChatTargetRegistry,
  generateRendererTargetId,
  parseActiveTargetPayload,
} from "./active-chat-target";

class FakePage extends EventEmitter {
  destroyed = false;
  constructor(readonly id: number) {
    super();
  }
  isDestroyed() {
    return this.destroyed;
  }
  asContents(): WebContents {
    return this as unknown as WebContents;
  }
  navigate(mainFrame: boolean) {
    this.emit("did-start-navigation", {}, "app://chat/index.html", false, mainFrame, 1, 1);
  }
  destroy() {
    this.destroyed = true;
    this.emit("destroyed");
  }
}

function setup() {
  const registry = createActiveChatTargetRegistry();
  const log: Array<[ActiveChatTargetInvalidReason, unknown]> = [];
  registry.onInvalidated((reason, affected) => log.push([reason, affected]));
  return { registry, log };
}

const report = (page: FakePage, sessionId: string, rendererTargetId = "rt", mode: "chat" | "work" | "code" = "chat") => ({
  sender: page.asContents(),
  sessionId,
  mode,
  rendererTargetId,
});

describe("登记与快照", () => {
  test("尚未登记时 getActive 为 null", () => {
    expect(createActiveChatTargetRegistry().getActive()).toBeNull();
  });

  test("快照包含会话、模式、渲染目标与 webContents id", () => {
    const { registry } = setup();
    registry.setActive(report(new FakePage(21), "sess-x", "tgt-9", "code"));
    expect(registry.getActive()).toEqual({
      sessionId: "sess-x",
      mode: "code",
      rendererTargetId: "tgt-9",
      webContentsId: 21,
    });
  });

  test("返回的快照是副本：修改它或后续切换都不影响登记表", () => {
    const { registry } = setup();
    const page = new FakePage(1);
    registry.setActive(report(page, "a"));
    const first = registry.getActive()!;
    first.sessionId = "tampered";
    expect(registry.getActive()?.sessionId).toBe("a");
    registry.setActive(report(page, "b"));
    expect(first.sessionId).toBe("tampered");
    expect(registry.getActive()?.sessionId).toBe("b");
  });

  test("已销毁的 webContents 上报被忽略", () => {
    const { registry } = setup();
    const page = new FakePage(1);
    page.destroyed = true;
    registry.setActive(report(page, "a"));
    expect(registry.getActive()).toBeNull();
  });

  test("同页切换会话不产生失效通知", () => {
    const { registry, log } = setup();
    const page = new FakePage(1);
    registry.setActive(report(page, "a", "rt-keep"));
    registry.setActive(report(page, "b", "rt-keep", "work"));
    registry.setActive(report(page, "c", "rt-keep"));
    expect(log).toEqual([]);
    expect(registry.getActive()).toMatchObject({ sessionId: "c", rendererTargetId: "rt-keep" });
  });
});

describe("clearActive", () => {
  test("只有登记页自己能清空", () => {
    const { registry } = setup();
    const owner = new FakePage(1);
    const stranger = new FakePage(2);
    registry.setActive(report(owner, "a"));
    registry.clearActive(stranger.asContents());
    expect(registry.getActive()).not.toBeNull();
    registry.clearActive(owner.asContents());
    expect(registry.getActive()).toBeNull();
  });

  test("清空本身不触发失效通知", () => {
    const { registry, log } = setup();
    const page = new FakePage(1);
    registry.setActive(report(page, "a"));
    registry.clearActive(page.asContents());
    expect(log).toEqual([]);
  });
});

describe("页面生命周期导致失效", () => {
  test("主框架导航：通知 navigation 并携带失效前快照", () => {
    const { registry, log } = setup();
    const page = new FakePage(3);
    registry.setActive(report(page, "a", "rt-1"));
    page.navigate(true);
    expect(log).toEqual([
      ["navigation", { sessionId: "a", mode: "chat", rendererTargetId: "rt-1", webContentsId: 3 }],
    ]);
    expect(registry.getActive()).toBeNull();
  });

  test("子框架导航被忽略，且之后主框架导航仍然生效", () => {
    const { registry, log } = setup();
    const page = new FakePage(3);
    registry.setActive(report(page, "a"));
    page.navigate(false);
    page.navigate(false);
    expect(log).toHaveLength(0);
    expect(registry.getActive()).not.toBeNull();
    page.navigate(true);
    expect(log.map(([r]) => r)).toEqual(["navigation"]);
  });

  test("webContents 销毁：通知 target-destroyed 并清空", () => {
    const { registry, log } = setup();
    const page = new FakePage(3);
    registry.setActive(report(page, "a"));
    page.destroy();
    expect(log.map(([r]) => r)).toEqual(["target-destroyed"]);
    expect(registry.getActive()).toBeNull();
  });

  test("重新登记（新页面）后，旧页面的导航与销毁都不再影响", () => {
    const { registry, log } = setup();
    const before = new FakePage(1);
    const after = new FakePage(2);
    registry.setActive(report(before, "a", "rt-old"));
    registry.setActive(report(after, "b", "rt-new"));
    before.navigate(true);
    before.destroy();
    expect(log).toEqual([]);
    expect(registry.getActive()).toMatchObject({ sessionId: "b", webContentsId: 2 });
    after.navigate(true);
    expect(log).toHaveLength(1);
  });

  test("导航使目标清空后，同一页面可以再次登记并再次被监听", () => {
    const { registry, log } = setup();
    const page = new FakePage(1);
    registry.setActive(report(page, "a", "rt-1"));
    page.navigate(true);
    registry.setActive(report(page, "a", "rt-2"));
    expect(registry.getActive()?.rendererTargetId).toBe("rt-2");
    page.navigate(true);
    expect(log).toHaveLength(2);
  });

  test("没有登记目标时页面事件不会到达（尚未挂载监听）", () => {
    const { log } = setup();
    const page = new FakePage(1);
    page.navigate(true);
    page.destroy();
    expect(log).toEqual([]);
  });
});

describe("会话删除", () => {
  test("删除当前会话：通知 session-deleted 并清空；删除其他会话无影响", () => {
    const { registry, log } = setup();
    registry.setActive(report(new FakePage(1), "keep"));
    registry.notifySessionDeleted("unrelated");
    expect(log).toEqual([]);
    registry.notifySessionDeleted("keep");
    expect(log.map(([r]) => r)).toEqual(["session-deleted"]);
    expect(registry.getActive()).toBeNull();
  });

  test("onSessionDeleted 对任意会话都触发，包括没有当前目标时", () => {
    const registry = createActiveChatTargetRegistry();
    const seen: string[] = [];
    registry.onSessionDeleted((id) => seen.push(id));
    registry.notifySessionDeleted("ghost");
    registry.setActive(report(new FakePage(1), "now"));
    registry.notifySessionDeleted("older");
    expect(seen).toEqual(["ghost", "older"]);
    expect(registry.getActive()?.sessionId).toBe("now");
  });

  test("删除通知先于失效通知触发", () => {
    const registry = createActiveChatTargetRegistry();
    const order: string[] = [];
    registry.onSessionDeleted(() => order.push("deleted"));
    registry.onInvalidated(() => order.push("invalidated"));
    registry.setActive(report(new FakePage(1), "s"));
    registry.notifySessionDeleted("s");
    expect(order).toEqual(["deleted", "invalidated"]);
  });
});

describe("订阅管理", () => {
  test("取消订阅后不再收到通知", () => {
    const registry = createActiveChatTargetRegistry();
    const page = new FakePage(1);
    const listener = vi.fn();
    const off = registry.onInvalidated(listener);
    const offDel = registry.onSessionDeleted(listener);
    off();
    offDel();
    registry.setActive(report(page, "s"));
    registry.notifySessionDeleted("s");
    expect(listener).not.toHaveBeenCalled();
  });

  test("某个监听器抛错不影响其余监听器和状态清理", () => {
    const registry = createActiveChatTargetRegistry();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const good = vi.fn();
    const goodDel = vi.fn();
    registry.onInvalidated(() => {
      throw new Error("boom");
    });
    registry.onInvalidated(good);
    registry.onSessionDeleted(() => {
      throw new Error("boom2");
    });
    registry.onSessionDeleted(goodDel);
    registry.setActive(report(new FakePage(1), "s"));
    registry.notifySessionDeleted("s");
    expect(goodDel).toHaveBeenCalledWith("s");
    expect(good).toHaveBeenCalledTimes(1);
    expect(registry.getActive()).toBeNull();
    warn.mockRestore();
  });
});

describe("dispose", () => {
  test("清空目标，之后的上报、清空、删除通知与页面事件全部无效", () => {
    const registry = createActiveChatTargetRegistry();
    const invalid = vi.fn();
    const deleted = vi.fn();
    registry.onInvalidated(invalid);
    registry.onSessionDeleted(deleted);
    const page = new FakePage(1);
    registry.setActive(report(page, "s"));
    registry.dispose();
    expect(registry.getActive()).toBeNull();
    registry.setActive(report(page, "t"));
    registry.notifySessionDeleted("t");
    page.navigate(true);
    page.destroy();
    expect(registry.getActive()).toBeNull();
    expect(invalid).not.toHaveBeenCalled();
    expect(deleted).not.toHaveBeenCalled();
  });

  test("重复 dispose 不报错", () => {
    const registry = createActiveChatTargetRegistry();
    registry.dispose();
    expect(() => registry.dispose()).not.toThrow();
  });
});

describe("parseActiveTargetPayload", () => {
  test.each(["chat", "work", "code"] as const)("接受模式 %s", (mode) => {
    expect(parseActiveTargetPayload({ sessionId: "s", mode, rendererTargetId: "r" })).toEqual({
      sessionId: "s",
      mode,
      rendererTargetId: "r",
    });
  });

  test("多余字段被丢弃", () => {
    const out = parseActiveTargetPayload({ sessionId: "s", mode: "chat", rendererTargetId: "r", extra: 1 });
    expect(out).toEqual({ sessionId: "s", mode: "chat", rendererTargetId: "r" });
  });

  test.each([
    ["null", null],
    ["字符串", "x"],
    ["数字", 5],
    ["空对象", {}],
    ["会话 id 为空", { sessionId: "", mode: "chat", rendererTargetId: "r" }],
    ["会话 id 非字符串", { sessionId: 1, mode: "chat", rendererTargetId: "r" }],
    ["未知模式", { sessionId: "s", mode: "admin", rendererTargetId: "r" }],
    ["缺模式", { sessionId: "s", rendererTargetId: "r" }],
    ["渲染目标为空", { sessionId: "s", mode: "chat", rendererTargetId: "" }],
    ["渲染目标缺失", { sessionId: "s", mode: "chat" }],
  ])("拒绝：%s", (_name, payload) => {
    expect(parseActiveTargetPayload(payload)).toBeNull();
  });
});

describe("generateRendererTargetId", () => {
  test("得到非空且互不相同的字符串", () => {
    const ids = new Set(Array.from({ length: 20 }, () => generateRendererTargetId()));
    expect(ids.size).toBe(20);
    for (const id of ids) expect(id.length).toBeGreaterThan(0);
  });
});
