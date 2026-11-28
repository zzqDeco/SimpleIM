import {
  forwardRef,
  type ButtonHTMLAttributes,
  type ReactElement,
} from "react";
import { CountBadge } from "./CountBadge.tsx";
import { Icon, type IconName } from "./Icon.tsx";

export type IconButtonVariant = "ghost" | "secondary" | "primary" | "danger";
export type IconButtonSize = "sm" | "md";

export interface IconButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  readonly icon: IconName;
  readonly label: string;
  readonly variant?: IconButtonVariant;
  readonly size?: IconButtonSize;
  readonly badge?: number | "dot";
  readonly badgeLabel?: string;
  readonly badgeTestId?: string;
  readonly pressed?: boolean;
  readonly testId?: string;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton(
    {
      icon,
      label,
      variant = "ghost",
      size = "md",
      badge,
      badgeLabel,
      badgeTestId,
      pressed,
      type = "button",
      testId,
      className,
      title,
      ...rest
    },
    ref,
  ): ReactElement {
    const parts = [
      "ds-icon-btn",
      `ds-icon-btn-${variant}`,
      `ds-icon-btn-${size}`,
    ];
    if (className) {
      parts.push(className);
    }

    const showBadge =
      badge === "dot" || (typeof badge === "number" && badge > 0);

    return (
      <button
        ref={ref}
        type={type}
        className={parts.join(" ")}
        data-testid={testId}
        aria-label={label}
        aria-pressed={pressed}
        title={title ?? label}
        {...rest}
      >
        <Icon name={icon} size={size === "sm" ? 16 : 20} />
        {showBadge ? (
          <CountBadge
            value={typeof badge === "number" ? badge : 1}
            variant={badge === "dot" ? "dot" : "solid"}
            label={badgeLabel ?? label}
            testId={badgeTestId}
            className="ds-icon-btn-badge"
          />
        ) : null}
      </button>
    );
  },
);
