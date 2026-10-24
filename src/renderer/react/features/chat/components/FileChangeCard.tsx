import { useState } from "react";
import { useTranslation } from "../../../i18n";
import type { ToolDiffLine, ToolFileChange } from "../../../../../shared/chat-types";
import "./RunExperience.css";

const KIND_LABEL_KEYS: Record<ToolFileChange["kind"], string> = {
  added: "fileChange.kindAdded", modified: "fileChange.kindModified",
  deleted: "fileChange.kindDeleted", renamed: "fileChange.kindRenamed",
};
const KIND_CLASS: Record<ToolFileChange["kind"], string> = {
  added: "is-added", modified: "is-modified", deleted: "is-deleted", renamed: "is-renamed",
};

function validChange(value: unknown): boolean {
  const change = value as Partial<ToolFileChange> | null;
  return !(typeof change?.file !== "string" || !change.file ||
    (change.kind !== "added" && change.kind !== "modified" && change.kind !== "deleted" && change.kind !== "renamed") ||
    typeof change.insertions !== "number" || typeof change.deletions !== "number");
}

export function extractFileChanges(result: string): ToolFileChange[] | null {
  let payload: unknown;
  try { payload = JSON.parse(result); }
  catch { return null; }
  const list = (payload as { changes?: unknown } | null)?.changes;
  if (!Array.isArray(list) || list.length === 0) return null;
  for (const item of list) if (!validChange(item)) return null;
  return list as ToolFileChange[];
}

export function FileChangeCard({ changes }: { changes: ToolFileChange[] }) {
  const { t } = useTranslation();
  const additions = changes.reduce((total, entry) => total + entry.insertions, 0);
  const removals = changes.reduce((total, entry) => total + entry.deletions, 0);
  return <section aria-label={t("fileChange.panelAria")} className="ff-file-change-card">
    <header className="ff-file-change-card__summary">
      <span className="ff-file-change-card__title">{t("fileChange.summary", { count: changes.length })}</span>
      <span className="ff-file-change-card__stat is-add">+{additions}</span>
      <span className="ff-file-change-card__stat is-remove">−{removals}</span>
    </header>
    {changes.map(change => <FileChangeRow change={change} key={`${change.kind}:${change.file}`} />)}
  </section>;
}

function FileChangeRow({ change }: { change: ToolFileChange }) {
  const { t } = useTranslation();
  const [diffVisible, setDiffVisible] = useState(false);
  const expandable = Boolean(change.diff && change.diff.length > 0);
  const slash = change.file.lastIndexOf("/");
  const directory = slash > 0 ? change.file.slice(0, slash + 1) : "";
  const filename = slash > 0 ? change.file.slice(slash + 1) : change.file;
  const details = <>
    <span className={`ff-file-change-card__kind ${KIND_CLASS[change.kind]}`}>{t(KIND_LABEL_KEYS[change.kind])}</span>
    <span title={change.file} className="ff-file-change-card__path">
      {directory && <span className="ff-file-change-card__dir">{directory}</span>}
      <span className="ff-file-change-card__base">{filename}</span>
    </span>
    <FileRowStats additions={change.insertions} deletions={change.deletions} />
  </>;
  const row = expandable
    ? <button aria-expanded={diffVisible} onClick={() => setDiffVisible(!diffVisible)}
      className={`ff-file-change-card__row is-expandable${diffVisible ? " is-expanded" : ""}`} type="button">
      {details}<svg aria-hidden="true" viewBox="0 0 16 16" className="ff-file-change-card__chevron">
        <path strokeWidth="1.75" strokeLinejoin="round" strokeLinecap="round" stroke="currentColor" fill="none" d="m4 6 4 4 4-4" />
      </svg>
    </button>
    : <div className="ff-file-change-card__row">{details}</div>;
  return <div className="ff-file-change-card__row-wrapper">
    {row}
    {expandable && diffVisible && <div className="ff-file-change-card__diff">
      {change.diff!.map((line, index) => <DiffLineView line={line} key={index} />)}
      {change.truncated && <div className="ff-file-change-card__truncated">{t("fileChange.truncated")}</div>}
    </div>}
  </div>;
}

function DiffLineView({ line }: { line: ToolDiffLine }) {
  let marker = " ";
  if (line.type === "add") marker = "+";
  else if (line.type === "remove") marker = "−";
  else if (line.type === "hunk") marker = "@";
  return <div className={`ff-file-change-card__line is-${line.type}`}>
    <span aria-hidden="true" className="ff-file-change-card__marker">{marker}</span>
    <span className="ff-file-change-card__text">{line.text || " "}</span>
  </div>;
}

function FileRowStats({ additions, deletions }: { additions: number; deletions: number }) {
  return <span className="ff-file-change-card__row-stats">
    {additions > 0 && <span className="is-add">+{additions}</span>}
    {deletions > 0 && <span className="is-remove">−{deletions}</span>}
  </span>;
}
