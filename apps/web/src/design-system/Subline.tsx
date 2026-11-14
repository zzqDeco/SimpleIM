import type { ReactElement, ReactNode } from "react";

export interface SublineProps {
  readonly children: ReactNode;
  readonly className?: string;
}

export function Subline({ children, className }: SublineProps): ReactElement {
  const cls = className ? `ds-subline ${className}` : "ds-subline";
  return (
    <div className={cls}>
      <span className="ds-subline-glyph" aria-hidden="true">
        ⎿
      </span>
      <div className="ds-subline-body">{children}</div>
    </div>
  );
}
