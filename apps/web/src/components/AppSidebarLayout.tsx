import { useEffect, type CSSProperties, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";

import { useMediaQuery } from "../hooks/useMediaQuery";
import ThreadSidebar from "./Sidebar";
import { Sidebar, SidebarProvider, SidebarRail } from "./ui/sidebar";

const THREAD_SIDEBAR_WIDTH_STORAGE_KEY = "chat_thread_sidebar_width";
const THREAD_SIDEBAR_MIN_WIDTH = 13 * 16;
const THREAD_MAIN_CONTENT_MIN_WIDTH = 40 * 16;

export function AppSidebarLayout({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const shouldLockViewport = useMediaQuery("(pointer: coarse)");

  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function") {
      return;
    }

    const unsubscribe = onMenuAction((action) => {
      if (action !== "open-settings") return;
      void navigate({ to: "/settings" });
    });

    return () => {
      unsubscribe?.();
    };
  }, [navigate]);

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

  return (
    <SidebarProvider
      defaultOpen
      className="h-dvh min-h-0 overflow-hidden overscroll-none"
      style={
        shouldLockViewport
          ? ({
              inset: "0",
              height: "var(--mobile-app-height)",
              overflow: "hidden",
              position: "fixed",
              width: "100%",
            } as CSSProperties)
          : undefined
      }
    >
      <Sidebar
        side="left"
        collapsible="offcanvas"
        className="border-r border-border bg-card text-foreground"
        resizable={{
          minWidth: THREAD_SIDEBAR_MIN_WIDTH,
          shouldAcceptWidth: ({ nextWidth, wrapper }) =>
            wrapper.clientWidth - nextWidth >= THREAD_MAIN_CONTENT_MIN_WIDTH,
          storageKey: THREAD_SIDEBAR_WIDTH_STORAGE_KEY,
        }}
      >
        <ThreadSidebar />
        <SidebarRail />
      </Sidebar>
      {children}
    </SidebarProvider>
  );
}
