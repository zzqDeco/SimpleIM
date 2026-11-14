import type { ReactElement } from "react";

export function Divider({ className }: { readonly className?: string }): ReactElement {
  const cls = className ? `ds-divider ${className}` : "ds-divider";
  return <hr className={cls} />;
}
