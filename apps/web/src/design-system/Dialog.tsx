import {
  useEffect,
  useId,
  useRef,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";
import { IconButton } from "./IconButton.tsx";

export type DialogSize = "sm" | "md" | "fullscreen";

export interface DialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title: string;
  readonly subtitle?: ReactNode;
  readonly hideTitle?: boolean;
  readonly size?: DialogSize;
  readonly initialFocusRef?: RefObject<HTMLElement | null>;
  readonly headerActions?: ReactNode;
  readonly footer?: ReactNode;
  readonly closeLabel?: string;
  readonly closeTestId?: string;
  readonly testId?: string;
  readonly children: ReactNode;
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Dialog({
  open,
  onClose,
  title,
  subtitle,
  hideTitle = false,
  size = "md",
  initialFocusRef,
  headerActions,
  footer,
  closeLabel = "Close",
  closeTestId,
  testId,
  children,
}: DialogProps): ReactElement | null {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;

    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

    const target =
      initialFocusRef?.current ?? closeBtnRef.current ?? panelRef.current;
    target?.focus({ preventScroll: true });

    const handleKeyDown = (ev: KeyboardEvent): void => {
      if (ev.key === "Escape" && !ev.defaultPrevented) {
        ev.preventDefault();
        onCloseRef.current();
        return;
      }
      if (ev.key === "Tab" && panelRef.current) {
        const focusables = Array.from(
          panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
        ).filter((el) => {
          const style = window.getComputedStyle(el);
          return style.display !== "none" && style.visibility !== "hidden";
        });
        if (focusables.length === 0) {
          ev.preventDefault();
          panelRef.current.focus({ preventScroll: true });
          return;
        }
        const first = focusables[0]!;
        const last = focusables[focusables.length - 1]!;
        const active = document.activeElement as HTMLElement | null;
        if (ev.shiftKey) {
          if (!active || active === first || !panelRef.current.contains(active)) {
            ev.preventDefault();
            last.focus({ preventScroll: true });
          }
        } else if (
          !active ||
          active === last ||
          !panelRef.current.contains(active)
        ) {
          ev.preventDefault();
          first.focus({ preventScroll: true });
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      const prev = restoreFocusRef.current;
      if (prev && prev.isConnected) {
        prev.focus({ preventScroll: true });
      }
    };
  }, [initialFocusRef, open]);

  if (!open) {
    return null;
  }

  return (
    <div
      className="ds-dialog-backdrop"
      data-testid={testId}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onClick={(ev) => {
        if (ev.target === ev.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        ref={panelRef}
        className={`ds-dialog-panel ds-dialog-${size}`}
        tabIndex={-1}
      >
        <div className="ds-dialog-header">
          <div className="ds-dialog-title-group">
            <h2
              id={titleId}
              className={hideTitle ? "sr-only" : "ds-dialog-title"}
            >
              {title}
            </h2>
            {subtitle ? (
              <span className="ds-dialog-subtitle">{subtitle}</span>
            ) : null}
          </div>

          <div className="ds-dialog-header-actions">
            {headerActions}
            <IconButton
              ref={closeBtnRef}
              icon="x"
              size="sm"
              variant="ghost"
              label={closeLabel}
              testId={closeTestId}
              onClick={onClose}
            />
          </div>
        </div>

        <div className="ds-dialog-body">{children}</div>

        {footer ? <div className="ds-dialog-footer">{footer}</div> : null}
      </div>
    </div>
  );
}
