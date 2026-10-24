// RAG 的交叉编码器重排模块。当前仅接入 bge-reranker-base，不提供轻量版本。
import * as path from "path";
import {withLocalModelLoad} from "./embedding";
import {createHash} from "node:crypto";
import {createReadStream} from "node:fs";
import { getProjectModelBaseDir } from "./model-status";

// ── 类型 ──
type RerankedDoc = { text: string; score: number };
export type RerankerProvider = {
  name: string;
  rerank(query: string, documents: string[]): Promise<RerankedDoc[]>;
};

// ── 动态 import 包装，与 embedding.ts 的做法保持一致 ──
const importEsm = new Function("moduleName", "return import(moduleName)") as (moduleName: string) => Promise<any>;

// ── 管线缓存 ──
let standardPipeline:{tokenizer:any;model:any}|null=null;
let standardLoad:Promise<{tokenizer:any;model:any}>|undefined;
const localProviders=new WeakSet<object>();
export function isLocalRerankerProvider(value:object):boolean{return localProviders.has(value)}
const RERANKER_REVISION="280bcc27a84e0b898c251e06fddb25171bd9b101";
const PINNED_RERANKER_FILES = {
  "special_tokens_map.json": "d5469a60db23249c7f8945013d78df30b44b6bf686c6bb4740f4223f77b1b535",
  "tokenizer_config.json": "a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b",
  "config.json": "b6575b9d5be20d6747417c8e20c5a0db1636356e0b6d422d7244c628423c4d4c",
  "sentencepiece.bpe.model": "cfc8146abe2a0488e9e2a0c56de7952f7c11ab059eca145a0a727afce0db2865",
  "tokenizer.json": "48564c5c7d3fa64d85d95e65414a542385f88b0f128fd8d4163fd7a57f2be05c",
  "onnx/model_quantized.onnx": "dd98f3e67837d23210a6b7550c08cced4f61845b940ac45be3565840a10f3244"
} as const;
async function verifyPinnedModel(base:string):Promise<void>{
 for(const [file,expected] of Object.entries(PINNED_RERANKER_FILES)){
  const digest=createHash('sha256');for await(const chunk of createReadStream(path.join(base,"bge-reranker-base",file)))digest.update(chunk);
  if(digest.digest('hex')!==expected)throw Error('LOCAL_MODEL_PIN_MISMATCH');
 }
}

async function loadRerankerPipeline(modelDir:string):Promise<{tokenizer:any;model:any}>{
 const {AutoTokenizer,AutoModelForSequenceClassification,env}=await importEsm("@xenova/transformers"),base=getProjectModelBaseDir("reranker","standard");
 if(!base)throw Error("Local reranker model is not installed");await verifyPinnedModel(base);
 env.localModelPath=base;env.allowLocalModels=true;env.allowRemoteModels=false;env.useBrowserCache=false;env.useFSCache=false;env.useCustomCache=false;
 const options={quantized:true,local_files_only:true,revision:RERANKER_REVISION};
 const tokenizer=await AutoTokenizer.from_pretrained(modelDir,options),model=await AutoModelForSequenceClassification.from_pretrained(modelDir,options);return {tokenizer,model};
}
export function decodeRerankerScores(logits:{dims:number[];data:ArrayLike<number>},count:number):number[]{
 if(!Array.isArray(logits.dims)||logits.dims.length!==2||logits.dims[0]!==count||logits.dims[1]!==1||logits.data?.length!==count)throw Error("RERANKER_OUTPUT_INVALID");
 return Array.from(logits.data,x=>{if(!Number.isFinite(x))throw Error("RERANKER_OUTPUT_INVALID");return x>=0?1/(1+Math.exp(-x)):Math.exp(x)/(1+Math.exp(x))});
}

// ── Standard reranker (bge-reranker-base, ~279MB) ──
export async function createStandardReranker(): Promise<RerankerProvider> {
  if (!standardPipeline) {
    standardLoad??=withLocalModelLoad(()=>loadRerankerPipeline("bge-reranker-base"));
    try{standardPipeline=await standardLoad}finally{standardLoad=undefined}
  }

  const pair=standardPipeline;
  const provider:RerankerProvider = {
    name: "bge-reranker-base@"+RERANKER_REVISION+":text-pair-sigmoid-q8-v1",

    async rerank(query: string, documents: string[]): Promise<RerankedDoc[]> {
      if (documents.length === 0) return [];
      if (!standardPipeline) throw new Error("Standard reranker not initialized");

      const startedAt = Date.now();
      // query 对每个文档各配一份，组成 (query, doc) 对后一起送入模型
      const inputs = pair.tokenizer(documents.map(() => query), { text_pair: documents, padding: true, truncation: true });
      const { logits } = await pair.model(inputs);
      const scores = decodeRerankerScores(logits, documents.length);

      const ranked = documents.map((text, i): RerankedDoc => ({ text, score: scores[i] }));
      ranked.sort((a, b) => b.score - a.score);

      console.log(`[Reranker] standard: ${documents.length} docs reranked in ${Date.now() - startedAt}ms`);
      return ranked;
    },
  };
  localProviders.add(provider);return Object.freeze(provider);
}

// ── 重排器运行状态，集中放在一个对象里 ──
const rerankerState: { provider: RerankerProvider | null; mode: "standard" | "none" } = { provider: null, mode: "none" };

function modelOnDisk(): boolean {
  return getProjectModelBaseDir("reranker", "standard") !== null;
}

export function getRerankerInstallStatus(): { standard: boolean } {
  return { standard: modelOnDisk() };
}

export async function initReranker(mode: "standard" | "none"): Promise<void> {
  rerankerState.mode = mode;

  if (mode === "none") {
    rerankerState.provider = null;
    console.log("[Reranker] disabled");
    return;
  }

  // 模型没装时不报错，直接降级为 none
  if (!modelOnDisk()) {
    console.warn(`[Reranker] bge-reranker-base 未找到 (models/bge-reranker-base/onnx/model_quantized.onnx)，自动降级为 none。`);
    rerankerState.mode = "none";
    rerankerState.provider = null;
    return;
  }

  console.log("[Reranker] initializing standard mode (bge-reranker-base)...");
  const provider = await createStandardReranker();
  rerankerState.provider = provider;
  console.log(`[Reranker] standard mode ready: ${provider.name}`);
}

export function getReranker(): RerankerProvider | null {
  return rerankerState.provider;
}

export function getRerankerMode(): "standard" | "none" {
  return rerankerState.mode;
}

export function resetReranker(): void {
  rerankerState.provider = null;
  rerankerState.mode = "none";
  standardPipeline = null;
}
