import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import type { ExternalSkill, ExternalSkillErrorCode, ExternalSkillFile, LicenseEvidence, ExternalDependencyIssue } from "../../shared/external-skills";
import type { ExternalSkillReview } from "./external-types";
import { validateExternalPath } from "./external-fetch";
import { EXTERNAL_LIMITS, EXTERNAL_SOURCES, EXTERNAL_REVIEW_POLICY_VERSION, externalSkillId, isAllowedExternalLicense } from "./external-policy";
import { parseSkillMatter } from "./skill-frontmatter";

const SHA256 = /^[a-f0-9]{64}$/, SHA1 = /^[a-f0-9]{40}$/;
const licenseName = /^(?:LICENSE|LICENCE|COPYING)(?:\.md|\.txt)?$/i;
const noticeName = /^(?:NOTICE|COPYRIGHT)(?:\.md|\.txt)?$/i;
const plainObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const validPath = (value: unknown): value is string => {
  try { validateExternalPath(value); return true; } catch { return false; }
};

/** Canonical digest: UTF-8 JSON of sorted [repository-relative path, SHA-256, decoded bytes] tuples. */
export function digestExternalFiles(files: readonly ExternalSkillFile[]): string {
  return createHash("sha256").update(JSON.stringify([...files]
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
    .map(file => [file.path, file.sha256, file.bytes])), "utf8").digest("hex");
}

function licenseSchema(license: unknown): boolean {
  return plainObject(license) && validPath(license.path) && typeof license.sha256 === "string" && SHA256.test(license.sha256) &&
    (license.spdx === null || typeof license.spdx === "string") && Array.isArray(license.covers) && license.covers.length > 0 &&
    license.covers.length <= EXTERNAL_LIMITS.files && license.covers.every(validPath);
}

export function isExternalSkillReview(value: unknown): value is ExternalSkillReview {
  if (!plainObject(value) || value.policyVersion !== EXTERNAL_REVIEW_POLICY_VERSION || (value.sourceId !== "openai" && value.sourceId !== "anthropic") ||
      typeof value.commit !== "string" || !SHA1.test(value.commit) || !validPath(value.path) ||
      typeof value.contentSha256 !== "string" || !SHA256.test(value.contentSha256) || value.compatibility !== "instruction-only" ||
      typeof value.reviewer !== "string" || !value.reviewer.trim() || value.reviewer.length > 200 || /[\x00-\x1f\x7f]/.test(value.reviewer) ||
      typeof value.reviewedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value.reviewedAt) ||
      !Number.isFinite(Date.parse(value.reviewedAt)) || new Date(value.reviewedAt).toISOString() !== value.reviewedAt.replace(/Z$/, value.reviewedAt.includes(".") ? "Z" : ".000Z") ||
      !Array.isArray(value.licenses) || !value.licenses.length || value.licenses.length > EXTERNAL_LIMITS.files) return false;
  return value.licenses.every(licenseSchema);
}

/** A label is not license text. Applicability is decided by the static reviewer, never inferred here. */
function licenseTermsPresent(text: string, spdx: string): boolean {
  const normalized = text.replace(/\s+/g, " ").toLowerCase();
  if (spdx === "MIT") return normalized.includes("permission is hereby granted, free of charge") &&
    normalized.includes("the above copyright notice and this permission notice shall be included") &&
    normalized.includes('the software is provided "as is"') && normalized.includes("in no event shall");
  if (spdx === "Apache-2.0") return normalized.includes("apache license") && normalized.includes("version 2.0") &&
    ["1. definitions", "2. grant of copyright license", "3. grant of patent license", "4. redistribution", "5. submission of contributions", "6. trademarks", "7. disclaimer of warranty", "8. limitation of liability", "9. accepting warranty or additional liability"].every(term => normalized.includes(term));
  if (spdx === "ISC") return normalized.includes("permission to use, copy, modify, and/or distribute") &&
    normalized.includes("with or without fee") && normalized.includes("copyright notice") && normalized.includes("permission notice") &&
    normalized.includes('the software is provided "as is"') && normalized.includes("in no event shall");
  if (spdx === "BSD-2-Clause" || spdx === "BSD-3-Clause") {
    const base = normalized.includes("redistribution and use in source and binary forms") && normalized.includes("redistributions of source code must retain") &&
      normalized.includes("redistributions in binary form must reproduce") && normalized.includes('"as is"') && normalized.includes("in no event shall");
    const endorsement = normalized.includes("neither the name") && normalized.includes("endorse or promote");
    return base && (spdx === "BSD-3-Clause" ? endorsement : !endorsement);
  }
  return false;
}

function supportedFile(path: string, root: string): boolean {
  if (!path.startsWith(root + "/")) return false;
  const relative = path.slice(root.length + 1), parts = relative.split("/");
  return (parts.length === 1 && (relative === "SKILL.md" || licenseName.test(relative) || noticeName.test(relative))) ||
    (parts.length === 2 && parts[0] === "references" && /\.(?:md|txt)$/i.test(parts[1]));
}

