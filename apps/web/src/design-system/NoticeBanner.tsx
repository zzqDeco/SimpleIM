import type { ReactElement, ReactNode } from "react";
import { Button } from "./Button.tsx";
import { StatusIcon, type StatusKind } from "./StatusIcon.tsx";

export type NoticeTone = "info" | "warning" | "error";

export interface NoticeBannerProps {
  readonly tone: NoticeTone;
  readonly loading?: boolean;
  readonly testId?: string;
  readonly dismissLabel?: string;
  readonly onDismiss?: () => void;
  readonly children: ReactNode;
}

export function NoticeBanner({
  tone,
  loading = false,
  testId,
  dismissLabel,
  onDismiss,
  children,
}: NoticeBannerProps): ReactElement {
  const iconStatus: StatusKind = loading
    ? "loading"
    : tone === "error"
      ? "error"
      : tone === "warning"
        ? "warning"
        : "info";

  return (
    <div
      className={`ds-notice ds-notice-${tone}`}
      role={tone === "error" ? "alert" : "status"}
      data-testid={testId}
    >
      <div className="ds-notice-main">
        <StatusIcon status={iconStatus} />
        <span>{children}</span>
      </div>
      {onDismiss && dismissLabel ? (
        <Button variant="secondary" size="sm" onClick={onDismiss}>
          {dismissLabel}
        </Button>
      ) : null}
    </div>
  );
}
