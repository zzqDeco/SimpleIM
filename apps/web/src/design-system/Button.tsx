import {
  forwardRef,
  type ButtonHTMLAttributes,
  type ReactElement,
  type ReactNode,
} from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly testId?: string;
  readonly children: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "secondary",
    size = "md",
    type = "button",
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
  if (className) {
    parts.push(className);
  }

  return (
    <button
      ref={ref}
      type={type}
      data-testid={testId}
      className={parts.join(" ")}
      {...rest}
    >
      {children}
    </button>
  );
});
