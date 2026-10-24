import { Live2DModel, MotionPriority } from "pixi-live2d-display/cubism4";
import * as PIXI from "pixi.js";
import type { Live2DTarget } from "../../shared/live2d-actions";
import type { HitAreaDef } from "./interaction";
import { buildMotionIndexMap } from "./model-manifest";
import {
  canvasToModelPoint, NON_BODY_DRAWABLE_IDS, installHiddenDrawableGuard,
  resolveFireflyHitRegions, pointInTriangle,
  type CanvasModelSpace, type FireflyCoreModel, type HitRegionDrawable,
} from "./model-regions";
export type { HitAreaDef } from "./interaction";

export interface Live2DManagerOptions {
  onError?: (err: Error) => void;
  onLoad?: () => void;
  modelPath: string;
  height: number;
  width: number;
  canvas: HTMLCanvasElement;
}
export interface Live2DResourceMetrics {
  drawingBufferHeight: number | null;
  drawingBufferWidth: number | null;
  rendererType: "webgl" | "unknown" | null;
  textureCacheSize: number | null;
  stageChildren: number | null;
  tickerStarted: boolean | null;
  disposed: boolean;
  modelLoaded: boolean;
  appActive: boolean;
}
interface MotionEntry {
  [key: string]: unknown;
  Expression?: string;
  File?: string;
  Name?: string;
}
interface ModelJsonShape {
  FileReferences?: {
    Expressions?: Array<{ Name: string; File: string }>;
    Motions?: Record<string, MotionEntry[]>;
  };
  HitAreas?: { Name?: string; Id?: string }[];
}
function buildHitAreaDefs(manifest: ModelJsonShape): HitAreaDef[] {
  const regions: HitAreaDef[] = [];
  for (const region of manifest.HitAreas ?? []) {
    const regionName = region.Name;
    const drawableId = region.Id;
    if (regionName && drawableId) regions.push({ name: regionName, id: drawableId });
  }
  return regions;
}
type PixiCaches = { TextureCache?: Record<string, unknown>; BaseTextureCache?: Record<string, unknown> };

export class Live2DManager {
  private app: PIXI.Application | null = null;
  private model: Live2DModel | null = null;
  private undoVisibility: (() => void) | null = null;
  private hitAreas: HitAreaDef[] = [];
  private motionIndexMap = new Map<string, Map<string, number>>();
  private expressionNames = new Set<string>();
  private options: Live2DManagerOptions;
  private disposed = false;
  private loading: Promise<void> | null = null;
  private fitScale = 1;
  private magnification = 1;

  constructor(options: Live2DManagerOptions) { this.options = options; }

