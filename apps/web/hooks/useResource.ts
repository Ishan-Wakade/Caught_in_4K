"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useFeed } from "./useFeed";

/** Fetches once, then again whenever new feed items arrive (or `reload()` is called). */
export function useResource<T>(fetcher: () => Promise<T>, key: string = "") {
  const { version } = useFeed();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [nonce, setNonce] = useState(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    let cancelled = false;
    fetcherRef
      .current()
      .then((d) => {
        if (!cancelled) {
          setData(d);
          setError(null);
          setLoaded(true);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [version, nonce, key]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, loaded, reload };
}
