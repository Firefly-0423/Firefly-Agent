// StepProgressPill：输入框上方的工作步骤胶囊；点击展开步骤列表弹层。
//
// 显隐：仅在运行中且有计划时出现。收起时节点保持挂载到退场动画结束（usePresence），
// 外层 grid 行高同步收拢，消息列表不会因为胶囊瞬间消失或出现而跳动。
import { useEffect, useId, useRef, useState, type CSSProperties, type FocusEvent } from "react";
import { useTranslation } from "../../../i18n";
import {
  describeStepCursor,
  type StepProgressStatus,
  type StepProgressSummary,
} from "./step-progress";
import "./StepProgressPill.css";

export type StepProgressPillProps = StepProgressSummary;

/** 与 StepProgressPill.css 中的退场 keyframes 时长对齐：节点在动画结束后才卸载。 */
const PILL_EXIT_MS = 200;
const POPOVER_EXIT_MS = 180;

// 只存 i18n key（t() 不能出现在模块顶层常量里），展示文案在组件内求值。
const STATUS_KEYS: Record<StepProgressStatus, string> = {
  done: "stepProgress.statusDone",
  running: "stepProgress.statusRunning",
  pending: "stepProgress.statusPending",
};

/** 让节点在退场期间保持挂载：present 变为 false 后延迟 exitMs 再卸载；返回本次渲染是否应挂载。 */
function usePresence(present: boolean, exitMs: number): boolean {
  const [mounted, setMounted] = useState(present);
  useEffect(() => {
    if (present) {
      setMounted(true);
      return undefined;
    }
    const timer = setTimeout(() => setMounted(false), exitMs);
    return () => clearTimeout(timer);
  }, [present, exitMs]);
  return present || mounted;
}

function SpinnerIcon({ className }: { className: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <circle className="ff-step-spinner__track" cx="12" cy="12" r="9" />
      <path d="M21 12a9 9 0 0 0-9-9" />
    </svg>
  );
}

export function StepProgressPill({ steps, filesChanged, added, removed, running }: StepProgressPillProps) {
  const { t } = useTranslation();
  const visible = running && steps.length > 0;
  const presenceRendered = usePresence(visible, PILL_EXIT_MS);
  // 计划被清空（新一轮开始、todo 重置）时直接卸载，不播放退场：否则退场中会短暂显示 "第 0 / 0 步"。
  const pillRendered = presenceRendered && steps.length > 0;
  const [open, setOpen] = useState(false);
  const popoverPresent = open && visible;
  const popoverRendered = usePresence(popoverPresent, POPOVER_EXIT_MS);
  const popoverId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // 胶囊收起时同步收起弹层，下次出现不会自动展开。
  useEffect(() => {
    if (!visible) setOpen(false);
  }, [visible]);

  // 弹层打开期间监听外部按下与 Escape；仅在打开时挂载监听。
  useEffect(() => {
    if (!popoverPresent) return undefined;
    const onPointerDown = (event: Event) => {
      if (!rootRef.current?.contains(event.target as Node | null)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // 捕获阶段拦截：Escape 只负责收起弹层，不再传给输入框等其他监听器。
      event.stopPropagation();
      const focusWithin = rootRef.current?.contains(document.activeElement) ?? false;
      setOpen(false);
      // 焦点在弹层或胶囊上时把焦点归还给胶囊；焦点在别处（如输入框）则保持不动。
      if (focusWithin) buttonRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [popoverPresent]);

  if (!pillRendered) return null;

  const cursor = describeStepCursor(steps);
  const progressText = cursor.allDone
    ? t("stepProgress.allDone", { total: cursor.total })
    : t("stepProgress.position", { current: cursor.current, total: cursor.total });

  return (
    <div
      ref={rootRef}
      className={`ff-step-pill-host${visible ? "" : " is-leaving"}`}
      onBlur={(event: FocusEvent<HTMLDivElement>) => {
        // 焦点移到组件外（如 Tab 离开）时收起；焦点落在胶囊或弹层内部不收起。
        const next = event.relatedTarget as Node | null;
        if (next && !event.currentTarget.contains(next)) setOpen(false);
      }}
    >
      <div className="ff-step-pill-row">
        <button
          ref={buttonRef}
          type="button"
          className="ff-step-pill"
          aria-expanded={open}
          aria-controls={popoverRendered ? popoverId : undefined}
          onClick={() => setOpen((value) => !value)}
        >
          <SpinnerIcon className="ff-step-pill__spinner" />
          <span className="ff-step-pill__text">
            <span key={progressText} className="ff-step-pill__progress">{progressText}</span>
            {filesChanged !== undefined && (
              <>
                <span className="ff-step-pill__sep" aria-hidden="true"> · </span>
                <span>{t("stepProgress.filesChanged", { count: filesChanged })}</span>
              </>
            )}
            {added !== undefined && (
              <>
                {" "}
                <span className="ff-step-pill__add">+{added}</span>
              </>
            )}
            {removed !== undefined && (
              <>
                {" "}
                <span className="ff-step-pill__del">-{removed}</span>
              </>
            )}
          </span>
        </button>
      </div>
      {popoverRendered && (
        <div className={`ff-step-popover-anchor${popoverPresent ? "" : " is-leaving"}`}>
          <div
            id={popoverId}
            className="ff-step-popover"
            role="group"
            aria-label={t("stepProgress.panelAria")}
            tabIndex={-1}
          >
            <ol aria-live="polite">
              {steps.map((step, index) => (
                <li
                  key={index}
                  className={`ff-step-item is-${step.status}`}
                  style={{ "--ff-step-index": index } as CSSProperties}
                >
                  <span className="ff-step-item__icon" aria-hidden="true">
                    <svg className="ff-step-item__check" viewBox="0 0 24 24">
                      <circle cx="12" cy="12" r="9" />
                      <path d="m8.5 12.3 2.4 2.4 4.6-4.8" />
                    </svg>
                    <SpinnerIcon className="ff-step-item__spinner" />
                    <svg className="ff-step-item__circle" viewBox="0 0 24 24">
                      <circle cx="12" cy="12" r="8.5" />
                    </svg>
                  </span>
                  <span className="ff-step-item__status">{t(STATUS_KEYS[step.status])}</span>
                  <span className="ff-step-item__title">{step.title}</span>
                </li>
              ))}
            </ol>
          </div>
        </div>
      )}
    </div>
  );
}
