import React from "react";
import "./WorkspaceSourcesPanel.css";

/** Display proposal only; a row does not certify canonical transcript submission. */
export interface WorkspaceSourcePresentation {
  readonly id: string;
  readonly toolLabel: string;
  readonly outcome: "success" | "failure" | "unknown" | "not_executed";
  readonly refs: readonly {
    readonly kind: "file_read" | "file_change" | "web_search";
    readonly display: string;
  }[];
}

export interface WorkspaceSourcesLabels {
  panel: string;
  empty: string;
  pending: string;
  success: string;
  failure: string;
  unknown: string;
  notExecuted: string;
  fileRead: string;
  fileChange: string;
  webSearch: string;
}

export function WorkspaceSourcesPanel({ rows, labels }: {
  rows: readonly WorkspaceSourcePresentation[];
  labels: WorkspaceSourcesLabels;
}) {
  const outcomeLabels = {
    success: labels.success, failure: labels.failure, unknown: labels.unknown, not_executed: labels.notExecuted,
  };
  const refLabels = { file_read: labels.fileRead, file_change: labels.fileChange, web_search: labels.webSearch };
  return (
    <section className="ff-workspace-sources" aria-label={labels.panel}>
      <p className="ff-workspace-sources__pending">{labels.pending}</p>
      {rows.length === 0 ? <p>{labels.empty}</p> : <ul className="ff-workspace-sources__rows">
        {rows.map((row) => <li className="ff-workspace-sources__row" key={row.id}>
          <div className="ff-workspace-sources__heading">
            <strong>{row.toolLabel}</strong>
            <span className={`ff-workspace-sources__outcome is-${row.outcome}`}>{outcomeLabels[row.outcome]}</span>
          </div>
          {row.refs.length === 0 ? <p>{labels.empty}</p> : <ul className="ff-workspace-sources__refs">
            {row.refs.map((ref, index) => <li key={`${ref.kind}:${index}`}>
              <span>{refLabels[ref.kind]}</span><code>{ref.display}</code>
            </li>)}
          </ul>}
        </li>)}
      </ul>}
    </section>
  );
}
