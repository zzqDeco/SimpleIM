import type { ReactElement, ReactNode } from "react";
import { Icon } from "./Icon.tsx";

export interface SublineProps {
  readonly children: ReactNode;
  readonly className?: string;
}

export function Subline({ children, className }: SublineProps): ReactElement {
  const cls = className ? `ds-subline ${className}` : "ds-subline";
  return (
    <div className={cls}>
      <span className="ds-subline-glyph" aria-hidden="true">
        <Icon name="corner-down-right" size={16} />
      </span>
      <div className="ds-subline-body">{children}</div>
    </div>
  );
}
