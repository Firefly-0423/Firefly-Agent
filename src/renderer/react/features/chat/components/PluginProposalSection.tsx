import { useState } from "react";
import { Check, X } from "lucide-react";
import { useTranslation } from "../../../i18n";
import {
  describeProposalAction,
  describeProposalChanges,
  describeProposalSchedule,
  type PluginProposal,
  type SchedulerApi,
  type SchedulerResult,
} from "./scheduled-task-model";

interface PluginProposalSectionProps {
  proposals: PluginProposal[];
  api: SchedulerApi | undefined;
  /** Called after a confirm or reject succeeded, so the panel reloads its lists. */
  onResolved: () => void;
}

/** The "pending confirmation" block at the top of the scheduled-task panel; renders nothing without proposals. */
export function PluginProposalSection({ proposals, api, onResolved }: PluginProposalSectionProps) {
  const { t } = useTranslation();
  /** Task ids with a request in flight. */
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});

  if (proposals.length === 0) return null;

  const decide = async (proposal: PluginProposal, decision: "confirm" | "reject") => {
    setBusy((current) => new Set(current).add(proposal.taskId));
    setErrors((current) => withoutKey(current, proposal.taskId));
    try {
      const request = decision === "confirm"
        ? api?.confirmPluginProposal?.(proposal.taskId, proposal.revision)
        : api?.rejectPluginProposal?.(proposal.taskId);
      if (!request) throw new Error(t("scheduledPanel.apiUnavailable"));
      const result: SchedulerResult<boolean> = await request;
      if (!result.ok) {
        // The service's messages are English and name internal ids; known codes get a plain sentence.
        if (result.code === "ERR_UNAVAILABLE") {
          // The plugin edited the proposal after it was shown: reload so the user reviews the new spec.
          onResolved();
          throw new Error(t("scheduledPanel.pending.changedSinceReview"));
        }
        if (result.code === "ERR_REJECTED") throw new Error(t("scheduledPanel.pending.alreadyRejected"));
        if (result.code === "ERR_INVALID_ARGUMENT") throw new Error(t("scheduledPanel.pending.notPending"));
        throw new Error(result.error ?? t("scheduledPanel.pending.failed"));
      }
      onResolved();
    } catch (err) {
      const message = err instanceof Error ? err.message : t("scheduledPanel.pending.failed");
      setErrors((current) => ({ ...current, [proposal.taskId]: message }));
    } finally {
      setBusy((current) => {
        const next = new Set(current);
        next.delete(proposal.taskId);
        return next;
      });
    }
  };

  return (
    <section className="scheduled-pending" aria-label={t("scheduledPanel.pending.title")}>
      <h2 className="scheduled-pending__title">{t("scheduledPanel.pending.title")}</h2>
      <p className="scheduled-panel__hint">{t("scheduledPanel.pending.hint")}</p>
      <div className="scheduled-list">
        {proposals.map((proposal) => {
          const inFlight = busy.has(proposal.taskId);
          const isUpdate = proposal.kind === "update";
          const changes = describeProposalChanges(proposal, t);
          return (
            <article key={proposal.proposalId} className="scheduled-card scheduled-pending__card" data-task-id={proposal.taskId}>
              <div className="scheduled-card__head">
                <h3 className="scheduled-card__name">{proposal.title}</h3>
                <span className="scheduled-card__badge is-on">
                  {isUpdate ? t("scheduledPanel.pending.kindUpdate") : t("scheduledPanel.pending.kindCreate")}
                </span>
              </div>
              <ul className="scheduled-card__meta">
                <li>{t("scheduledPanel.createdByPlugin", { plugin: proposal.pluginName || proposal.pluginId })}</li>
                <li>{t("scheduledPanel.pending.scheduleLine", { value: describeProposalSchedule(proposal.schedule, t) })}</li>
                <li>{describeProposalAction(proposal.action, t)}</li>
                {proposal.action.type === "run" && (
                  <li>{t("scheduledPanel.pending.toolsLine", { value: proposal.allowedToolIds.join(", ") || t("scheduledPanel.noTools") })}</li>
                )}
              </ul>
              {isUpdate && (
                proposal.current ? (
                  <div className="scheduled-pending__changes">
                    <strong>{t("scheduledPanel.pending.changesHeading")}</strong>
                    {changes.length > 0
                      ? <ul>{changes.map((change, index) => <li key={index}>{change}</li>)}</ul>
                      : <p>{t("scheduledPanel.pending.noChanges")}</p>}
                  </div>
                ) : (
                  <p className="scheduled-pending__changes">{t("scheduledPanel.pending.originalMissing")}</p>
                )
              )}
              {errors[proposal.taskId] && (
                <div role="alert" className="scheduled-state is-error">{errors[proposal.taskId]}</div>
              )}
              <div className="scheduled-card__actions">
                <button type="button" className="scheduled-btn is-primary" disabled={inFlight}
                  onClick={() => void decide(proposal, "confirm")}>
                  <Check size={13} strokeWidth={1.8} aria-hidden="true" />
                  <span>{t("scheduledPanel.pending.confirm")}</span>
                </button>
                <button type="button" className="scheduled-btn is-danger" disabled={inFlight}
                  onClick={() => void decide(proposal, "reject")}>
                  <X size={13} strokeWidth={1.8} aria-hidden="true" />
                  <span>{t("scheduledPanel.pending.reject")}</span>
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const next = { ...record };
  delete next[key];
  return next;
}
