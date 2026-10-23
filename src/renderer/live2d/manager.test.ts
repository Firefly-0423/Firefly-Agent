import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { HEAD_MIN_Y } from "./model-regions";

const graphics = vi.hoisted(() => ({ load: vi.fn(), apps: [] as any[], textures: {} as Record<string, unknown> }));
vi.mock("pixi-live2d-display/cubism4", () => ({
  Live2DModel: { from: graphics.load }, MotionPriority: { NORMAL: 2, IDLE: 1 },
}));
vi.mock("pixi.js", () => {
  class Renderer {
    gl = { drawingBufferWidth: 640, drawingBufferHeight: 360 };
    resize = vi.fn();
  }
  class Application {
    renderer = new Renderer();
    stage = { children: [] as unknown[], addChild: (value: unknown) => this.stage.children.push(value) };
    ticker = { maxFPS: 0, started: true, stop: () => { this.ticker.started = false; }, start: () => { this.ticker.started = true; } };
    render = vi.fn();
    destroy = vi.fn();
    constructor() { graphics.apps.push(this); }
  }
  return { Application, Renderer, Point: class { constructor(public x = 0, public y = 0) {} },
    utils: { TextureCache: graphics.textures } };
});
import { Live2DManager } from "./manager";

let managers: Live2DManager[] = [];
beforeEach(() => {
  graphics.load.mockReset();
  graphics.apps.length = 0;
  Object.assign(graphics.textures, { portrait: {}, background: {} });
  vi.stubGlobal("window", { devicePixelRatio: 2, innerWidth: 400, innerHeight: 500 });
});
afterEach(() => {
  for (const manager of managers) manager.dispose();
  managers = [];
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const manager = (modelPath = "/models/test-avatar.model3.json") => {
  const result = new Live2DManager({ modelPath, canvas: {} as HTMLCanvasElement, width: 400, height: 500 });
  managers.push(result);
  return result;
};
const manifest = {
  FileReferences: {
    Expressions: [{ Name: "smile", File: "smile.exp3.json" }],
    Motions: { Greeting: [{ Name: "neutral" }, { Name: "wave" }, { Name: "bow" }, { Name: "nod" }] },
  },
};
function avatar(activeId = "ArtMesh211", opacity = 1) {
  const ids = ["ArtMesh157", "ArtMesh23", "ArtMesh155", "ArtMesh211", "ArtMesh153", "ArtMesh156", "ArtMesh154"];
  const core = {
    getDrawableIndex: (id: string) => ids.indexOf(id),
    getDrawableOpacity: vi.fn((index: number) => ids[index] === activeId ? opacity : 1),
    getDrawableVertices: (index: number) => new Float32Array(ids[index] === activeId
      ? [-2, -2, 2, -2, 2, 2, -2, 2] : [30, 30, 40, 30, 40, 40, 30, 40]),
    getDrawableVertexIndices: () => new Uint16Array([0, 1, 2, 0, 2, 3]),
  };
  return {
    width: 400, height: 500, x: 0, y: 0, anchor: { set: vi.fn() }, scale: { set: vi.fn() },
    destroy: vi.fn(), motion: vi.fn().mockResolvedValue(true), expression: vi.fn().mockResolvedValue(true),
    toModelPosition: (point: unknown) => point,
    internalModel: { coreModel: core, motionManager: { definitions: { Greeting: [{}, {}, {}, {}], Tap: [{}, {}, {}] } },
      pixelsPerUnit: 1, originalWidth: 0, originalHeight: 0, getDrawableIDs: () => ids },
  };
}
async function initialize(model = avatar(), definition: unknown = manifest) {
  graphics.load.mockResolvedValueOnce(model);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => definition }));
  const subject = manager();
  await subject.init();
  return { subject, model };
}

test("rejects actions until initialization has supplied a model", async () => {
  const subject = manager();
  expect(await subject.playAction({ kind: "expression", name: "smile" })).toBe(false);
});

test("loads once for concurrent initialization and exposes lifecycle resource metrics", async () => {
  const model = avatar();
  graphics.load.mockResolvedValue(model);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => manifest }));
  const subject = manager();
  expect(subject.getResourceMetrics()).toMatchObject({ appActive: false, modelLoaded: false, disposed: false });
  await Promise.all([subject.init(), subject.init(), subject.init()]);
  expect(graphics.load).toHaveBeenCalledTimes(1);
  expect(graphics.apps[0].ticker.maxFPS).toBe(60);
  expect(subject.getResourceMetrics()).toStrictEqual({
    appActive: true, modelLoaded: true, disposed: false, tickerStarted: true, stageChildren: 1,
    textureCacheSize: 2, rendererType: "webgl", drawingBufferWidth: 640, drawingBufferHeight: 360,
  });
  subject.dispose();
  expect(subject.getResourceMetrics()).toMatchObject({ appActive: false, modelLoaded: false, disposed: true });
});

