import { useEffect, useRef, type ReactElement } from "react";
import { Button } from "./Button.tsx";

export type ConfirmPanelTone = "danger" | "default";

export interface ConfirmPanelProps {
  readonly title: string;
  readonly description?: string;
  readonly confirmLabel: string;
  readonly cancelLabel: string;
  readonly tone?: ConfirmPanelTone;
  readonly busy?: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  readonly testId?: string;
  readonly confirmTestId?: string;
  readonly cancelTestId?: string;
}

export function ConfirmPanel({
  title,
  description,
  confirmLabel,
  cancelLabel,
  tone = "danger",
  busy = false,
  onConfirm,
  onCancel,
  testId,
  confirmTestId,
  cancelTestId,
}: ConfirmPanelProps): ReactElement {
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    cancelRef.current?.focus({ preventScroll: true });
  }, []);

  return (
    <div
      className={`ds-confirm-panel ds-confirm-panel-${tone}`}
      data-testid={testId}
      role="group"
      aria-label={title}
    >
      <p className="ds-confirm-panel-title">{title}</p>
      {description ? (
        <p className="ds-confirm-panel-desc">{description}</p>
      ) : null}
      <div className="ds-confirm-panel-actions">
        <Button
          ref={cancelRef}
          variant="secondary"
          size="sm"
          testId={cancelTestId}
          disabled={busy}
          onClick={onCancel}
        >
          {cancelLabel}
        </Button>
        <Button
          variant={tone === "danger" ? "danger" : "primary"}
          size="sm"
          testId={confirmTestId}
          loading={busy}
          disabled={busy}
          onClick={onConfirm}
        >
          {confirmLabel}
        </Button>
      </div>
    </div>
  );
}
