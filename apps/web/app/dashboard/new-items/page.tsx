"use client";

import { useState } from "react";
import { Section, Swatch, num } from "@/components/dashboard/charts";
import { ANNOUNCEMENTS, DEST_LABEL, PROPOSED, windowFor, type Proposed } from "@/lib/dashboard/sample";

type Decision = "approved" | "rejected";

function Suggestion({ p, decision, decide }: { p: Proposed; decision?: Decision; decide: (d: Decision | undefined) => void }) {
  const w = windowFor("30d");
  const seen = ANNOUNCEMENTS.filter((a) => a.item === p.name && a.at >= w.from).length;
  return (
    <li className="flex flex-col gap-3 py-5 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between">
      <div className={`flex min-w-0 flex-col gap-1 ${decision ? "opacity-50" : ""}`}>
        <span className="flex flex-wrap items-center gap-x-3 text-lg font-bold text-ink">
          {p.name}
          <span className="flex items-center gap-2 text-[15px] font-normal text-ink-2">
            <Swatch dest={p.suggested} />
            {DEST_LABEL[p.suggested]}
          </span>
        </span>
        <span className="text-sm text-muted">
          Seen {num(seen)}× this month · {p.basis.replace(/^[A-Z]+\b/, (w) => w[0] + w.slice(1).toLowerCase())}
          {p.confidence < 0.5 ? " · AI unsure, announced as trash" : ""}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {decision ? (
          <>
            <span className={`text-[15px] font-bold ${decision === "approved" ? "text-forest" : "text-clay-deep"}`}>{decision === "approved" ? "Added to catalog" : "Rejected"}</span>
            <button type="button" onClick={() => decide(undefined)} className="min-h-10 cursor-pointer px-3 text-[15px] text-muted hover:text-ink">
              Undo
            </button>
          </>
        ) : (
          <>
            <button type="button" onClick={() => decide("rejected")} className="min-h-10 cursor-pointer rounded-lg border border-rule px-4 text-[15px] font-medium text-ink-2 hover:text-ink">
              Reject
            </button>
            <button type="button" onClick={() => decide("approved")} className="ml-1 min-h-10 cursor-pointer rounded-lg bg-forest px-4 text-[15px] font-bold text-card hover:bg-forest-deep">
              Approve
            </button>
          </>
        )}
      </div>
    </li>
  );
}

export default function NewItemsPage() {
  const [decisions, setDecisions] = useState<Record<string, Decision | undefined>>({});
  const pending = PROPOSED.filter((p) => !decisions[p.id]).length;
  return (
    <>
      <div className="flex flex-col gap-2">
        <h1 className="m-0 font-display text-[40px] leading-none font-bold">New items</h1>
        <span className="text-[15px] text-ink-2">{pending ? `${pending} to review. Approved items join your catalog.` : "All caught up."}</span>
      </div>
      <Section>
        <ul className="m-0 flex list-none flex-col divide-y divide-rule-soft p-0">
          {PROPOSED.map((p) => (
            <Suggestion key={p.id} p={p} decision={decisions[p.id]} decide={(d) => setDecisions((s) => ({ ...s, [p.id]: d }))} />
          ))}
        </ul>
      </Section>
    </>
  );
}
