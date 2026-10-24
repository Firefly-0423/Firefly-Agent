# Isolated H synthetic evaluation

Product baseline: `0f90f6ef27f5cd771bbd7378cda75a2bf563c898`. This is an evaluation spike; no Main entrypoint, provider activation, real migration, CI/dependency change or credentials. Run from the owned private E: clone only.

```powershell
$env:TEMP='E:\Codex\2026-10-01\task'
$env:TMP=$env:TEMP
$env:TMPDIR=$env:TEMP
$env:npm_config_cache='E:\Codex\2026-10-01\task\npm-cache'
$env:PYTHONUTF8='1'
$env:PYTHONDONTWRITEBYTECODE='1'
python scripts/verify/memory-history/quality-corpus.py
node node_modules/typescript/bin/tsc -p scripts/verify/memory-history/quality-tsconfig.json
node node_modules/esbuild/bin/esbuild scripts/verify/memory-history/quality-run.ts --bundle --platform=node --packages=external --outfile=output/memory-h-quality/quality-run.cjs
node output/memory-h-quality/quality-run.cjs
node node_modules/esbuild/bin/esbuild scripts/verify/memory-history/quality-repository.ts --bundle --platform=node --packages=external --outfile=output/memory-h-quality/quality-repository.cjs
node output/memory-h-quality/quality-repository.cjs
node node_modules/esbuild/bin/esbuild scripts/verify/memory-history/quality-safety.ts --bundle --platform=node --packages=external --outfile=output/memory-h-quality/quality-safety.cjs
node output/memory-h-quality/quality-safety.cjs
node node_modules/esbuild/bin/esbuild scripts/verify/memory-history/quality-provider-offline.ts --bundle --platform=node --packages=external --outfile=output/memory-h-quality/quality-provider-offline.cjs
node output/memory-h-quality/quality-provider-offline.cjs
```

The corpus authoring script refuses changes to existing frozen files. Freeze version/hash before any scoring; a changed benchmark needs a new version. 8 development cases and32 disjoint holdout cases are manually labelled by one author; no retriever/dictionary/parameter tuning. This is a small synthetic diagnostic, not representative production quality or independent human annotation. Same evaluation taxonomy intentionally occurs across splits. Never tune this holdout after seeing results and then claim untouched final accuracy.

`quality-run` tests the isolated ranking function with id/text only, validates six hand-computed oracles, corpus hashes and exact text disjointness. It bypasses repository admission and its textual tool-role prefixes differ from real message flattening. `quality-repository` is the additional fidelity correction after observing that limitation, not a fresh untouched evaluation. It uses unchanged qrels through actual repository parser/index/ranker/excerpt with structured tool pairing and a fixed public synthetic key for reproducible partition-ID ties; rejected secret-word documents remain in reported labels/denominator. It calls the synthetic-import repository command in-process, not Main/worker process. Main authorization/evidence/forget safety is exercised separately in `quality-safety` with owned synthetic profiles and explicit structural limitations.

Recall is over positive-grade equivalence groups; grade3 answers and grade1 contextual evidence both count. nDCG uses exponential gains and zeros repeated-group gain at the original rank; duplicateRate counts repeated authored groups among returned hits, including variants beyond exact term-set duplication. Repeated groups consume rank positions. Macro average weights cases equally. Do not describe Recall@3 as answer correctness; report top1 grade3 and conflict exposure separately. Empty answers have zero quality rather than being excluded.

Provider probe is pure serialization, never calls fetch/SDK. It uses an invalid synthetic string only to satisfy the serializer contract; neither saved nor configured credentials. Native DeepSeek cache-hit/miss fields are not mapped by current normalized usage. It demonstrates a cap-stripping runtime setting is rejected by its diagnostic guard; it does not install an online guard. Online remains blocked until an existing secret-safe invocation boundary and actual non-sensitive endpoint/model are established. Only user's DeepSeek Flash, RMB5 total, no new/extracted/copied/configured credentials; see output/memory-h-quality/ONLINE-PLAN.md for a two-attempt full-context worst-case reservation, not expected-token budget.
