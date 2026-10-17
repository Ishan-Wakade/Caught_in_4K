"use client";

import { useScenes } from "@/hooks/useScenes";

/** Notification for notable feed events. It never changes the page (user decision). */
export function Toast() {
  const { toast, dismissToast } = useScenes();
  if (!toast) return null;
  const alert = toast.tone === "alert";
  return (
    <div role="status" className="animate-rise-in fixed bottom-6 left-6 z-50 flex max-w-md items-start gap-3 rounded-[22px] bg-card px-5 py-4 shadow-[0_2px_4px_rgba(70,60,35,0.06),0_14px_36px_rgba(70,60,35,0.16)]">
      <span aria-hidden="true" className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${alert ? "bg-clay" : "bg-forest"}`} />
      <div className="flex flex-col gap-1">
        <span className="text-[15px] leading-snug text-ink">{toast.text}</span>
      </div>
      <button onClick={dismissToast} aria-label="Dismiss" className="ml-1 cursor-pointer text-lg leading-none text-muted-2 hover:text-ink">
        ×
      </button>
    </div>
  );
}
