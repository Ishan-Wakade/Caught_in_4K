"use client";

import { useState } from "react";
import { Swatch } from "@/components/dashboard/charts";
import { DEST_LABEL } from "@/lib/dashboard/sample";
import type { CatalogRow } from "@/lib/dashboard/db";
import { askForManagerToken, getManagerToken } from "@/lib/managerToken";
import { PENDING_CHANGED } from "./DashboardHeader";

type Decision = "approved" | "rejected";
type RowState = { decision?: Decision; pending?: boolean; error?: string };

function ago(iso: string): string {
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  if (min < 24 * 60) return `${Math.round(min / 60)} h ago`;
  return `${Math.round(min / (24 * 60))} days ago`;
}

/** Write routes need the manager token; ask for it once if the server refuses, then retry (same UX as lib/api.ts's `post`). */
async function postDecision(id: string, decision: Decision): Promise<void> {
  const send = async (token: string | null) => {
    const res = await fetch(`/api/dashboard/proposed/${encodeURIComponent(id)}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ decision }),
    });
    if (!res.ok) {
      const text = await res.text();
      let detail = "";
      try { detail = (JSON.parse(text) as { error?: string }).error ?? ""; } catch {}
      throw new Error(`${res.status}${detail ? `: ${detail}` : ""}`);
    }
  };
  try {
    await send(getManagerToken());
  } catch (e) {
    if (!(e instanceof Error) || !e.message.startsWith("401")) throw e;
    const token = askForManagerToken("Approving or rejecting an item needs the area manager's token.");
    if (!token) throw new Error("Cancelled: this action needs the manager token.");
    await send(token);
  }
}

export function NewItemsList({ initial }: { initial: CatalogRow[] }) {
  const [rows, setRows] = useState<Record<string, RowState>>({});

  const decide = async (id: string, decision: Decision) => {
    setRows((s) => ({ ...s, [id]: { pending: true } }));
    try {
      await postDecision(id, decision);
      setRows((s) => ({ ...s, [id]: { decision } }));
      window.dispatchEvent(new Event(PENDING_CHANGED));
    } catch (e) {
      setRows((s) => ({ ...s, [id]: { error: e instanceof Error ? e.message : "Failed" } }));
    }
  };

  return (
    <ul className="m-0 flex list-none flex-col divide-y divide-rule-soft p-0">
      {initial.map((p) => {
        const row = rows[p.id] ?? {};
        return (
          <li key={p.id} className="flex flex-col gap-3 py-5 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between">
            <div className={`flex min-w-0 flex-col gap-1 ${row.decision ? "opacity-50" : ""}`}>
              <span className="flex flex-wrap items-center gap-x-3 text-lg font-bold text-ink">
                {p.name}
                <span className="flex items-center gap-2 text-[15px] font-normal text-ink-2">
                  <Swatch dest={p.destination} />
                  {DEST_LABEL[p.destination]}
                </span>
              </span>
              <span className="text-sm text-muted">
                Seen {p.times_seen}× · last {ago(p.last_seen_at)} · {p.basis}
                {p.confidence !== null && p.confidence < 0.5 ? " · AI unsure, announced as trash" : ""}
              </span>
              {row.error && <span className="text-sm text-clay-deep">{row.error}</span>}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {row.decision ? (
                <span className={`text-[15px] font-bold ${row.decision === "approved" ? "text-forest" : "text-clay-deep"}`}>
                  {row.decision === "approved" ? "Added to catalog" : "Rejected"}
                </span>
              ) : (
                <>
                  <button
                    type="button"
                    disabled={row.pending}
                    onClick={() => decide(p.id, "rejected")}
                    className="min-h-10 cursor-pointer rounded-lg border border-rule px-4 text-[15px] font-medium text-ink-2 hover:text-ink disabled:opacity-50"
                  >
                    Reject
                  </button>
                  <button
                    type="button"
                    disabled={row.pending}
                    onClick={() => decide(p.id, "approved")}
                    className="ml-1 min-h-10 cursor-pointer rounded-lg bg-forest px-4 text-[15px] font-bold text-card hover:bg-forest-deep disabled:opacity-50"
                  >
                    Approve
                  </button>
                </>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
