"use client";

/**
 * One app-wide poller for `/api/feed` (~1 s). Polling also drives the
 * backend's lazy time-based work (contract §6), so it runs on every page.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "@/lib/api";
import { FEED_POLL_MS } from "@/lib/config";
import type { FeedItem } from "@/lib/types";

type Listener = (items: FeedItem[]) => void;

type FeedContextValue = {
  items: FeedItem[];
  demo: boolean;
  /** True if any received event came from the hand-labeled backup input. */
  labeledInput: boolean;
  error: string | null;
  /** Increments whenever new items arrive; use it to refetch derived data. */
  version: number;
  /** Called with items that arrived after the first load (never with the backlog). */
  subscribe: (fn: Listener) => () => void;
  /** Drop local feed state after a demo reset. */
  restart: () => void;
};

const FeedContext = createContext<FeedContextValue | null>(null);
const MAX_ITEMS = 300;

export function FeedProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<FeedItem[]>([]);
  const [demo, setDemo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const cursor = useRef<string | null>(null);
  const loaded = useRef(false);
  const listeners = useRef(new Set<Listener>());
  const epoch = useRef(0);

  const restart = useCallback(() => {
    epoch.current++;
    cursor.current = null;
    loaded.current = false;
    setItems([]);
    setVersion((v) => v + 1);
  }, []);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const myEpoch = epoch.current;
      try {
        const res = await api.feed(cursor.current);
        if (stopped || myEpoch !== epoch.current) return;
        setError(null);
        // Empty polls carry no demo flag; keep the last known value.
        setDemo((prev) => (res.items.length ? res.demo || res.items.some((i) => i.demo) : prev || res.demo));
        if (res.cursor) cursor.current = res.cursor;
        if (res.items.length) {
          setItems((prev) => [...prev, ...res.items].slice(-MAX_ITEMS));
          setVersion((v) => v + 1);
          if (loaded.current) listeners.current.forEach((fn) => fn(res.items));
        }
        loaded.current = true;
      } catch (e) {
        if (!stopped) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!stopped) timer = setTimeout(poll, FEED_POLL_MS);
      }
    };
    poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, []);

  const subscribe = useCallback((fn: Listener) => {
    listeners.current.add(fn);
    return () => {
      listeners.current.delete(fn);
    };
  }, []);

  const labeledInput = items.some((i) => i.source_mode === "labeled");

  return (
    <FeedContext.Provider value={{ items, demo, labeledInput, error, version, subscribe, restart }}>
      {children}
    </FeedContext.Provider>
  );
}

export function useFeed(): FeedContextValue {
  const ctx = useContext(FeedContext);
  if (!ctx) throw new Error("useFeed must be used inside <FeedProvider>");
  return ctx;
}
