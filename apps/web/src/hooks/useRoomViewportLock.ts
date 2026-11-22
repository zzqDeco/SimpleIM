import { useEffect, type RefObject } from "react";

/**
 * Locks root document scrolling while RoomScreen is active and tracks
 * `window.visualViewport` so iOS Safari / WebKit keeps `.room-shell` pinned to
 * the exact visible rectangle when the dynamic URL bar or soft keyboard opens.
 */
export function useRoomViewportLock(
  shellRef: RefObject<HTMLDivElement | null>,
): void {
  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") {
      return;
    }

    const docEl = document.documentElement;
    const bodyEl = document.body;
    docEl.classList.add("room-viewport-locked");
    bodyEl.classList.add("room-viewport-locked");

    const syncViewport = (): void => {
      const shell = shellRef.current;
      if (!shell) return;
      if (shell.scrollTop !== 0) {
        shell.scrollTop = 0;
      }
      const vv = window.visualViewport;
      if (!vv) return;

      // Do not override layout when the user deliberately pinch-zooms.
      if (vv.scale > 1.01) {
        shell.style.height = "";
        shell.style.top = "";
        shell.style.bottom = "";
        return;
      }

      if (vv.height > 0) {
        shell.style.height = `${Math.round(vv.height)}px`;
        shell.style.top = `${Math.max(0, Math.round(vv.offsetTop))}px`;
        shell.style.bottom = "auto";
      }
    };

    syncViewport();

    const vv = window.visualViewport;
    if (vv) {
      vv.addEventListener("resize", syncViewport);
      vv.addEventListener("scroll", syncViewport);
    }
    window.addEventListener("resize", syncViewport);
    window.addEventListener("orientationchange", syncViewport);

    return () => {
      if (vv) {
        vv.removeEventListener("resize", syncViewport);
        vv.removeEventListener("scroll", syncViewport);
      }
      window.removeEventListener("resize", syncViewport);
      window.removeEventListener("orientationchange", syncViewport);

      const shell = shellRef.current;
      if (shell) {
        shell.style.height = "";
        shell.style.top = "";
        shell.style.bottom = "";
      }
      docEl.classList.remove("room-viewport-locked");
      bodyEl.classList.remove("room-viewport-locked");
    };
  }, [shellRef]);
}
