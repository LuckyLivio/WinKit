import { useEffect, useRef } from "react";
import { useI18n } from "../i18n/I18nContext";

export type ShutdownDialogState =
  | { phase: "idle" }
  | { phase: "closing" }
  | {
      phase: "confirming";
      activeCount: number;
      writeFinishingCount: number;
    }
  | { phase: "draining" }
  | {
      phase: "error";
      message: string;
    };

interface ShutdownDialogProps {
  state: ShutdownDialogState;
  liveActiveCount: number;
  onStay: () => void;
  onConfirmQuit: () => void;
}

export function ShutdownDialog({
  state,
  liveActiveCount,
  onStay,
  onConfirmQuit,
}: ShutdownDialogProps) {
  const { t } = useI18n();
  const stayBtnRef = useRef<HTMLButtonElement | null>(null);
  const confirmBtnRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  const visible =
    state.phase === "confirming" || state.phase === "draining" || state.phase === "error";

  // Capture focus when dialog opens and restore when returning to idle
  useEffect(() => {
    if (!visible) {
      return;
    }
    if (!previousFocusRef.current && document.activeElement instanceof HTMLElement) {
      previousFocusRef.current = document.activeElement;
    }
    return () => {
      const prev = previousFocusRef.current;
      previousFocusRef.current = null;
      prev?.focus?.();
    };
  }, [visible]);

  // Default focus on non-destructive "Stay in WinKit" button when entering confirming/error
  useEffect(() => {
    if (state.phase === "confirming" || state.phase === "error") {
      stayBtnRef.current?.focus();
    } else if (state.phase === "draining") {
      dialogRef.current?.focus();
    }
  }, [state.phase]);

  // Keyboard handling:
  // - Escape equals "Stay in WinKit" ONLY in confirming / error (STRICTLY ignored in draining!)
  // - Tab cycles cleanly within modal controls
  useEffect(() => {
    if (!visible) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (state.phase === "confirming" || state.phase === "error") {
          onStay();
        }
        return;
      }

      if (e.key === "Tab") {
        if (state.phase === "draining") {
          e.preventDefault();
          return;
        }
        const focusables = [stayBtnRef.current, confirmBtnRef.current].filter(
          (el): el is HTMLButtonElement => Boolean(el && !el.disabled),
        );
        if (focusables.length === 0) return;
        const first = focusables[0]!;
        const last = focusables[focusables.length - 1]!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [visible, state.phase, onStay]);

  if (!visible) {
    return null;
  }

  const effectiveCount =
    state.phase === "confirming"
      ? liveActiveCount === 0
        ? 0
        : Math.max(liveActiveCount, state.activeCount)
      : 0;

  const title =
    state.phase === "draining"
      ? t.closeGuard.drainingTitle
      : state.phase === "error"
        ? t.closeGuard.errorTitle
        : t.closeGuard.title;

  const body = (() => {
    if (state.phase === "draining") {
      return t.closeGuard.drainingBody;
    }
    if (state.phase === "error") {
      return state.message;
    }
    if (effectiveCount === 0) {
      return t.closeGuard.bodyFinished;
    }
    return t.closeGuard.body(effectiveCount, state.writeFinishingCount);
  })();

  const confirmLabel =
    state.phase === "error"
      ? t.closeGuard.retryQuitButton
      : effectiveCount === 0
        ? t.closeGuard.exitNowButton
        : t.closeGuard.quitAnywayButton;

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onClick={() => {
        if (state.phase === "confirming" || state.phase === "error") {
          onStay();
        }
      }}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="modal-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="winkit-shutdown-title"
        aria-describedby="winkit-shutdown-desc"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="winkit-shutdown-title" className="modal-title">
          {title}
        </h2>
        <p id="winkit-shutdown-desc" className="modal-body">
          {body}
        </p>

        {state.phase === "draining" ? (
          <div className="modal-actions" style={{ justifyContent: "flex-start" }}>
            <span className="task-pill" role="status">
              <span className="task-dot" aria-hidden="true" />
              {t.topbar.runningTasksCount(Math.max(1, liveActiveCount))}
            </span>
          </div>
        ) : (
          <div className="modal-actions">
            <button ref={stayBtnRef} type="button" className="btn" onClick={onStay}>
              {t.closeGuard.stayButton}
            </button>
            <button
              ref={confirmBtnRef}
              type="button"
              className={
                effectiveCount === 0 && state.phase === "confirming"
                  ? "btn btn-primary"
                  : "btn btn-danger"
              }
              onClick={onConfirmQuit}
            >
              {confirmLabel}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
