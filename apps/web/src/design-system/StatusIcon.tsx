import type { ReactElement } from "react";
import { Icon, type IconName } from "./Icon.tsx";
import { StatusDot } from "./StatusDot.tsx";

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

const ICON_BY_STATUS: Readonly<
  Record<Exclude<StatusKind, "online" | "offline">, IconName>
> = {
  success: "check",
  error: "x",
  warning: "triangle-alert",
  info: "info",
  loading: "loader-circle",
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

  if (status === "online" || status === "offline") {
    return (
      <span className={cls} aria-hidden="true">
        <StatusDot status={status} />
      </span>
    );
  }

  return (
    <span className={cls} aria-hidden="true">
      <Icon
        name={ICON_BY_STATUS[status]}
        size={16}
        spin={status === "loading"}
      />
    </span>
  );
}
