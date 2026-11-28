import type { ReactElement, ReactNode } from "react";
import { Icon, type IconName } from "./Icon.tsx";

export type TagTone =
  | "neutral"
  | "accent"
  | "success"
  | "warning"
  | "danger"
  | "info";

export interface TagProps {
  readonly tone?: TagTone;
  readonly icon?: IconName;
  readonly onClick?: () => void;
  readonly title?: string;
  readonly testId?: string;
  readonly className?: string;
  readonly children: ReactNode;
}

export function Tag({
  tone = "neutral",
  icon,
  onClick,
  title,
  testId,
  className,
  children,
}: TagProps): ReactElement {
  const parts = ["ds-tag", `ds-tag-${tone}`];
  if (onClick) {
    parts.push("ds-tag-interactive");
  }
  if (className) {
    parts.push(className);
  }

  const content = (
    <>
      {icon ? <Icon name={icon} size={16} className="ds-tag-icon" /> : null}
      <span className="ds-tag-label">{children}</span>
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        className={parts.join(" ")}
        data-testid={testId}
        title={title}
        onClick={onClick}
      >
        {content}
      </button>
    );
  }

  return (
    <span className={parts.join(" ")} data-testid={testId} title={title}>
      {content}
    </span>
  );
}
