#!/bin/bash
# 检索修复第一步（词法按窗口、向量保持文档级、生产代码里的新近度）的留存运行。
# 从仓库根目录执行；需要 FIREFLY_MODELS_DIR 指向含 Xenova/bge-m3 与 bge-reranker-base 的 models 目录。
# 纪律：dev 用来选参数；holdout 只跑冻结配置（--units 2、recency-alpha 0.1、半衰期 30 天）。
cd "$(git rev-parse --show-toplevel)"
R=scripts/eval/memory-history/results/2026-10-13-stage-a
run() { label=$1; shift; timeout 2400 node scripts/eval/memory-history/run.mjs --out $R --label $label --granularity session "$@" 2>&1 | grep -v "^\[" > $R/$label.md; }
M=lexical,hybrid,hybrid+prodrecency
run dev-units2 --split dev --sizes 250,512 --units 2 --modes $M,hybrid+rerank8 --recency-alpha 0.1
run dev-units1 --split dev --sizes 250 --units 1 --modes $M --recency-alpha 0.1
run dev-units4 --split dev --sizes 250 --units 4 --modes $M --recency-alpha 0.1
for a in 0.05 0.2; do run dev-units2-alpha-$a --split dev --sizes 250 --units 2 --modes hybrid+prodrecency --recency-alpha $a; done
run holdout-units2 --split holdout --sizes 250,512 --units 2 --modes $M,hybrid+rerank8 --recency-alpha 0.1
