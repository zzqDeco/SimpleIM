import {
  forwardRef,
  type ButtonHTMLAttributes,
  type ReactElement,
  type ReactNode,
} from "react";
import { Icon, type IconName } from "./Icon.tsx";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly leadingIcon?: IconName;
  readonly loading?: boolean;
  readonly block?: boolean;
  readonly testId?: string;
  readonly children: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "secondary",
    size = "md",
    type = "button",
    leadingIcon,
    loading = false,
    block = false,
    disabled = false,
    testId,
    className,
    children,
    ...rest
  },
  ref,
): ReactElement {
  const parts = ["ds-btn", `ds-btn-${variant}`];
  if (size === "sm") {
    parts.push("ds-btn-sm");
  }
  if (block) {
    parts.push("ds-btn-block");
  }
  if (loading) {
    parts.push("ds-btn-loading");
  }
  if (className) {
    parts.push(className);
  }

  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      data-testid={testId}
      className={parts.join(" ")}
      {...rest}
    >
      {loading ? (
        <Icon name="loader-circle" size={16} spin className="ds-btn-icon" />
      ) : leadingIcon ? (
        <Icon name={leadingIcon} size={16} className="ds-btn-icon" />
      ) : null}
      {children}
    </button>
  );
});
