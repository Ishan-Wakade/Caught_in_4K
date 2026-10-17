"use client";

import { useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { ScenesProvider, SCENE_PATH } from "@/hooks/useScenes";
import { SCENES } from "@/lib/sceneDirector";
import { DEMO_TOOLS } from "@/lib/config";
import { DemoNotice } from "./DemoNotice";
import { SiteHeader } from "./SiteHeader";
import { Toast } from "./Toast";

/** Presenter keys (demo tools only): 1/2/3 open Cameras / Bins / Messages (ignored while typing). */
function SceneKeys() {
  const router = useRouter();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const idx = ["1", "2", "3"].indexOf(e.key);
      if (idx >= 0) router.push(SCENE_PATH[SCENES[idx]]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router]);
  return null;
}

export function Shell({ children }: { children: ReactNode }) {
  return (
    <ScenesProvider>
      {DEMO_TOOLS && <SceneKeys />}
      <div className="flex min-h-screen flex-col bg-paper text-ink">
        <DemoNotice />
        <SiteHeader />
        <main className="flex flex-1 flex-col">{children}</main>
      </div>
      <Toast />
    </ScenesProvider>
  );
}
