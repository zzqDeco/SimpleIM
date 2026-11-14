import {
  forwardRef,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode,
} from "react";

export interface TextFieldProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "id"> {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
  readonly showPromptSigil?: boolean;
  readonly trailingSlot?: ReactNode;
  readonly testId?: string;
}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(
  function TextField(
    {
      id,
      label,
      hint,
      showPromptSigil = false,
      trailingSlot,
      testId,
      className,
      ...inputProps
    },
    ref,
  ): ReactElement {
    const inputCls = className
      ? `ds-field-input ${className}`
      : "ds-field-input";

    return (
      <div className="ds-field">
        <div className="ds-field-header">
          <label htmlFor={id} className="ds-field-label">
            {label}
          </label>
          {hint ? <span className="ds-field-hint">{hint}</span> : null}
        </div>
        <div className="ds-field-control">
          {showPromptSigil ? (
            <span className="ds-field-prompt" aria-hidden="true">
              ❯
            </span>
          ) : null}
          <input
            ref={ref}
            id={id}
            data-testid={testId}
            className={inputCls}
            {...inputProps}
          />
          {trailingSlot ?? null}
        </div>
      </div>
    );
  },
);
