import { useEffect, useMemo, type CSSProperties } from "react";
import { useMediaQuery } from "./useMediaQuery";

const LOCKED_VIEWPORT_STYLE: CSSProperties = {
  inset: "0",
  height: "var(--mobile-app-height)",
  overflow: "hidden",
  position: "fixed",
  width: "100%",
};

export function useMobileViewportLock(): CSSProperties | undefined {
  const shouldLockViewport = useMediaQuery("(pointer: coarse)");

  useEffect(() => {
    if (!shouldLockViewport) {
      document.documentElement.style.removeProperty("--mobile-app-height");
      return;
    }

    const clampWindowScroll = () => {
      if (window.scrollX !== 0 || window.scrollY !== 0) {
        window.scrollTo(0, 0);
      }
    };
    const syncViewportHeight = () => {
      const height = Math.round(window.visualViewport?.height ?? window.innerHeight);
      document.documentElement.style.setProperty("--mobile-app-height", `${height}px`);
      clampWindowScroll();
    };

    syncViewportHeight();
    window.addEventListener("scroll", clampWindowScroll, { passive: true });
    window.addEventListener("resize", syncViewportHeight);
    window.visualViewport?.addEventListener("resize", syncViewportHeight);
    window.visualViewport?.addEventListener("scroll", syncViewportHeight);

    return () => {
      window.removeEventListener("scroll", clampWindowScroll);
      window.removeEventListener("resize", syncViewportHeight);
      window.visualViewport?.removeEventListener("resize", syncViewportHeight);
      window.visualViewport?.removeEventListener("scroll", syncViewportHeight);
      document.documentElement.style.removeProperty("--mobile-app-height");
    };
  }, [shouldLockViewport]);

  return useMemo(
    () => (shouldLockViewport ? LOCKED_VIEWPORT_STYLE : undefined),
    [shouldLockViewport],
  );
}
