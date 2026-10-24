import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC } from "../../shared/ipc-channels";

// 输入模态声明的落盘行为：档案保存 / 默认档案切换 / 全局保存 / 旧存档与非法值。
// 用真实临时目录（与 settings-read-ipc.test.ts 同一做法），不 mock 存储层。
const state = vi.hoisted(() => ({ directory: "" }));
vi.mock("electron", () => ({ app: { getPath: () => state.directory }, BrowserWindow: {}, dialog: {}, shell: {} }));
vi.mock("../startup/env", () => ({ isDev: true }));

beforeEach(() => {
  vi.resetModules();
  state.directory = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-input-modalities-"));
});
afterEach(() => fs.rmSync(state.directory, { recursive: true, force: true }));

// 型号名刻意不在内置目录里，让结果只取决于声明本身。
const base = { provider: "自定义", baseUrl: "https://gateway.example/v1", apiKey: "synthetic-key" };
const readDisk = () => JSON.parse(fs.readFileSync(path.join(state.directory, "model-settings.json"), "utf8"));

describe("输入模态声明落盘", () => {
  it("厂商接口记录随档案保存，展开后图片能力与来源一致", async () => {
    const model = await import("./model-settings");
    model.saveModelProfile({ id: "p1", ...base, model: "brand-new-a", inputModalities: ["text", "image"], inputModalitiesSource: "vendor-api" });

    const stored = readDisk().modelProfiles[0];
    expect(stored.inputModalities).toEqual(["text", "image"]);
    expect(stored.inputModalitiesSource).toBe("vendor-api");
    const resolved = model.resolveModelSettingsProfile(model.loadModelSettings(), "p1");
    expect(resolved.multimodal).toBe(true);
    expect(resolved.inputModalitiesSource).toBe("vendor-api");
  });

  it("用户覆盖替换厂商记录；保存时不带声明即回到自动（内置目录 / 未知）", async () => {
    const model = await import("./model-settings");
    model.saveModelProfile({ id: "p1", ...base, model: "brand-new-a", inputModalities: ["text", "image"], inputModalitiesSource: "vendor-api" });
    model.saveModelProfile({ id: "p1", ...base, model: "brand-new-a", inputModalities: ["text"], inputModalitiesSource: "user" });
    expect(model.resolveModelSettingsProfile(model.loadModelSettings(), "p1")).toMatchObject({ multimodal: false, inputModalitiesSource: "user" });

    model.saveModelProfile({ id: "p1", ...base, model: "brand-new-a" });
    const cleared = readDisk().modelProfiles[0];
    expect(cleared).not.toHaveProperty("inputModalities");
    expect(cleared).not.toHaveProperty("inputModalitiesSource");
    expect(model.resolveModelSettingsProfile(model.loadModelSettings(), "p1").multimodal).toBe(false);
  });

  it("默认档案切换时顶层镜像跟随新默认档案，不残留上一个档案的声明", async () => {
    const model = await import("./model-settings");
    model.saveModelProfile({ id: "p1", ...base, model: "brand-new-a", inputModalities: ["text", "image"], inputModalitiesSource: "vendor-api" });
    model.saveModelProfile({ id: "p2", ...base, model: "plain-b" });
    // 镜像只在显式设置默认档案时刷新（与既有的 provider/model 镜像同一规则）
    model.setDefaultModelProfile("p1");
    expect(model.loadModelSettings()).toMatchObject({ defaultModelProfileId: "p1", multimodal: true, inputModalitiesSource: "vendor-api" });

    model.setDefaultModelProfile("p2");
    const toPlain = model.loadModelSettings();
    expect(toPlain.defaultModelProfileId).toBe("p2");
    expect(toPlain.multimodal).toBe(false);
    expect(toPlain.inputModalities).toBeUndefined();
    expect(toPlain.inputModalitiesSource).toBeUndefined();

    model.setDefaultModelProfile("p1");
    expect(model.loadModelSettings()).toMatchObject({ multimodal: true, inputModalities: ["text", "image"], inputModalitiesSource: "vendor-api" });
  });

  it("保存全局选项不会抹掉当前厂商的输入模态声明", async () => {
    const model = await import("./model-settings");
    model.saveModelProfile({ id: "p1", ...base, model: "brand-new-a", inputModalities: ["text", "image"], inputModalitiesSource: "user" });
    model.setDefaultModelProfile("p1");
    model.saveModelSettings({ stickerEnabled: true });
    expect(model.loadModelSettings()).toMatchObject({ multimodal: true, inputModalities: ["text", "image"], inputModalitiesSource: "user" });
  });
});

