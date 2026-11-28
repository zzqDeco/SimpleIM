import { useEffect, useRef, type ReactElement, type ReactNode } from "react";
import { Button } from "./Button.tsx";
import { Icon, type IconName } from "./Icon.tsx";

export type ToastTone = "info" | "success" | "warning" | "error";

export interface ToastAction {
  readonly label: string;
  readonly onClick: () => void;
}

export interface ToastProps {
  readonly tone?: ToastTone;
  readonly message: string;
  readonly action?: ToastAction;
  readonly durationMs?: number;
  readonly onDismiss: () => void;
  readonly testId?: string;
}

const ICON_BY_TONE: Readonly<Record<ToastTone, IconName>> = {
  info: "info",
  success: "check",
  warning: "triangle-alert",
  error: "x",
};

export function Toast({
  tone = "info",
  message,
  action,
  durationMs = 2400,
  onDismiss,
  testId,
}: ToastProps): ReactElement {
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  useEffect(() => {
    if (durationMs <= 0) {
      return;
    }
    const timer = window.setTimeout(() => {
      onDismissRef.current();
    }, durationMs);
    return () => {
      window.clearTimeout(timer);
    };
  }, [durationMs, message]);

  return (
    <div
      className={`ds-toast ds-toast-${tone}`}
      data-testid={testId}
      role="status"
    >
      <Icon name={ICON_BY_TONE[tone]} size={16} className="ds-toast-icon" />
      <span className="ds-toast-message">{message}</span>
      {action ? (
        <Button variant="ghost" size="sm" onClick={action.onClick}>
          {action.label}
        </Button>
      ) : null}
    </div>
  );
}

export type ToastPlacement = "bottom-center" | "top-center";

export interface ToastRegionProps {
  readonly placement?: ToastPlacement;
  readonly className?: string;
  readonly children: ReactNode;
}

export function ToastRegion({
  placement = "bottom-center",
  className,
  children,
}: ToastRegionProps): ReactElement {
  const parts = ["ds-toast-region", `ds-toast-region-${placement}`];
  if (className) {
    parts.push(className);
  }
  return (
    <div className={parts.join(" ")} aria-live="polite" aria-atomic="true">
      {children}
    </div>
  );
}
