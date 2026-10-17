"use client";

import { useState } from "react";
import { useFeed } from "@/hooks/useFeed";
import { useScenes } from "@/hooks/useScenes";
import { api } from "@/lib/api";

/**
 * The slim strip at the top of every page: says what is demo, recorded,
 * backup input, or mocked. Required by the honesty rules in AGENTS.md.
 */
export function DemoNotice() {
  const { demo, items, labeledInput, error, restart } = useFeed();
  const { reset } = useScenes();
  const [busy, setBusy] = useState(false);
  const mockData = api.source === "mock";

  const mockedTexts = items.some((i) => i.mocked && (i.type === "message_sent" || i.type === "reply_received"));
  const mockedImages = items.some((i) => i.mocked && i.type === "illustration_ready");
  const mockedServices = [mockedTexts && "texts", mockedImages && "bin images"].filter(Boolean).join(" and ");

  const parts = [
    demo ? "Demo mode" : null,
    mockData
      ? "scripted sample data in the browser, not the camera worker"
      : labeledInput
        ? "replaying the hand-labeled backup input, not live detection"
        : null,
    mockedServices ? `${mockedServices} come from mock services` : null,
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
      {demo && (
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
