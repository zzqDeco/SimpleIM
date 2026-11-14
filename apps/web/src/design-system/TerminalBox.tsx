import type { HTMLAttributes, ReactElement, ReactNode } from "react";

export interface TerminalBoxProps extends HTMLAttributes<HTMLElement> {
  readonly children: ReactNode;
  readonly as?: "section" | "div";
}

export function TerminalBox({
  children,
  as = "section",
  className,
  ...rest
}: TerminalBoxProps): ReactElement {
  const cls = className ? `ds-terminal-box ${className}` : "ds-terminal-box";
  const Tag = as;
  return (
    <Tag className={cls} {...rest}>
      <div className="ds-terminal-box-body">{children}</div>
    </Tag>
  );
}