test("reconnects real Firefly hit areas and actions across successive loads", async () => {
  const definition = JSON.parse(readFileSync("src/renderer/public/models/firefly/Firefly.model3.json", "utf8"));
  for (let cycle = 0; cycle < 2; cycle++) {
    const { subject, model } = await initialize(avatar(), definition);
    expect(subject.getHitAreaDefs()).toStrictEqual([{ name: "Body", id: "ArtMesh154" }, { name: "Head", id: "ArtMesh23" }]);
    expect(await subject.playAction({ kind: "motion", group: "Tap", motionName: "1" })).toBe(true);
    expect(model.motion.mock.calls).toStrictEqual([["Tap", 1, 2]]);
    expect(await subject.playAction({ kind: "expression", name: "expression4" })).toBe(true);
    expect(model.expression.mock.calls).toStrictEqual([["expression4"]]);
    subject.dispose();
    expect(subject.getHitAreaDefs()).toStrictEqual([]);
  }
  expect(graphics.load).toHaveBeenCalledTimes(2);
});

test("dispatches named expressions and motion ordinals without substitutions", async () => {
  const { subject, model } = await initialize();
  expect(await subject.playAction({ kind: "expression", name: "smile" })).toBe(true);
  expect(model.expression.mock.calls).toStrictEqual([["smile"]]);
  await subject.playAction({ kind: "motion", group: "Greeting", motionName: "wave" });
  await subject.playAction({ kind: "motion", group: "Greeting", motionName: "nod" });
  expect(model.motion.mock.calls).toStrictEqual([["Greeting", 1, 2], ["Greeting", 3, 2]]);
  model.expression.mockClear();
  expect(await subject.playAction({ kind: "motion", group: "Greeting", motionName: "absent" })).toBe(false);
  expect(model.expression).not.toHaveBeenCalled();
  expect(model.motion).toHaveBeenCalledTimes(2);
});

test("converts a model rejection into false and reports the action error", async () => {
  const { subject, model } = await initialize();
  const failure = new Error("avatar playback unavailable");
  model.expression.mockRejectedValueOnce(failure);
  const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const action = { kind: "expression" as const, name: "smile" };
  expect(await subject.playAction(action)).toBe(false);
  expect(warning).toHaveBeenCalledWith("[Firefly] playAction failed", action, failure);
});

test("hides only the table props and restores the external opacity accessor on disposal", async () => {
  const model = avatar();
  const core = model.internalModel.coreModel;
  const originalOpacity = core.getDrawableOpacity;
  const { subject } = await initialize(model);
  const opacity = (id: string) => core.getDrawableOpacity(core.getDrawableIndex(id));
  expect(["ArtMesh153", "ArtMesh154", "ArtMesh155", "ArtMesh156", "ArtMesh157"].map(opacity))
    .toStrictEqual([0, 0, 0, 1, 1]);
  const installedOpacity = core.getDrawableOpacity;
  subject.dispose();
  expect(core.getDrawableOpacity).not.toBe(installedOpacity);
  expect(core.getDrawableOpacity).toBe(originalOpacity);
  expect(opacity("ArtMesh153")).toBe(1);
});

test.each(["ArtMesh211", "ArtMesh23"])("classifies visible character geometry on %s including the exact head boundary", async (id) => {
  const { subject } = await initialize(avatar(id));
  for (const [height, expected] of [[0.2, "Head"], [0, "Head"], [-0.3, "Body"], [-0.43, "Body"],
    [HEAD_MIN_Y, "Head"], [HEAD_MIN_Y - 0.001, "Body"]] as const) {
    expect(subject.hitTestRegions(0, -height)).toStrictEqual([expected]);
  }
  expect(subject.hitTestRegions(500, 500)).toStrictEqual([]);
});

test.each(["ArtMesh153", "ArtMesh154", "ArtMesh155", "ArtMesh156", "ArtMesh157"])(
  "ignores scene geometry even where %s covers the pointer", async (id) => {
    const { subject } = await initialize(avatar(id));
    expect(subject.hitTestRegions(0, -0.2)).toStrictEqual([]);
    expect(subject.hitTestRegions(0, 0.3)).toStrictEqual([]);
  });

test("ignores fully transparent character triangles", async () => {
  const { subject } = await initialize(avatar("ArtMesh211", 0));
  expect(subject.hitTestRegions(0, -0.2)).toStrictEqual([]);
});
