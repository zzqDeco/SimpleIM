import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
} from "react";
import { Icon, type IconName } from "./Icon.tsx";

interface MenuContextValue {
  readonly close: () => void;
}

const MenuContext = createContext<MenuContextValue | null>(null);

export interface MenuTriggerRenderProps {
  readonly ref: Ref<HTMLButtonElement>;
  readonly "aria-expanded": boolean;
  readonly "aria-haspopup": "menu";
  readonly "aria-controls": string;
  readonly onClick: () => void;
}

export interface MenuProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly trigger: (props: MenuTriggerRenderProps) => ReactNode;
  readonly align?: "start" | "end";
  readonly label: string;
  readonly testId?: string;
  readonly className?: string;
  readonly children: ReactNode;
}

function getFocusableMenuItems(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      '[role="menuitem"]:not([disabled]):not([aria-disabled="true"])',
    ),
  );
}

export function Menu({
  open,
  onOpenChange,
  trigger,
  align = "end",
  label,
  testId,
  className,
  children,
}: MenuProps): ReactElement {
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const wasOpenRef = useRef(false);
  const closedByOutsideClickRef = useRef(false);
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;

  const closeMenu = useCallback((): void => {
    onOpenChangeRef.current(false);
  }, []);

  useEffect(() => {
    const prevOpen = wasOpenRef.current;
    wasOpenRef.current = open;

    if (!prevOpen && open) {
      closedByOutsideClickRef.current = false;
      const popover = popoverRef.current;
      if (popover) {
        const items = getFocusableMenuItems(popover);
        if (items[0]) {
          items[0].focus({ preventScroll: true });
        } else {
          const firstFocusable = popover.querySelector<HTMLElement>(
            'button:not([disabled]), select:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
          );
          (firstFocusable ?? popover).focus({ preventScroll: true });
        }
      }
    } else if (prevOpen && !open) {
      if (!closedByOutsideClickRef.current) {
        triggerRef.current?.focus({ preventScroll: true });
      }
      closedByOutsideClickRef.current = false;
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (ev: PointerEvent): void => {
      const target = ev.target as Node | null;
      if (rootRef.current && target && !rootRef.current.contains(target)) {
        closedByOutsideClickRef.current = true;
        onOpenChangeRef.current(false);
      }
    };

    const handleKeyDown = (ev: globalThis.KeyboardEvent): void => {
      if (ev.key === "Escape" && !ev.defaultPrevented) {
        ev.preventDefault();
        closedByOutsideClickRef.current = false;
        onOpenChangeRef.current(false);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const handlePopoverKeyDown = (ev: KeyboardEvent<HTMLDivElement>): void => {
    const target = ev.target as HTMLElement | null;
    if (
      target &&
      (target.tagName === "SELECT" ||
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA")
    ) {
      return;
    }

    const popover = popoverRef.current;
    if (!popover) return;
    const items = getFocusableMenuItems(popover);
    if (items.length === 0) return;

    const currentIdx = items.indexOf(document.activeElement as HTMLElement);
    if (ev.key === "ArrowDown") {
      ev.preventDefault();
      const next = items[(currentIdx + 1) % items.length];
      next?.focus({ preventScroll: true });
    } else if (ev.key === "ArrowUp") {
      ev.preventDefault();
      const prev =
        items[currentIdx <= 0 ? items.length - 1 : currentIdx - 1];
      prev?.focus({ preventScroll: true });
    } else if (ev.key === "Home") {
      ev.preventDefault();
      items[0]?.focus({ preventScroll: true });
    } else if (ev.key === "End") {
      ev.preventDefault();
      items[items.length - 1]?.focus({ preventScroll: true });
    }
  };

  const rootCls = className ? `ds-menu-root ${className}` : "ds-menu-root";

  return (
    <div ref={rootRef} className={rootCls}>
      {trigger({
        ref: triggerRef,
        "aria-expanded": open,
        "aria-haspopup": "menu",
        "aria-controls": menuId,
        onClick: () => {
          closedByOutsideClickRef.current = false;
          onOpenChange(!open);
        },
      })}

      {open ? (
        <MenuContext.Provider value={{ close: closeMenu }}>
          <div
            ref={popoverRef}
            id={menuId}
            className={`ds-menu-popover ds-menu-align-${align}`}
            data-testid={testId}
            role="menu"
            aria-label={label}
            tabIndex={-1}
            onKeyDown={handlePopoverKeyDown}
          >
            {children}
          </div>
        </MenuContext.Provider>
      ) : null}
    </div>
  );
}

export interface MenuSectionProps {
  readonly className?: string;
  readonly children: ReactNode;
}

export function MenuSection({
  className,
  children,
}: MenuSectionProps): ReactElement {
  const cls = className ? `ds-menu-section ${className}` : "ds-menu-section";
  return <div className={cls}>{children}</div>;
}

export function MenuSeparator(): ReactElement {
  return <div className="ds-menu-separator" role="separator" />;
}

export interface MenuItemProps {
  readonly icon?: IconName;
  readonly tone?: "default" | "danger";
  readonly disabled?: boolean;
  readonly closeOnSelect?: boolean;
  readonly onSelect: () => void;
  readonly testId?: string;
  readonly children: ReactNode;
}

export function MenuItem({
  icon,
  tone = "default",
  disabled = false,
  closeOnSelect = true,
  onSelect,
  testId,
  children,
}: MenuItemProps): ReactElement {
  const ctx = useContext(MenuContext);

  const handleClick = (): void => {
    if (disabled) return;
    onSelect();
    if (closeOnSelect) {
      ctx?.close();
    }
  };

  return (
    <button
      type="button"
      role="menuitem"
      className={`ds-menu-item ds-menu-item-${tone}`}
      data-testid={testId}
      disabled={disabled}
      onClick={handleClick}
    >
      {icon ? <Icon name={icon} size={16} className="ds-menu-item-icon" /> : null}
      <span className="ds-menu-item-label">{children}</span>
    </button>
  );
}
