import type { ReactElement } from "react";

export type StatusKind =
  | "success"
  | "error"
  | "warning"
  | "info"
  | "online"
  | "offline"
  | "loading";

export interface StatusIconProps {
  readonly status: StatusKind;
  readonly className?: string;
}

const GLYPH_BY_STATUS: Readonly<Record<StatusKind, string>> = {
  success: "✓",
  error: "✗",
  warning: "⚠",
  info: "●",
  online: "●",
  offline: "○",
  loading: "…",
};

const TONE_CLASS_BY_STATUS: Readonly<Record<StatusKind, string>> = {
  success: "ds-status-icon-success",
  error: "ds-status-icon-error",
  warning: "ds-status-icon-warning",
  info: "ds-status-icon-info",
  online: "ds-status-icon-success",
  offline: "ds-status-icon-muted",
  loading: "ds-status-icon-accent",
};

export function StatusIcon({ status, className }: StatusIconProps): ReactElement {
  const toneCls = TONE_CLASS_BY_STATUS[status];
  const cls = className
    ? `ds-status-icon ${toneCls} ${className}`
    : `ds-status-icon ${toneCls}`;

  return (
    <span className={cls} aria-hidden="true">
      {GLYPH_BY_STATUS[status]}
    </span>
  );
}