describe("输入模态旧存档与非法值", () => {
  it("旧存档没有声明字段时按未声明处理，目录照常生效", async () => {
    fs.writeFileSync(path.join(state.directory, "model-settings.json"), JSON.stringify({
      schemaVersion: 2,
      provider: "Claude（Anthropic）",
      defaultModelProfileId: "old",
      modelProfiles: [{ id: "old", provider: "Claude（Anthropic）", baseUrl: "https://api.anthropic.com/v1", apiKey: "synthetic-key", model: "claude-sonnet-4-6", multimodal: false }],
    }));
    const model = await import("./model-settings");
    const resolved = model.resolveModelSettingsProfile(model.loadModelSettings(), "old");
    expect(resolved.multimodal).toBe(true);
    expect(resolved.inputModalities).toBeUndefined();
    expect(resolved.inputModalitiesSource).toBeUndefined();
  });

  it("非法的模态值回落为未声明；合法模态配非法来源记为用户覆盖", async () => {
    fs.writeFileSync(path.join(state.directory, "model-settings.json"), JSON.stringify({
      schemaVersion: 2,
      provider: "自定义",
      defaultModelProfileId: "bad-list",
      modelProfiles: [
        { id: "bad-list", ...base, model: "brand-new-a", inputModalities: ["audio"], inputModalitiesSource: "vendor-api" },
        { id: "bad-source", ...base, model: "brand-new-b", inputModalities: ["image"], inputModalitiesSource: "catalog" },
      ],
    }));
    const model = await import("./model-settings");
    const settings = model.loadModelSettings();
    const badList = settings.modelProfiles!.find((item) => item.id === "bad-list")!;
    expect(badList).not.toHaveProperty("inputModalities");
    expect(badList).not.toHaveProperty("inputModalitiesSource");
    const badSource = settings.modelProfiles!.find((item) => item.id === "bad-source")!;
    expect(badSource.inputModalities).toEqual(["image"]);
    expect(badSource.inputModalitiesSource).toBe("user");
    expect(model.resolveModelSettingsProfile(settings, "bad-source").multimodal).toBe(true);
  });
});

describe("档案列表视图带出图片能力与依据", () => {
  it("每个档案的 multimodal 与 multimodalSource 都由同一判定入口给出", async () => {
    fs.writeFileSync(path.join(state.directory, "model-settings.json"), JSON.stringify({
      schemaVersion: 2,
      provider: "自定义",
      defaultModelProfileId: "a",
      modelProfiles: [
        { id: "a", ...base, model: "brand-new-a", inputModalities: ["text", "image"], inputModalitiesSource: "vendor-api" },
        { id: "b", ...base, model: "gpt-4o" },
        { id: "c", ...base, model: "gpt-4o", inputModalities: ["text"], inputModalitiesSource: "user" },
        { id: "d", ...base, model: "mystery" },
      ],
    }));
    const model = await import("./model-settings");
    const { registerSettingsIpc } = await import("./settings-ipc");
    const windows = await import("../windows/window-state");
    const webContents = { isDestroyed: () => false, mainFrame: { url: "http://localhost:5173/settings/" } };
    windows.setSettingsWindow({ isDestroyed: () => false, webContents } as never);
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    registerSettingsIpc({
      ipc: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler), on: vi.fn() },
      getModelSettings: model.loadModelSettings,
    } as never);
    const view = handlers.get(IPC.SETTINGS_MODEL_PROFILES_LIST)!({ sender: webContents, senderFrame: webContents.mainFrame }) as { profiles: Array<{ id: string; multimodal: boolean; multimodalSource: string }> };
    expect(Object.fromEntries(view.profiles.map((item) => [item.id, [item.multimodal, item.multimodalSource]]))).toEqual({
      a: [true, "declared-vendor-api"],
      b: [true, "catalog"],
      c: [false, "declared-user"],
      d: [false, "unknown"],
    });
  });
});
