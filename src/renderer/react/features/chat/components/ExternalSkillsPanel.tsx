import { externalSkillPreviewCopy } from "./ExternalSkillsPanel.copy";
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ExternalPrepared, ExternalResult, ExternalSkill, ExternalSkillErrorCode, ExternalSkillSourceId, ExternalSkillSelection } from "../../../../../shared/external-skills";
import { useTranslation } from "../../../i18n";
import "./ExternalSkillsPanel.css";

/** Keeps the containing Skills view in place while Main finishes an admitted commit. */
export const ExternalSkillsCommitContext = createContext<(busy: boolean) => void>(() => {});

/** Native buttons handle Enter/Space. Confirms trap Tab, support Escape and restore focus. */
/** Firefly's own repository first: it is the default tab. */
const SOURCE_TABS: readonly (readonly [ExternalSkillSourceId, string])[] = [
  ["firefly", "Firefly-0423/firefly-skills"], ["openai", "openai/plugins"], ["anthropic", "anthropics/skills"],
];

export function useSkillConfirmationFocus(
  dialog: React.RefObject<HTMLDivElement | null>, open: boolean,
  returnFocus: React.RefObject<HTMLElement | null>, dismiss: () => void, locked: boolean,
): void {
  const latest = useRef({ dismiss, locked }); latest.current = { dismiss, locked };
  useEffect(() => {
    if (!open || !dialog.current) return;
    const node = dialog.current;
    const focusables = () => [...node.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]:not(:disabled)')];
    (focusables()[0] ?? node).focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); if (!latest.current.locked) latest.current.dismiss(); }
      if (event.key !== "Tab") return;
      const targets = focusables(), first = targets[0], last = targets[targets.length - 1];
      if (!first) { event.preventDefault(); node.focus(); return; }
      if (!node.contains(document.activeElement)) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
      else if (event.shiftKey && (document.activeElement === first || document.activeElement === node)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    const containFocus = () => {
      if (!node.contains(document.activeElement)) (latest.current.locked ? node : focusables()[0] ?? node).focus();
    };
    // Native blur after disabling a control can move focus outside this node.
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("focusin", containFocus);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("focusin", containFocus);
      if (returnFocus.current?.isConnected) returnFocus.current.focus();
    };
  }, [dialog, open, returnFocus]);
  useEffect(() => {
    // The dialog itself stays focusable while all confirmation controls are locked.
    if (open && locked) dialog.current?.focus();
  }, [dialog, open, locked]);
}

const networkFailure = (): ExternalResult<never> => ({ ok: false, code: "NETWORK_FAILED", error: "External Skill request failed.", retryable: true });
async function request<T>(operation: () => Promise<ExternalResult<T>>): Promise<ExternalResult<T>> {
  try { return await operation(); } catch { return networkFailure(); }
}
type Phase = "loading" | "browse" | "detail-loading" | "detail" | "preparing" | "preview" | "committing";
const sameRevision = (left: ExternalSkill, right: ExternalSkill) => left.id === right.id && left.sourceId === right.sourceId &&
  left.repository === right.repository && left.path === right.path && left.commit === right.commit;

