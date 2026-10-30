// Prints a DRAFT static review entry for one market Skill at one commit, for src/main/skills/external-reviews.ts.
// It only computes what Main will check (file hashes, the canonical content digest, license evidence and, for Firefly's
// own source, the Firefly metadata). It approves nothing: the reviewer reads every file, decides, and records the
// rationale in THIRD_PARTY_SKILL_REVIEWS.md before the entry ships.
//
// Usage: node scripts/security/external-skill-review-draft.mjs <local clone> <commit> <skill path> [source]
//   e.g. node scripts/security/external-skill-review-draft.mjs ../firefly-skills 81e0bb6... skills/diagram firefly
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { load } from "js-yaml";

const POLICIES = { firefly: "firefly-native-v1", openai: "firefly-instruction-only-v1", anthropic: "firefly-instruction-only-v1" };
const LICENSE = /^(?:LICENSE|LICENCE|COPYING)(?:\.md|\.txt)?$/i;
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

/** Same canonical digest as Main's digestExternalFiles: sorted [path, sha256, bytes] tuples as compact UTF-8 JSON. */
export function contentDigest(files) {
  return sha256(Buffer.from(JSON.stringify([...files]
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
    .map(file => [file.path, file.sha256, file.bytes])), "utf8"));
}

/** A best-effort SPDX guess from the license text; the reviewer confirms it. */
function spdxOf(text) {
  if (/^\s*MIT License/i.test(text)) return "MIT";
  if (/Apache License[\s\S]*Version 2\.0/i.test(text)) return "Apache-2.0";
  if (/^\s*ISC License/i.test(text)) return "ISC";
  return null;
}

/** Firefly metadata as the Skill declares it (modes, effectKind, tools); Main re-checks it against the review. */
function fireflyNative(skillText) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skillText);
  const data = match ? load(match[1]) ?? {} : {};
  return Object.fromEntries(["modes", "effectKind", "tools"].filter(key => data[key] !== undefined).map(key => [key, data[key]]));
}

/** `payload` maps repository-relative paths to bytes; `blobs` maps the same paths to their Git blob SHA-1. */
export function draftReview({ sourceId, commit, path, payload, blobs, reviewedAt = new Date().toISOString() }) {
  if (!Object.hasOwn(POLICIES, sourceId)) throw new Error(`Unknown source: ${sourceId}`);
  const files = [...payload].map(([file, bytes]) => ({ path: file, blobSha1: blobs.get(file), sha256: sha256(bytes), bytes: bytes.length }));
  const licenses = files.filter(file => file.path.split("/").length === path.split("/").length + 1 && LICENSE.test(file.path.split("/").at(-1)))
    .map(file => ({ path: file.path, sha256: file.sha256, spdx: spdxOf(payload.get(file.path).toString("utf8")), covers: files.map(entry => entry.path).sort() }));
  const skill = payload.get(path + "/SKILL.md");
  return {
    policyVersion: POLICIES[sourceId], sourceId, commit, path, contentSha256: contentDigest(files), licenses,
    // Left empty on purpose: Main rejects an entry with no reviewer, so an unedited draft can never approve anything.
    compatibility: "instruction-only", reviewedAt, reviewer: "",
    ...(sourceId === "firefly" ? { native: skill ? fireflyNative(skill.toString("utf8")) : {} } : {}),
  };
}

function main([repository, commit, path, sourceId = "firefly"]) {
  if (!repository || !/^[0-9a-f]{40}$/.test(commit ?? "") || !path) {
    console.error("Usage: node scripts/security/external-skill-review-draft.mjs <local clone> <40-hex commit> <skill path> [source]");
    process.exit(2);
  }
  const git = (...args) => execFileSync("git", ["-C", repository, ...args], { maxBuffer: 64 * 1024 * 1024 });
  const payload = new Map(), blobs = new Map();
  for (const line of git("ls-tree", "-r", "--long", "-z", commit, "--", path).toString("utf8").split("\0").filter(Boolean)) {
    const [meta, file] = line.split("\t"), [mode, type, blob] = meta.split(/\s+/);
    if (type !== "blob" || mode !== "100644") throw new Error(`Not an ordinary file (${mode} ${type}): ${file}. Main blocks this Skill.`);
    payload.set(file, git("cat-file", "blob", blob)); blobs.set(file, blob);
  }
  if (!payload.has(path + "/SKILL.md")) throw new Error(`No SKILL.md under ${path} at ${commit}.`);
  console.error("DRAFT ONLY: read every file, then fill in `reviewer` and add the rationale to THIRD_PARTY_SKILL_REVIEWS.md. An entry with an empty reviewer approves nothing.");
  console.log(JSON.stringify(draftReview({ sourceId, commit, path, payload, blobs }), null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