  async init(): Promise<void> {
    if (this.disposed) return;
    if (this.loading) return this.loading;
    this.loading = this.initialize();
    try { await this.loading; }
    finally { this.loading = null; }
  }
  private async initialize(): Promise<void> {
    const configuration = this.options;
    this.app = new PIXI.Application({
      view: configuration.canvas,
      width: configuration.width,
      height: configuration.height,
      transparent: true,
      backgroundAlpha: 0,
      antialias: true,
      preserveDrawingBuffer: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      autoDensity: true,
    });
    this.app.ticker.maxFPS = 60;
    try { await this.loadModel(); }
    catch (failure) {
      this.options.onError?.(failure instanceof Error ? failure : new Error(String(failure)));
      if (this.app !== null) {
        this.app.destroy(false, { children: true, texture: true });
        this.app = null;
      }
    }
  }
  private async loadModel(): Promise<void> {
    const location = this.options.modelPath;
    const avatarRequest = Live2DModel.from(location, {
      ticker: this.app!.ticker,
      autoHitTest: false,
      autoFocus: false,
    });
    const manifestRequest = fetch(location).then((response) => {
      if (!response.ok) throw new Error("Failed to fetch " + location + ": " + response.status);
      return response.json() as Promise<ModelJsonShape>;
    });
    let avatar: Live2DModel;
    let manifest: ModelJsonShape;
    try { [avatar, manifest] = await Promise.all([avatarRequest, manifestRequest]); }
    catch (failure) {
      const orphan = await avatarRequest.catch(() => null);
      orphan?.destroy();
      throw failure;
    }
    if (!this.app || this.disposed) { avatar.destroy(); return; }
    this.undoVisibility?.();
    this.undoVisibility = null;
    const parameters = avatar.internalModel.coreModel as unknown as Partial<FireflyCoreModel>;
    if (typeof parameters?.getDrawableIndex === "function" && typeof parameters.getDrawableOpacity === "function") {
      this.undoVisibility = installHiddenDrawableGuard(parameters as FireflyCoreModel);
    }
    this.model = avatar;
    this.hitAreas = buildHitAreaDefs(manifest);
    this.motionIndexMap = buildMotionIndexMap(manifest);
    this.expressionNames = new Set(manifest.FileReferences?.Expressions?.map((expression) => expression.Name) ?? []);
    this.app.stage.addChild(this.model);
    this.model.anchor.set(0.5, 0.5);
    const horizontalFit = 400 / this.model.width;
    const verticalFit = 500 / this.model.height;
    this.fitScale = Math.min(horizontalFit, verticalFit, 1.0);
    this.applyZoom(this.magnification);
    this.options.onLoad?.();
  }
  applyZoom(zoom: number): void {
    this.magnification = zoom;
    if (this.model === null) return;
    this.model.scale.set(this.fitScale * zoom);
    this.resize(window.innerWidth, window.innerHeight);
  }
  getModel(): Live2DModel | null { return this.model; }
  getHitAreaDefs(): HitAreaDef[] { return this.hitAreas; }
  getGL(): WebGL2RenderingContext | null {
    const backend = this.app?.renderer;
    if (backend instanceof PIXI.Renderer) return backend.gl;
    return null;
  }
  hitTestRegions(x: number, y: number): string[] {
    const avatar = this.model;
    if (!avatar) return [];
    const engine = avatar.internalModel;
    const parameters = engine.coreModel as unknown as FireflyCoreModel;
    const location = new PIXI.Point(x, y);
    avatar.toModelPosition(location, location);
    const modelPoint = canvasToModelPoint(location.x, location.y, engine as unknown as CanvasModelSpace);
    const meshes: HitRegionDrawable[] = engine.getDrawableIDs().map((drawableId, ordinal) => ({
      index: ordinal,
      id: drawableId,
      opacity: parameters.getDrawableOpacity(ordinal),
    }));
    return resolveFireflyHitRegions({
      drawables: meshes,
      excludedDrawableIds: NON_BODY_DRAWABLE_IDS,
      isPointInDrawable: (ordinal) => this.drawableContainsPoint(parameters, ordinal, modelPoint.x, modelPoint.y),
      pointModelY: modelPoint.y,
    });
  }
  private drawableContainsPoint(core: FireflyCoreModel, index: number, mx: number, my: number): boolean {
    const coordinates = core.getDrawableVertices(index);
    const indices = core.getDrawableVertexIndices(index);
    for (let offset = 0; offset + 2 < indices.length; offset += 3) {
      const first = indices[offset] * 2;
      const second = indices[offset + 1] * 2;
      const third = indices[offset + 2] * 2;
      if (pointInTriangle(mx, my, coordinates[first], coordinates[first + 1], coordinates[second], coordinates[second + 1], coordinates[third], coordinates[third + 1])) return true;
    }
    return false;
  }
  hasAction(target: Live2DTarget): boolean {
    if (this.model === null) return false;
    if (target.kind === "motion") return this.motionIndexMap.get(target.group)?.has(target.motionName) === true;
    return this.expressionNames.has(target.name);
  }
  getResourceMetrics(): Live2DResourceMetrics {
    const context = this.getGL();
    const cache = (PIXI as unknown as { utils?: PixiCaches }).utils?.TextureCache;
    return {
      appActive: this.app !== null,
      modelLoaded: this.model !== null,
      disposed: this.disposed,
      tickerStarted: this.app ? Boolean((this.app.ticker as unknown as { started?: boolean }).started) : null,
      stageChildren: this.app ? ((this.app.stage as unknown as { children?: unknown[] }).children?.length ?? null) : null,
      textureCacheSize: cache ? Object.keys(cache).length : null,
      rendererType: context ? "webgl" : this.app ? "unknown" : null,
      drawingBufferWidth: context?.drawingBufferWidth ?? null,
      drawingBufferHeight: context?.drawingBufferHeight ?? null,
    };
  }
  async playAction(target: Live2DTarget): Promise<boolean> {
    if (!this.model || !this.hasAction(target)) return false;
    try {
      switch (target.kind) {
        case "motion": {
          const group = this.motionIndexMap.get(target.group);
          const ordinal = group?.get(target.motionName);
          if (typeof ordinal !== "number") return false;
          return await this.model.motion(target.group, ordinal, MotionPriority.NORMAL);
        }
        default:
          if (!this.expressionNames.has(target.name)) return false;
          return await this.model.expression(target.name);
      }
    } catch (failure) {
      console.warn("[Firefly] playAction failed", target, failure);
      return false;
    }
  }
  resize(width: number, height: number): void {
    if (this.app === null) return;
    this.app.renderer.resize(width, height);
    if (this.model !== null) {
      this.model.x = width / 2;
      this.model.y = height / 2;
    }
  }
  pause(): void { if (this.app) this.app.ticker.stop(); }
  resume(): void {
    if (this.app === null) return;
    this.app.render();
    this.app.ticker.start();
  }
  dispose(): void {
    this.disposed = true;
    this.undoVisibility?.();
    this.undoVisibility = null;
    if (this.model !== null) {
      this.model.destroy();
      this.model = null;
    }
    this.hitAreas = [];
    this.motionIndexMap.clear();
    this.expressionNames.clear();
    if (this.app !== null) {
      this.app.destroy(false, { children: true, texture: true, baseTexture: true });
      this.app = null;
    }
    const caches = (PIXI as unknown as { utils?: PixiCaches }).utils;
    if (caches?.TextureCache) {
      Object.keys(caches.TextureCache).forEach((key) => { delete caches.TextureCache![key]; });
    }
    if (caches?.BaseTextureCache) {
      Object.keys(caches.BaseTextureCache).forEach((key) => { delete caches.BaseTextureCache![key]; });
    }
  }
}
