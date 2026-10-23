#!/bin/bash
# 2026-10-13 留存运行矩阵。从仓库根目录执行：bash scripts/eval/memory-history/results/2026-10-13/run-matrix.sh
# 纪律：dev 用来看结果、选参数；holdout 只跑冻结配置（recency-alpha 0.1、半衰期 30 天）与基线，不据此改任何参数。
cd "$(git rev-parse --show-toplevel)"
R=scripts/eval/memory-history/results/2026-10-13
run() { label=$1; shift; timeout 2400 node scripts/eval/memory-history/run.mjs --out $R --label $label "$@" 2>&1 | grep -v "^\[" > $R/$label.md; }

FAST=lexical,lexical+stop,hybrid,hybrid+stop,hybrid+rerank8,hybrid+recency,hybrid+stop+recency,lexical+recency
# --- dev：整段 vs 窗口，两种规模 ---
run dev-session --split dev --sizes 250,512 --granularity session --modes $FAST --recency-alpha 0.1
run dev-window  --split dev --sizes 250,512 --granularity window  --modes $FAST,hybrid+rerank30,lexical+rerank30,hybrid+rangefilter --recency-alpha 0.1
# --- dev：新近度力度扫描（规模 250，窗口） ---
for a in 0.03 0.05 0.1 0.2 0.3; do
  run dev-window-alpha-$a --split dev --sizes 250 --granularity window --modes lexical+recency,hybrid+recency,hybrid+stop+recency --recency-alpha $a
done
# --- dev：半衰期敏感性（α=0.1） ---
for h in 14 90; do
  run dev-window-halflife-$h --split dev --sizes 250 --granularity window --modes hybrid+recency,hybrid+stop+recency --recency-alpha 0.1 --recency-halflife $h
done
# --- holdout：冻结配置 ---
run holdout-session --split holdout --sizes 250,512 --granularity session --modes lexical,hybrid,hybrid+rerank8,hybrid+stop+recency --recency-alpha 0.1
run holdout-window  --split holdout --sizes 250,512 --granularity window  --modes lexical,hybrid,hybrid+stop,hybrid+recency,hybrid+stop+recency,lexical+recency,hybrid+rerank8 --recency-alpha 0.1
true
