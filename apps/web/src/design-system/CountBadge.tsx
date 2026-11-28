import type { ReactElement } from "react";

export type CountBadgeVariant = "solid" | "dot";

export interface CountBadgeProps {
  readonly value: number;
  readonly max?: number;
  readonly variant?: CountBadgeVariant;
  readonly label: string;
  readonly testId?: string;
  readonly className?: string;
}

export function CountBadge({
  value,
  max = 99,
  variant = "solid",
  label,
  testId,
  className,
}: CountBadgeProps): ReactElement {
  const parts = ["ds-count-badge", `ds-count-badge-${variant}`];
  if (className) {
    parts.push(className);
  }

  const display = value > max ? `${max}+` : String(value);

  return (
    <span
      className={parts.join(" ")}
      data-testid={testId}
      aria-label={label}
    >
      {variant === "solid" ? <span aria-hidden="true">{display}</span> : null}
    </span>
  );
}
