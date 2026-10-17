"use client";

/**
 * Demo-scene state shared by every page: which scene is on screen, tabs with
 * unseen updates, the current toast, and which bin/alert the latest feed item
 * concerns. Scenes never switch automatically (user decision); see sceneDirector.
 */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { useFeed } from "./useFeed";
import {
  dismissToast,
  initialDirector,
  onFeedItem,
  selectScene,
  tick,
  type DirectorState,
  type Scene,
} from "@/lib/sceneDirector";

// bins is "/" now — it swapped routes with Overview (2026-10-17).
export const SCENE_PATH: Record<Scene, string> = { live: "/live", bins: "/", messages: "/messages" };

export function sceneForPath(path: string): Scene | null {
  return (Object.keys(SCENE_PATH) as Scene[]).find((s) => SCENE_PATH[s] === path) ?? null;
}

type ScenesValue = DirectorState & {
  dismissToast: () => void;
  setActiveAlert: (id: string) => void;
  reset: () => void;
};

const ScenesContext = createContext<ScenesValue | null>(null);

export function ScenesProvider({ children }: { children: ReactNode }) {
  const { subscribe } = useFeed();
  const path = usePathname();
  const [dir, setDir] = useState<DirectorState>(initialDirector);

  useEffect(() => setDir((d) => selectScene(d, sceneForPath(path))), [path]);

  useEffect(
    () => subscribe((items) => setDir((d) => items.reduce((s, i) => onFeedItem(s, i, Date.now()), d))),
    [subscribe],
  );

  useEffect(() => {
    const id = setInterval(() => setDir((d) => tick(d, Date.now())), 500);
    return () => clearInterval(id);
  }, []);

  const value: ScenesValue = {
    ...dir,
    dismissToast: useCallback(() => setDir(dismissToast), []),
    setActiveAlert: useCallback((id: string) => setDir((d) => ({ ...d, activeAlertId: id })), []),
    reset: useCallback(() => setDir({ ...initialDirector(), scene: sceneForPath(path) }), [path]),
  };
  return <ScenesContext.Provider value={value}>{children}</ScenesContext.Provider>;
}

export function useScenes(): ScenesValue {
  const ctx = useContext(ScenesContext);
  if (!ctx) throw new Error("useScenes must be used inside <ScenesProvider>");
  return ctx;
}
