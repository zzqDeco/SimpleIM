import type { ReactElement } from "react";

export interface BrandMarkProps {
  readonly className?: string;
}

export function BrandMark({ className }: BrandMarkProps): ReactElement {
  const cls = className ? `ds-brand-mark ${className}` : "ds-brand-mark";
  return (
    <span className={cls} aria-hidden="true">
      ❯
    </span>
  );
}
