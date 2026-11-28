import type { ReactElement } from "react";

export type StatusDotKind = "online" | "offline" | "warning";

export interface StatusDotProps {
  readonly status: StatusDotKind;
  readonly label?: string;
  readonly className?: string;
}

export function StatusDot({
  status,
  label,
  className,
}: StatusDotProps): ReactElement {
  const parts = ["ds-status-dot", `ds-status-dot-${status}`];
  if (className) {
    parts.push(className);
  }
  return (
    <span
      className={parts.join(" ")}
      data-status-dot={status}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
}
