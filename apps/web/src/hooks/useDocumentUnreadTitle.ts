import { useEffect } from "react";

/**
 * Reflects background unread activity in the browser tab title,
 * restoring the base title automatically when unmounted or read.
 */
export function useDocumentUnreadTitle(
  baseTitle: string,
  totalUnreadCount: number,
): void {
  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }
    const badge = totalUnreadCount > 99 ? "99+" : String(totalUnreadCount);
    document.title = totalUnreadCount > 0 ? `(${badge}) ${baseTitle}` : baseTitle;
    return () => {
      document.title = baseTitle;
    };
  }, [baseTitle, totalUnreadCount]);
}
