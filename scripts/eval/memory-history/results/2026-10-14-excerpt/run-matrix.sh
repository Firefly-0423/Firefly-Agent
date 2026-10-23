#!/usr/bin/env bash
# 重新生成本目录的全部结果。需要 FIREFLY_MODELS_DIR 指向含 Xenova/bge-m3 与 bge-reranker-base 的 models 目录。
set -euo pipefail
COMMON="--sizes 250 --granularity session --units 2 --long-turns 450 --modes lexical,hybrid,hybrid+prodrecency"
node scripts/eval/memory-history/run.mjs $COMMON --split dev --label dev-excerpt --out scripts/eval/memory-history/results/2026-10-14-excerpt
node scripts/eval/memory-history/run.mjs $COMMON --split holdout --label holdout-excerpt --out scripts/eval/memory-history/results/2026-10-14-excerpt
