"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { LogoMark } from "@/components/shell/Logo";
import { PageNav, type NavLink } from "@/components/shell/SiteHeader";
import { APP_NAME } from "@/lib/config";
import { COMPANY } from "@/lib/dashboard/sample";

/** Fired by NewItemsList after an approve/reject so the badge recounts without a page load. */
export const PENDING_CHANGED = "dashboard:pending-changed";

/** Pending new items in the catalog database; null (no badge) until loaded or when the database is unavailable. */
function usePendingCount(): number | null {
  const path = usePathname();
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    const load = () =>
      fetch("/api/dashboard/proposed", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((rows: unknown) => live && setCount(Array.isArray(rows) ? rows.length : null))
        .catch(() => live && setCount(null));
    load();
    window.addEventListener(PENDING_CHANGED, load);
    return () => {
      live = false;
      window.removeEventListener(PENDING_CHANGED, load);
    };
  }, [path]);
  return count;
}

function tabs(pending: number | null): NavLink[] {
  return [
    // Live footage first and the dashboard's landing page for the demo (user decision, 18 Oct): it shows the model on
    // real footage, while Overview's numbers are sample data.
    { href: "/dashboard/live-footage", label: "Live footage", match: (p) => p.startsWith("/dashboard/live-footage") },
    { href: "/camera", label: "Live camera" },
    { href: "/dashboard", label: "Overview" },
    { href: "/dashboard/bins", label: "Bins", match: (p) => p.startsWith("/dashboard/bins") },
    { href: "/dashboard/new-items", label: "New items", badge: pending ?? undefined, match: (p) => p.startsWith("/dashboard/new-items") },
    { href: "/dashboard/catalog", label: "Catalog", match: (p) => p.startsWith("/dashboard/catalog") },
    { href: "/dashboard/sites", label: "Sites", match: (p) => p.startsWith("/dashboard/sites") },
  ];
}

/** Same header as the public site (logo left, PageNav right), with the company and the dashboard's own tabs. */
export function DashboardHeader() {
  const pending = usePendingCount();
  return (
    <header className="flex flex-wrap items-center justify-between gap-x-7 gap-y-1 border-b border-rule-soft px-6 py-2.5 sm:px-10">
      <div className="flex min-h-11 items-center gap-3">
        <Link href="/dashboard/live-footage" aria-label={`${APP_NAME}, dashboard home`} className="flex items-center gap-2.5 text-forest-deep no-underline hover:text-forest-deep">
          <LogoMark />
          <span className="font-display text-2xl leading-none font-extrabold">{APP_NAME}</span>
        </Link>
        <span aria-hidden="true" className="h-5 w-px bg-rule" />
        <span className="text-base font-bold text-ink-2">{COMPANY}</span>
      </div>
      <PageNav pages={tabs(pending)} action={{ href: "/camera", label: "← Public site" }} label="Dashboard" />
    </header>
  );
}
