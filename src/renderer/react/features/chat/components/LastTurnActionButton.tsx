import { useTranslation } from "../../../i18n";

type LastTurnActionButtonProps = {
  kind: "edit" | "regenerate"; disabled?: boolean;
  onClick: () => void;
}

function ActionGlyph({ kind }: Pick<LastTurnActionButtonProps, "kind">) {
  if (kind === "edit") {
    return <svg fill="none" aria-hidden="true" viewBox="0 0 48 48" height="16" width="16">
      <path stroke="currentColor" strokeLinejoin="round" strokeWidth="4" d="M7 41L16.5 38.5L39 16L32 9L9.5 31.5L7 41Z" />
      <path stroke="currentColor" strokeLinecap="round" strokeWidth="4" d="M27.5 13.5L34.5 20.5" />
    </svg>;
  }
  return <svg fill="none" aria-hidden="true" viewBox="0 0 48 48" height="16" width="16" className="ff-last-turn-action__regenerate-icon">
    <path stroke="currentColor" strokeLinecap="round" strokeWidth="4" d="M40 17A18 18 0 1 0 41 29" />
    <path stroke="currentColor" strokeLinejoin="round" strokeLinecap="round" strokeWidth="4" d="M40 7V17H30" />
  </svg>;
}

export function LastTurnActionButton({ kind, disabled = false, onClick }: LastTurnActionButtonProps) {
  const { t } = useTranslation();
  const labelKey = kind === "edit" ? "lastTurn.editMessage" : "lastTurn.regenerateReply";
  const label = t(labelKey);
  return <button title={label} aria-label={label} onClick={onClick} disabled={disabled}
    className={`ff-last-turn-action ff-last-turn-action--${kind}`} type="button">
    <ActionGlyph kind={kind} />
  </button>;
}
