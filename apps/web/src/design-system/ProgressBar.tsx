import type { CSSProperties, ReactElement } from "react";

export interface ProgressBarProps {
  readonly percent: number;
  readonly ariaLabel: string;
  readonly complete?: boolean;
}

export function ProgressBar({
  percent,
  ariaLabel,
  complete = false,
}: ProgressBarProps): ReactElement {
  const clamped = Number.isFinite(percent)
    ? Math.max(0, Math.min(100, Math.round(percent)))
    : 0;
  const fillStyle = {
    "--ds-progress-pct": `${clamped}%`,
  } as CSSProperties;

  return (
    <div
      className="ds-progress"
      role="progressbar"
      aria-label={ariaLabel}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={clamped}
    >
      <div
        className={
          complete
            ? "ds-progress-fill ds-progress-fill-complete"
            : "ds-progress-fill"
        }
        style={fillStyle}
      />
    </div>
  );
}
