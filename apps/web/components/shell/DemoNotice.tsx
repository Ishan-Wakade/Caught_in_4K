"use client";

import { useState } from "react";
import { useFeed } from "@/hooks/useFeed";
import { useScenes } from "@/hooks/useScenes";
import { api } from "@/lib/api";
import { DEMO_TOOLS } from "@/lib/config";

/**
 * The slim strip at the top of every page: the labeled backup input or a lost backend.
 * "Demo mode" and "Reset demo" appear only with the presenter's demo tools on.
 */
export function DemoNotice() {
  const { demo, labeledInput, error, restart } = useFeed();
  const { reset } = useScenes();
  const [busy, setBusy] = useState(false);
  const tools = DEMO_TOOLS && demo;

  const parts = [
    tools ? "Demo mode" : null,
    labeledInput ? "replaying the hand-labeled backup input, not live detection" : null,
  ].filter(Boolean);

  if (!parts.length && !error) return null;

  const resetDemo = async () => {
    if (!confirm("Reset the demo? This clears everything recorded so far and reloads the demo site.")) return;
    setBusy(true);
    try {
      await api.resetDemo();
      restart();
      reset();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative bg-mint px-6 py-[5px] text-center text-[13px] text-forest">
      {parts.join(" · ")}
      {error && <span className="font-bold text-clay-deep"> · Can&apos;t reach the backend: {error}</span>}
      {tools && (
        <button
          onClick={resetDemo}
          disabled={busy}
          className="absolute top-1/2 right-6 -translate-y-1/2 cursor-pointer font-bold text-forest underline-offset-2 hover:underline disabled:opacity-50"
        >
          Reset demo
        </button>
      )}
    </div>
  );
}
