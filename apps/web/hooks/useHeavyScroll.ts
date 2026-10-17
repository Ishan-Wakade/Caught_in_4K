"use client";

import { useEffect } from "react";

/**
 * Intercepts wheel input and eases scroll position toward the target instead
 * of jumping straight there — reads as a heavier, slower scroll than the
 * browser default. Lower `damping` = heavier (slower to catch up).
 */
export function useHeavyScroll(damping = 0.09) {
  useEffect(() => {
    let target = window.scrollY;
    let current = window.scrollY;
    let raf = 0;

    function maxScroll() {
      return document.documentElement.scrollHeight - window.innerHeight;
    }

    function onWheel(e: WheelEvent) {
      e.preventDefault();
      target = Math.min(maxScroll(), Math.max(0, target + e.deltaY));
    }

    function tick() {
      current += (target - current) * damping;
      if (Math.abs(target - current) < 0.5) current = target;
      window.scrollTo(0, current);
      raf = requestAnimationFrame(tick);
    }

    window.addEventListener("wheel", onWheel, { passive: false });
    raf = requestAnimationFrame(tick);
    return () => {
      window.removeEventListener("wheel", onWheel);
      cancelAnimationFrame(raf);
    };
  }, [damping]);
}