/** Conservative structural checks supplement (and never replace) the complete manual static review. */
function instructionIssue(text: string, root: string, paths: ReadonlySet<string>): Pick<ExternalDependencyIssue, "kind" | "component"> | undefined {
  let matter: ReturnType<typeof parseSkillMatter>;
  try { matter = parseSkillMatter(text); } catch { return { kind: "frontmatter" }; }
  // No host-only flags are silently removed or rewritten for a different execution engine.
  const unsupported = Object.keys(matter.data).find(key => !["name", "description", "license", "version", "metadata"].includes(key));
  if (unsupported) return { kind: "frontmatter", component: /^[a-z-]{1,50}$/i.test(unsupported) ? unsupported : "unsupported-field" };
  for (const line of matter.content.split(/\r?\n|[.!?;]\s+/)) {
    const mandatory = /\b(?:must|requires?|required|needs?|always)\b/i.test(line) && !/\b(?:no|not) [^.]*required\b/i.test(line);
    const optional = !mandatory && /\boptional\b|\bif (?:[^.]* )?(?:available|supported|supports|present)\b|\b(?:no|not) [^.]*required\b/i.test(line);
    if (optional) continue;
    if (/\b(?:fetch|download|retrieve|read|load)\b[^\n]*https?:\/\//i.test(line)) return { kind: "instruction", component: "remote-resource" };
    if (/\b(?:requires?|required|must|needs?|invoke|use)\b[^\n]*\b(?:tool|mcp|connector|app|hooks?|library|runtime|external api|another skill|[a-z0-9-]+ skill)\b/i.test(line)) return { kind: "instruction", component: "tool-or-runtime" };
    if (/\b(?:via|using)\s+[a-z][\w.-]*'s\s+(?:\w+\s+)?(?:class|library|module|api)\b/i.test(line)) return { kind: "instruction", component: "library" };
    if (/\b(?:run|execute|install)\b[^\n]*(?:scripts?\/|\.(?:sh|py|js|ts|ps1|bat)\b|\bnpm\b|\bpip\b|\bdependencies\b)/i.test(line)) return { kind: "instruction", component: "script" };
    if (/\b(?:read|load|use|invoke)\b[^\n]*(?:\.\.\/|\/SKILL\.md\b)/i.test(line)) return { kind: "instruction", component: "cross-skill" };
  }
  // Every referenced attachment must already be in the supported complete payload. No path expansion.
  for (const match of matter.content.matchAll(/\breferences\/[^\s\)\]"'<>`,;]+/g)) {
    const relative = match[0].replace(/[.!]+$/, "");
    if (!validPath(relative) || !paths.has(root + "/" + relative)) return { kind: "instruction", component: "local-reference" };
  }
  for (const match of matter.content.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1].trim().split(/\s/)[0];
    if (/^(?:https?:\/\/|#)/i.test(target)) continue;
    if (!validPath(target) || !paths.has(root + "/" + target)) return { kind: "instruction", component: "local-reference" };
  }
  return undefined;
}

/** Pure fail-closed eligibility. Files are retained in full; nothing is stripped, normalized, installed or run. */
export function evaluateExternalSkill(skill: ExternalSkill, files: ReadonlyMap<string, Buffer>, reviews: readonly ExternalSkillReview[]): ExternalSkill {
  const blockers = new Set<ExternalSkillErrorCode>(skill.blockers.filter(code => code !== "REVIEW_REQUIRED"));
  const issues: ExternalDependencyIssue[] = [...(skill.dependencyIssues ?? [])].slice(0, EXTERNAL_LIMITS.files);
  const deny = (code: ExternalSkillErrorCode) => { blockers.add(code); };
  const incompatible = (issue: ExternalDependencyIssue) => {
    deny("DEPENDENCY_BLOCKED");
    if (issues.length < EXTERNAL_LIMITS.files && !issues.some(item => item.kind === issue.kind && item.path === issue.path && item.component === issue.component)) issues.push(issue);
  };
  const result = (licenses: LicenseEvidence[] = []) => ({ ...skill, files: skill.files.map(file => ({ ...file })),
    licenses: licenses.map(license => ({ ...license, covers: [...license.covers] })),
    review: blockers.size === 0 ? "approved" as const : blockers.size === 1 && blockers.has("REVIEW_REQUIRED") ? "unreviewed" as const : "blocked" as const,
    dependencyIssues: issues.map(issue => ({ ...issue })), blockers: [...blockers] });
  if (issues.length) deny("DEPENDENCY_BLOCKED");
  if (!Object.hasOwn(EXTERNAL_SOURCES, skill.sourceId) || skill.repository !== EXTERNAL_SOURCES[skill.sourceId]?.repository) deny("SOURCE_INVALID");
  if (!validPath(skill.path) || skill.id !== externalSkillId(skill.sourceId, skill.repository, skill.path)) deny("PATH_INVALID");
  if (!SHA1.test(skill.commit)) deny("REVIEW_REQUIRED");
  if (skill.files.length > EXTERNAL_LIMITS.files || files.size > EXTERNAL_LIMITS.files) deny("LIMIT_EXCEEDED");
  const paths = new Set<string>(), folded = new Set<string>(), texts = new Map<string, string>();
  let total = 0;
  if (files.size !== skill.files.length) deny("DIGEST_MISMATCH");
  for (const file of skill.files) {
    if (!validPath(file.path)) { deny("PATH_INVALID"); continue; }
    if (folded.has(file.path.toLowerCase())) deny("PATH_INVALID");
    folded.add(file.path.toLowerCase()); paths.add(file.path);
    if (!supportedFile(file.path, skill.path)) incompatible({ kind: "file", path: file.path });
    const bytes = files.get(file.path);
    if (!Buffer.isBuffer(bytes)) { deny("DIGEST_MISMATCH"); continue; }
    total += bytes.length;
    if (bytes.length > EXTERNAL_LIMITS.fileBytes || total > EXTERNAL_LIMITS.totalBytes) { deny("LIMIT_EXCEEDED"); continue; }
    if (!Number.isSafeInteger(file.bytes) || file.bytes !== bytes.length || !SHA256.test(file.sha256) ||
        createHash("sha256").update(bytes).digest("hex") !== file.sha256) deny("DIGEST_MISMATCH");
    if (!SHA1.test(file.blobSha1) || createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== file.blobSha1) deny("BLOB_MISMATCH");
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) incompatible({ kind: "text", path: file.path });
      texts.set(file.path, text);
    } catch { incompatible({ kind: "text", path: file.path }); }
  }
  for (const path of files.keys()) if (!paths.has(path)) deny("DIGEST_MISMATCH");
  if (!paths.has(skill.path + "/SKILL.md")) incompatible({ kind: "file", path: skill.path + "/SKILL.md" });
  for (const [path, text] of texts) {
    const basename = path.split("/").at(-1)!;
    if (!licenseName.test(basename) && !noticeName.test(basename)) {
      const issue = instructionIssue(text, skill.path, paths); if (issue) incompatible({ ...issue, path });
    }
  }
  // A package's unknown or conflicting declaration cannot be silently relabeled by inner text.
  if (skill.bundle.license !== undefined && !isAllowedExternalLicense(skill.bundle.license)) deny("LICENSE_BLOCKED");
  const digest = digestExternalFiles(skill.files);
  const matching = reviews.filter(review => plainObject(review) && review.sourceId === skill.sourceId && review.path === skill.path &&
    review.commit === skill.commit && review.contentSha256 === digest && review.policyVersion === EXTERNAL_REVIEW_POLICY_VERSION);
  if (matching.length !== 1 || !isExternalSkillReview(matching[0])) {
    if (matching.length === 1 && (!Array.isArray(matching[0].licenses) || !matching[0].licenses.length || !matching[0].licenses.every(licenseSchema))) deny("LICENSE_BLOCKED");
    deny("REVIEW_REQUIRED"); return result();
  }
  const evidence = matching[0].licenses, covered = new Set<string>(), licensePaths = new Set<string>();
  for (const license of evidence) {
    const text = texts.get(license.path), file = skill.files.find(file => file.path === license.path);
    if (licensePaths.has(license.path) || !licenseName.test(license.path.split("/").at(-1)!) || !file || !text ||
        license.sha256 !== file.sha256 || !license.spdx || !isAllowedExternalLicense(license.spdx) || !licenseTermsPresent(text, license.spdx)) deny("LICENSE_BLOCKED");
    licensePaths.add(license.path);
    const unique = new Set(license.covers);
    if (unique.size !== license.covers.length) deny("LICENSE_BLOCKED");
    for (const path of license.covers) { if (!paths.has(path)) deny("LICENSE_BLOCKED"); covered.add(path); }
  }
  for (const path of paths) {
    if (!covered.has(path) || (licenseName.test(path.split("/").at(-1)!) && !licensePaths.has(path))) deny("LICENSE_BLOCKED");
  }
  try {
    const declaration: unknown = parseSkillMatter(texts.get(skill.path + "/SKILL.md") ?? "").data.license;
    if (declaration !== undefined) {
      if (typeof declaration !== "string") deny("LICENSE_BLOCKED");
      else if (isAllowedExternalLicense(declaration)) {
        if (!evidence.some(license => license.spdx === declaration && license.covers.includes(skill.path + "/SKILL.md"))) deny("LICENSE_BLOCKED");
      } else {
        const pointer = /^complete terms in ((?:LICENSE|LICENCE|COPYING)(?:\.md|\.txt)?)$/i.exec(declaration);
        if (!pointer || !licensePaths.has(skill.path + "/" + pointer[1])) deny("LICENSE_BLOCKED");
      }
    }
  } catch { deny("LICENSE_BLOCKED"); }
  return result(evidence);
}