export function ExternalSkillsPanel({ onImported }: { onImported: () => Promise<void> }): React.ReactElement {
  const { t, locale } = useTranslation(), notifyCommit = useContext(ExternalSkillsCommitContext);
  const [source, setSource] = useState<ExternalSkillSourceId>("firefly");
  const [catalog, setCatalog] = useState<ExternalSkill[]>([]), [selected, setSelected] = useState<ExternalSkill>();
  const [approval, setApproval] = useState<ExternalPrepared>(), [phase, setPhase] = useState<Phase>("loading");
  const [filter, setFilter] = useState(""), [message, setMessage] = useState(""), [expired, setExpired] = useState(false);
  const generation = useRef(0), mounted = useRef(false), committing = useRef(false), admission = useRef(false);
  const pendingLoad = useRef<{ source: ExternalSkillSourceId; ticket: number } | undefined>(undefined);
  const cooldownRef = useRef(0);
  const [cooldownUntil, setCooldownUntil] = useState(0), [clock, setClock] = useState(Date.now);
  const rememberFailure = (result: ExternalResult<unknown>) => {
    if (result.ok || result.code !== "RATE_LIMITED") return;
    const now = Date.now(), deadline = result.retryAt;
    const until = typeof deadline === "number" && Number.isSafeInteger(deadline) && deadline > now ? deadline : now + 60000;
    cooldownRef.current = Math.max(cooldownRef.current, until); setCooldownUntil(cooldownRef.current); setClock(now);
  };
  useEffect(() => {
    if (cooldownUntil <= Date.now()) return;
    const timer = setInterval(() => { const now = Date.now(); setClock(now); if (now >= cooldownUntil) clearInterval(timer); }, 1000);
    return () => clearInterval(timer);
  }, [cooldownUntil]);
  const cancelBarrier = useRef<Promise<unknown>>(Promise.resolve());
  const dialog = useRef<HTMLDivElement>(null), prepareButton = useRef<HTMLButtonElement>(null);
  const errorText = useCallback((code: ExternalSkillErrorCode) => `${code}: ${t(`externalSkills.errors.${code}`)}`, [t]);

  // Every cancel is dispatched immediately, then preparation waits for all outstanding cleanup.
  const cancel = useCallback(() => {
    const api = window.settings?.externalSkills;
    const next = api?.cancel ? request(() => api.cancel()) : Promise.resolve(networkFailure());
    cancelBarrier.current = Promise.all([cancelBarrier.current, next]);
    return next;
  }, []);
  const current = (ticket: number) => mounted.current && ticket === generation.current;

  const load = useCallback(async (nextSource: ExternalSkillSourceId, refresh: boolean, invalidate: boolean) => {
    if (committing.current || (cooldownRef.current > Date.now() && (refresh || nextSource !== source))) return;
    if (pendingLoad.current?.source === nextSource && pendingLoad.current.ticket === generation.current) return;
    const ticket = ++generation.current;
    pendingLoad.current = { source: nextSource, ticket };
    try {
    admission.current = false; setSource(nextSource); setCatalog([]); setSelected(undefined); setApproval(undefined); setFilter(""); setMessage(""); setPhase("loading");
    if (invalidate) {
      const cancelled = await cancel();
      if (!current(ticket)) return;
      if (!cancelled.ok) setMessage(errorText(cancelled.code));
    }
    const api = window.settings?.externalSkills;
    if (!api?.list) { if (current(ticket)) { setMessage(t("externalSkills.unavailable")); setPhase("browse"); } return; }
    const result = await request(() => api.list(nextSource, refresh));
    if (!current(ticket)) return;
    if (!result.ok) { rememberFailure(result); setMessage(errorText(result.code)); }
    else if (result.value.some(skill => skill.sourceId !== nextSource)) setMessage(errorText("STATE_INVALID"));
    else setCatalog(result.value);
    setPhase("browse");
    } finally { if (pendingLoad.current?.ticket === ticket) pendingLoad.current = undefined; }
  }, [cancel, errorText, t, source]);

  useEffect(() => {
    mounted.current = true;
    void load("firefly", false, false);
    return () => { mounted.current = false; generation.current++; void cancel(); };
    // Language changes only change presentation, never restart a prepared transaction.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const showDetail = async (skill: ExternalSkill, selection = skill.selection, invalidate = false) => {
    if (committing.current || (admission.current && !invalidate)) return;
    const ticket = ++generation.current; admission.current = true;
    setMessage(""); setSelected(undefined); setApproval(undefined); setPhase("detail-loading");
    if (invalidate) { await cancel(); if (!current(ticket)) return; }
    const api = window.settings?.externalSkills;
    const result = api?.detail ? await request(() => selection ? api.detail(skill.sourceId, skill.id, selection) : api.detail(skill.sourceId, skill.id)) : networkFailure();
    if (!current(ticket)) return;
    admission.current = false;
    if (!result.ok) { rememberFailure(result); setMessage(api?.detail ? errorText(result.code) : t("externalSkills.unavailable")); }
    else if (!sameRevision(result.value, { ...skill, commit: selection?.commit ?? skill.commit }) || result.value.sourceId !== source ||
      (selection && result.value.selection?.kind !== selection.kind)) setMessage(errorText("STATE_INVALID"));
    else setSelected(result.value);
    setPhase("detail");
  };
  const previewCopy = externalSkillPreviewCopy(locale);
  // A Skill that ships with Firefly is never installed a second time from the market.
  const canPrepare = (skill: ExternalSkill) => !skill.builtIn && skill.declaration !== "pending" && skill.declaration !== "blocked" && (skill.preview !== undefined
    ? skill.preview.complete === false && skill.review === "unreviewed" && skill.blockers.every(code => code === "REVIEW_REQUIRED")
    : skill.review === "approved" && skill.blockers.length === 0);
  const prepare = async () => {
    if (!selected || !canPrepare(selected) || admission.current || committing.current) return;
    const candidate = selected, ticket = ++generation.current; admission.current = true;
    setMessage(""); setPhase("preparing");
    await cancelBarrier.current;
    if (!current(ticket)) return;
    const api = window.settings?.externalSkills;
    const result = api?.prepare ? await request(() => candidate.selection ? api.prepare(candidate.sourceId, candidate.id, candidate.selection) : api.prepare(candidate.sourceId, candidate.id)) : networkFailure();
    if (!current(ticket)) return;
    if (!result.ok) {
      rememberFailure(result);
      const failed = api?.prepare ? errorText(result.code) : t("externalSkills.unavailable");
      setMessage(failed); setSelected(undefined); setPhase("detail-loading");
      // Retryable transport errors and stale snapshots require an explicit refresh.
      // A terminal content audit can expose its cached blockers through detail.
      if (api?.detail && !result.retryable && result.code !== "STALE_SNAPSHOT") {
        const refreshed = await request(() => candidate.selection ? api.detail(candidate.sourceId, candidate.id, candidate.selection) : api.detail(candidate.sourceId, candidate.id));
        if (!current(ticket)) return;
        if (!refreshed.ok) { rememberFailure(refreshed); setMessage(`${failed} ${errorText(refreshed.code)}`); }
        else if (!sameRevision(refreshed.value, candidate) || (candidate.selection && refreshed.value.selection?.kind !== candidate.selection.kind)) setMessage(`${failed} ${errorText("STATE_INVALID")}`);
        else setSelected(refreshed.value);
      }
      admission.current = false; setPhase("detail"); return;
    }
    admission.current = false;
    const value = result.value;
    if (!sameRevision(value.skill, candidate) || (candidate.selection && value.skill.selection?.kind !== candidate.selection.kind) ||
      (candidate.selection?.kind === "reviewed" && value.contentSha256 !== candidate.revisions?.reviewed?.contentSha256) ||
      value.skill.preview !== undefined || value.skill.review !== "approved" || value.skill.blockers.length) {
      setMessage(errorText("STATE_INVALID")); setPhase("detail"); void cancel(); return;
    }
    setApproval(value); setExpired(Date.now() >= value.expiresAt); setPhase("preview");
  };
  const dismiss = useCallback(() => {
    if (committing.current) return;
    const ticket = ++generation.current; admission.current = false; setApproval(undefined); setPhase("detail"); setMessage("");
    void cancel().then(result => { if (current(ticket) && !result.ok) setMessage(errorText(result.code)); });
  }, [cancel, errorText]);
  useSkillConfirmationFocus(dialog, !!approval, prepareButton, dismiss, phase === "committing");
  useEffect(() => {
    if (!approval || phase === "committing") return;
    const remaining = approval.expiresAt - Date.now();
    if (remaining <= 0) { setExpired(true); setMessage(errorText("TOKEN_EXPIRED")); return; }
    const timer = setTimeout(() => { setExpired(true); setMessage(errorText("TOKEN_EXPIRED")); }, remaining);
    return () => clearTimeout(timer);
  }, [approval, phase, errorText]);

  const commit = async () => {
    if (!approval || committing.current || admission.current) return;
    if (Date.now() >= approval.expiresAt) { setExpired(true); setMessage(errorText("TOKEN_EXPIRED")); return; }
    const accepted = approval, ticket = generation.current;
    committing.current = true; admission.current = true; notifyCommit(true); setPhase("committing"); setMessage(t("externalSkills.committing"));
    const api = window.settings?.externalSkills;
    const result = api?.commit ? await request(() => api.commit(accepted.token)) : networkFailure();
    if (!current(ticket)) return;
    setApproval(undefined); setSelected(accepted.skill); setPhase("detail");
    if (!result.ok) setMessage(api?.commit ? errorText(result.code) : t("externalSkills.unavailable"));
    else if (result.value.id !== accepted.skill.id || result.value.enabled !== false || result.value.contentSha256 !== accepted.contentSha256) setMessage(errorText("STATE_INVALID"));
    else {
      const imported = t("externalSkills.imported", { name: accepted.skill.upstreamName }); setMessage(imported);
      try { await onImported(); } catch { if (current(ticket)) setMessage(`${imported} ${t("externalSkills.installedRefreshFailed")}`); }
      if (current(ticket) && api?.detail && accepted.skill.revisions) {
        const selection = accepted.skill.selection;
        const updated = await request(() => selection ? api.detail(accepted.skill.sourceId, accepted.skill.id, selection) : api.detail(accepted.skill.sourceId, accepted.skill.id));
        if (!current(ticket)) return;
        if (updated.ok && sameRevision(updated.value, accepted.skill)) setSelected(updated.value);
        else setMessage(`${imported} ${t("externalSkills.installedRefreshFailed")}`);
      }
    }
    if (current(ticket)) { committing.current = false; admission.current = false; notifyCommit(false); }
  };

  const inventory = (skill: ExternalSkill) => (
    <div className="external-skills__inventory">
      {skill.preview && <p role="status">{previewCopy.notice}</p>}
      {skill.preview && skill.revisions?.reviewed && <p>{t("externalSkills.revalidateReviewed")}</p>}
      <dl>
        {skill.revisions && <>
          <dt>{t("externalSkills.latestDiscovered")}</dt><dd>{skill.revisions.latest?.commit ?? t("externalSkills.revisionUnavailable")}</dd>
          <dt>{t("externalSkills.reviewedSnapshot")}</dt><dd>{skill.revisions.reviewed ? <>{skill.revisions.reviewed.commit}<p>SHA-256: {skill.revisions.reviewed.contentSha256}</p><p>{t("externalSkills.reviewPolicy")}: {skill.revisions.reviewed.policyVersion}</p></> : t("externalSkills.revisionUnavailable")}</dd>
          <dt>{t("externalSkills.installedVersion")}</dt><dd>{skill.revisions.installed ? <>{skill.revisions.installed.commit}<p>SHA-256: {skill.revisions.installed.contentSha256}</p><p>{t(skill.revisions.installed.enabled ? "externalSkills.statusEnabled" : "externalSkills.statusDisabled")}</p><p>{t("externalSkills.reviewPolicy")}: {skill.revisions.installed.policyVersion ?? t("externalSkills.legacyPolicy")}</p></> : t(skill.revisions.installedError ? "externalSkills.installedInvalid" : "externalSkills.notInstalled")}</dd>
        </>}
        <dt>{t("externalSkills.bundle")}</dt><dd>{skill.bundle.name}</dd>
        {skill.compatibilityFormat && <><dt>{t("externalSkills.packageFormat")}</dt><dd>{skill.compatibilityFormat}</dd></>}
        <dt>{t("externalSkills.bundleVersion")}</dt><dd>{skill.bundle.version ?? t("externalSkills.undeclared")}</dd>
        <dt>{t("externalSkills.bundleLicense")}</dt><dd>{skill.bundle.license ?? t("externalSkills.undeclared")}</dd>
        <dt>{t("externalSkills.repository")}</dt><dd>{skill.repository}</dd>
        <dt>{t("externalSkills.path")}</dt><dd>{skill.path}</dd>
        <dt>{t("externalSkills.commit")}</dt><dd>{skill.commit}</dd>
        <dt>{t("externalSkills.skillVersion")}</dt><dd>{skill.version ?? t("externalSkills.undeclared")}</dd>
        <dt>{t("externalSkills.dependencies")}</dt><dd>{skill.blockers.includes("DEPENDENCY_BLOCKED") ? t("externalSkills.incompatibleDependencies") : skill.preview ? previewCopy.notReviewed : t("externalSkills.instructionOnly")}</dd>
        {skill.declaration && <><dt>{t("externalSkills.declaration")}</dt><dd>{t("externalSkills.declarations." + skill.declaration)}</dd></>}
        <dt>{t("externalSkills.review")}</dt><dd>{t(`externalSkills.reviews.${skill.review}`)}</dd>
      </dl>
      {!!skill.dependencyIssues?.length && <>
        <h3>{t("externalSkills.unsupportedDetails")}</h3>
        <ul>{skill.dependencyIssues.map((issue, index) => <li key={`${issue.kind}/${issue.path}/${index}`}>
          <strong>{t(`externalSkills.issueKinds.${issue.kind}`)}</strong>: {issue.path}{issue.component && <> ({issue.component})</>}
        </li>)}</ul>
      </>}
      <h3>{t("externalSkills.blockers")}</h3>
      {skill.blockers.length ? <ul>{skill.blockers.map(code => <li key={code}>{errorText(code)}</li>)}</ul> : <p>{t("externalSkills.noBlockers")}</p>}
      {skill.preview ? <>
        <h3>{previewCopy.inventory}</h3>
        <dl><dt>{previewCopy.files}</dt><dd>{skill.preview.files}</dd><dt>{previewCopy.bytes}</dt><dd>{skill.preview.bytes}</dd></dl>
        <h3>{previewCopy.licenseFiles}</h3>
        <ul>{skill.preview.licenseFiles.map(file => <li key={file.path}><strong>{file.path}</strong><p>{t("externalSkills.bytes", { count: file.bytes })}</p><p>Blob SHA-1: {file.blobSha1}</p></li>)}</ul>
      </> : <>
      <h3>{t("externalSkills.licenses")}</h3>
      {skill.licenses.length ? <ul>{skill.licenses.map((license, index) => <li key={`${license.path}/${index}`}><strong>{license.path}</strong><p>{license.spdx ?? t("externalSkills.undeclared")}</p><p>SHA-256: {license.sha256}</p><p>{t("externalSkills.covers")}: {license.covers.join(", ")}</p></li>)}</ul> : <p>{t("externalSkills.noLicenseEvidence")}</p>}
      <h3>{t("externalSkills.files", { count: skill.files.length })}</h3>
      <ul>{skill.files.map(file => <li key={file.path}><strong>{file.path}</strong><p>{t("externalSkills.bytes", { count: file.bytes })}</p><p>Blob SHA-1: {file.blobSha1}</p><p>SHA-256: {file.sha256}</p><p>{t("externalSkills.fileLicense")}: {skill.licenses.filter(license => license.covers.includes(file.path)).map(license => `${license.spdx ?? t("externalSkills.undeclared")} (${license.path})`).join(", ") || t("externalSkills.noLicenseEvidence")}</p></li>)}</ul>
      </>}
    </div>
  );
  const keyword = filter.trim().toLowerCase(), shown = catalog.filter(skill => `${skill.upstreamName}\n${skill.description}`.toLowerCase().includes(keyword));
  const locked = phase === "committing", waiting = clock < cooldownUntil;
  const waitingSeconds = Math.max(0, Math.ceil((cooldownUntil - clock) / 1000));
  return (
    <section className="external-skills" aria-label={t("externalSkills.title")}>
      <p className="external-skills__notice">{t("externalSkills.notice")}</p>
      <div className="external-skills__toolbar">
        <div className="external-skills__sources" role="group" aria-label={t("externalSkills.sources")}>
        {SOURCE_TABS.map(([item, name]) => <button key={item} type="button" disabled={locked || waiting || (phase === "loading" && source === item)} aria-pressed={source === item} onClick={() => void load(item, false, true)}>{name}</button>)}
        </div>
        {phase === "browse" && <input type="search" aria-label={t("externalSkills.search")} placeholder={t("externalSkills.search")} value={filter} onChange={event => setFilter(event.target.value)} />}
        <button type="button" disabled={locked || waiting || phase === "loading"} onClick={() => void load(source, true, true)}>{t("externalSkills.refresh")}</button>
        {phase !== "browse" && phase !== "loading" && <button type="button" disabled={locked} onClick={() => void load(source, false, true)}>{t("externalSkills.back")}</button>}
      </div>
      {(message || waiting) && <div className={"external-skills__state" + (waiting ? " is-waiting" : "")} data-state={waiting ? "waiting" : phase === "browse" ? "error" : "notice"} role="status" aria-live="polite">
        <strong>{waiting ? t("externalSkills.waiting") : phase === "browse" ? t("externalSkills.loadFailed") : ""}</strong>
        <p>{message || errorText("RATE_LIMITED")}</p>
        {waiting && <p>{t("externalSkills.retryWaiting", { seconds: waitingSeconds })}</p>}
      </div>}
      {phase === "loading" && <div className="external-skills__state" data-state="loading" role="status" aria-live="polite" aria-busy="true"><strong>{t("common.loading")}</strong><p>{t("externalSkills.loadingNotice")}</p></div>}
      {phase === "browse" && <>
        <div className="external-skills__catalog">{shown.map(skill => <article className="external-skills__candidate" key={skill.id}>
          <div className="external-skills__candidate-heading">
            <button type="button" disabled={waiting} onClick={() => void showDetail(skill)}>{skill.upstreamName}</button>
            {skill.builtIn
              ? <span className="external-skills__badge is-built-in">{t("externalSkills.builtIn")}</span>
              : <span className={"external-skills__badge is-" + (skill.declaration ?? skill.review)}>{t(skill.declaration ? "externalSkills.declarations." + skill.declaration : "externalSkills.reviews." + skill.review)}</span>}
          </div>
          {/* A built-in Skill is not a candidate for import, so its review state and blockers are not shown. */}
          <p>{skill.description}</p><p className="external-skills__candidate-meta">{skill.bundle.name}{skill.builtIn ? "" : ` · ${t("externalSkills.reviews." + skill.review)}`}</p>
          {!skill.builtIn && skill.blockers.map(code => <p key={code}>{errorText(code)}</p>)}
        </article>)}</div>
        {shown.length === 0 && !message && !waiting && <div className="external-skills__state" data-state="empty" role="status"><strong>{t("externalSkills.noMatch")}</strong><p>{t("externalSkills.emptyNotice")}</p></div>}
      </>}
      {phase === "detail-loading" && <p>{t("common.loading")}</p>}
      {selected && <article className="external-skills__detail">
        <h2>{selected.upstreamName}</h2>
        <p>{selected.description}</p>
        {selected.builtIn && <p className="external-skills__built-in">{t("externalSkills.builtInNotice")}</p>}
        {selected.revisions && <div className="external-skills__sources" role="group" aria-label={t("externalSkills.selectRevision")}>
          {(["latest", "reviewed"] as const).map(kind => {
            const revision = selected.revisions?.[kind];
            return <button key={kind} type="button" disabled={locked || waiting || !revision}
              aria-pressed={selected.selection?.kind === kind}
              onClick={() => { if (revision) void showDetail(selected, { kind, commit: revision.commit } satisfies ExternalSkillSelection, true); }}>
              {t(kind === "latest" ? "externalSkills.latestDiscovered" : "externalSkills.reviewedSnapshot")}
            </button>;
          })}
        </div>}
        {inventory(selected)}
        <button ref={prepareButton} type="button"
          disabled={waiting || !canPrepare(selected) || phase === "preparing" || !!approval || locked}
          onClick={() => void prepare()}>
          {selected.preview ? previewCopy.action : t("externalSkills.prepare")}
        </button>
        {phase === "preparing" && <p>{t("externalSkills.preparing")}</p>}
      </article>}
      {approval && <div className="external-skills__overlay">
        <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="external-skills-confirm-title"
          tabIndex={-1} className="external-skills__dialog">
          <h2 id="external-skills-confirm-title">{t("externalSkills.confirmTitle", { name: approval.skill.upstreamName })}</h2>
          <p>{t("externalSkills.confirmNotice")}</p>
          {locked && <p role="status">{t("externalSkills.committing")}</p>}
          <p>{t("externalSkills.contentDigest")}: {approval.contentSha256}</p>
          <p>{t("externalSkills.expires")}: {new Date(approval.expiresAt).toISOString()}</p>
          {inventory(approval.skill)}
          <div className="external-skills__dialog-actions">
            <button type="button" disabled={locked} onClick={dismiss}>{t("common.cancel")}</button>
            <button type="button" disabled={locked || expired} onClick={() => void commit()}>{t("externalSkills.confirm")}</button>
          </div>
        </div>
      </div>}
    </section>
  );
}
