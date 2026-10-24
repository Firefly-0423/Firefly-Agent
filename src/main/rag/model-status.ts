// 本地模型安装状态探测：为 embedding 与 reranker 提供统一的"是否可用"判断。

import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { app } from "electron";
import { fireflyEnvironment } from "../../shared/firefly-environment";

const HF_CACHE_DIR = path.join(os.homedir(), ".cache", "huggingface", "Xenova");

export interface ModelInstallStatus {
  embedding: { bgem3: boolean };
  reranker: { standard: boolean };
}

// 这几个文件齐全才算安装完成
const REQUIRED_FILES = ["tokenizer.json", "config.json", "onnx/model_quantized.onnx"];

// 各模型在不同根目录下的子路径。注意两类根目录的约定不同：
//  - 项目 models/ 采用 transformers.js 自己拼接的 Xenova 布局，
//    即 models/Xenova/bge-m3/（而不是 models/bge-m3/）；
//  - HF 缓存根目录本身已以 Xenova 结尾，所以子路径只有 bge-m3/。
type SubPathTable = Record<string, string[]>;

const PROJECT_SUB_PATHS: SubPathTable = { "reranker-standard": ["bge-reranker-base"], "embedding-bgem3": ["Xenova/bge-m3"] };

const HF_CACHE_SUB_PATHS: SubPathTable = { "embedding-bgem3": ["bge-m3"] };

interface CandidateCheck {
  modelDir: string;
  /** 该候选目录缺少的必需文件；为空表示完整 */
  missingFiles: string[];
}

const modelIdOf = (kind: "embedding" | "reranker"): string =>
  kind === "embedding" ? "embedding-bgem3" : "reranker-standard";

/** 检查某个根目录下某模型的所有候选子目录。 */
function probeCandidates(modelId: string, baseDir: string, subPathsLookup: SubPathTable): { installed: boolean; candidates: CandidateCheck[] } {
  const candidates = (subPathsLookup[modelId] ?? []).map((sub): CandidateCheck => {
    const modelDir = path.join(baseDir, sub);
    return { modelDir, missingFiles: REQUIRED_FILES.filter((f) => !fs.existsSync(path.join(modelDir, f))) };
  });
  return { installed: candidates.some((c) => c.missingFiles.length === 0), candidates };
}

/**
 * 按优先级列出可能存放 models 的根目录（去重）：
 *   1. 环境变量 FIREFLY_MODELS_DIR（显式覆盖）
 *   2. 当前工作目录下的 models
 *   3. 可执行文件旁的 models（发布版用户把模型放这里）
 *   4. app.getAppPath() 下的 models（开发兜底）
 *   5. process.resourcesPath 下的 models（打包资源兜底）
 */
export function getProjectModelsDirCandidates(): string[] {
  const dirs: string[] = [];
  const add = (dir: string) => {
    if (!dirs.includes(dir)) dirs.push(dir);
  };

  const override = fireflyEnvironment(process.env, "FIREFLY_MODELS_DIR");
  if (override) dirs.push(override);
  add(path.join(process.cwd(), "models"));
  add(path.join(path.dirname(process.execPath), "models"));
  try {
    add(path.join(app.getAppPath(), "models"));
  } catch {
    // app 尚未就绪，跳过
  }
  if (process.resourcesPath) add(path.join(process.resourcesPath, "models"));
  return dirs;
}

/** 优先级最高的 models 目录。 */
export function getProjectModelsDir(): string {
  return getProjectModelsDirCandidates()[0];
}

/**
 * 找到包含完整本地模型的根目录。与设置页的状态探测用同一套逻辑，
 * 所以界面显示"已安装"时运行时一定能找到。
 */
export function getProjectModelBaseDir(kind: "embedding" | "reranker", modelKey: string): string | null {
  const modelId = modelIdOf(kind);
  const hit = getProjectModelsDirCandidates().find(
    (baseDir) => probeCandidates(modelId, baseDir, PROJECT_SUB_PATHS).installed,
  );
  return hit ?? null;
}

/**
 * 单个模型的详细诊断，用于排查"检测不到模型"。
 *
 * - 只要某个根目录下存在候选子目录（哪怕不完整）就算项目侧目录存在；
 * - 项目侧目录存在但不完整时不再回退到 HF 缓存，避免掩盖真实问题；
 * - 只有项目侧完全没有目录时才尝试 HF 缓存。
 */
export interface ModelStatusDetail {
  modelId: string;
  installed: boolean;
  /** 命中的来源；未安装时为 null */
  source: "project" | "hf-cache" | null;
  matchedAt: string | null;
  /** 项目侧第一个真实存在的候选目录（不论完整与否） */
  existingProjectDir: string | null;
  modelDirCandidates: string[];
  subPathCandidates: string[];
  requiredFiles: string[];
  /** 项目侧目录不完整时缺的文件 */
  missingFiles: string[];
}

export function getModelInstallStatusDetail(kind: "embedding" | "reranker", modelKey: string): ModelStatusDetail {
  const modelId = modelIdOf(kind);
  const subPathCandidates = PROJECT_SUB_PATHS[modelId] ?? [];
  const modelDirCandidates = getProjectModelsDirCandidates();

  const detail = (
    installed: boolean,
    source: ModelStatusDetail["source"],
    matchedAt: string | null,
    existingProjectDir: string | null,
    missingFiles: string[],
  ): ModelStatusDetail => ({
    modelId,
    installed,
    source,
    matchedAt,
    existingProjectDir,
    modelDirCandidates,
    subPathCandidates,
    requiredFiles: REQUIRED_FILES,
    missingFiles,
  });

  // 展开所有 (根目录, 子路径) 组合，只保留磁盘上真实存在的
  const present: CandidateCheck[] = [];
  for (const baseDir of modelDirCandidates) {
    for (const c of probeCandidates(modelId, baseDir, PROJECT_SUB_PATHS).candidates) {
      if (fs.existsSync(c.modelDir)) present.push(c);
    }
  }

  const complete = present.find((c) => c.missingFiles.length === 0);
  if (complete) return detail(true, "project", complete.modelDir, complete.modelDir, []);

  // 项目侧有目录但不完整：明确报缺失，不回退
  if (present.length > 0) return detail(false, null, null, present[0].modelDir, present[0].missingFiles);

  const cacheHit = probeCandidates(modelId, HF_CACHE_DIR, HF_CACHE_SUB_PATHS)
    .candidates.find((c) => c.missingFiles.length === 0);
  if (cacheHit) return detail(true, "hf-cache", cacheHit.modelDir, null, []);

  return detail(false, null, null, null, []);
}

export function getModelInstallStatus(): ModelInstallStatus {
  return {
    embedding: { bgem3: getModelInstallStatusDetail("embedding", "bgem3").installed },
    reranker: { standard: getModelInstallStatusDetail("reranker", "standard").installed },
  };
}

export function checkEmbeddingModelInstalled(modelKey: string): boolean {
  return getModelInstallStatusDetail("embedding", modelKey).installed;
}

export function checkRerankerModelInstalled(): boolean {
  return getModelInstallStatusDetail("reranker", "standard").installed;
}
