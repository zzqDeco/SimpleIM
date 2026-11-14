import type { ReactElement } from "react";

export interface TabItem<T extends string> {
  readonly id: T;
  readonly label: string;
  readonly testId?: string;
}

export interface TabsProps<T extends string> {
  readonly ariaLabel: string;
  readonly items: readonly TabItem<T>[];
  readonly activeId: T;
  readonly onChange: (nextId: T) => void;
  readonly disabled?: boolean;
}

export function Tabs<T extends string>({
  ariaLabel,
  items,
  activeId,
  onChange,
  disabled = false,
}: TabsProps<T>): ReactElement {
  return (
    <nav className="ds-tabs" role="tablist" aria-label={ariaLabel}>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          aria-selected={item.id === activeId}
          data-testid={item.testId}
          className="ds-tab"
          disabled={disabled}
          onClick={() => onChange(item.id)}
        >
          {item.label}
        </button>
      ))}
    </nav>
  );
}
