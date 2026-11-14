import { Children, Fragment, type ReactElement, type ReactNode } from "react";

export interface BylineProps {
  readonly children: ReactNode;
  readonly className?: string;
}

export function Byline({ children, className }: BylineProps): ReactElement | null {
  const items = Children.toArray(children).filter((child) => child !== "");
  if (items.length === 0) {
    return null;
  }

  const cls = className ? `ds-byline ${className}` : "ds-byline";

  return (
    <span className={cls}>
      {items.map((item, idx) => (
        <Fragment key={idx}>
          {idx > 0 ? (
            <span className="ds-byline-sep" aria-hidden="true">
              {" · "}
            </span>
          ) : null}
          <span>{item}</span>
        </Fragment>
      ))}
    </span>
  );
}
