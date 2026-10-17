"use client";

import Link from "next/link";
import { LogoMark } from "@/components/shell/Logo";
import { PageNav, type NavLink } from "@/components/shell/SiteHeader";
import { APP_NAME } from "@/lib/config";
import { COMPANY, PROPOSED } from "@/lib/dashboard/sample";

const TABS: NavLink[] = [
  { href: "/dashboard", label: "Overview" },
  { href: "/dashboard/items", label: "Items", match: (p) => p.startsWith("/dashboard/items") },
  { href: "/dashboard/bins", label: "Bins", match: (p) => p.startsWith("/dashboard/bins") },
  { href: "/dashboard/new-items", label: "New items", badge: PROPOSED.length, match: (p) => p.startsWith("/dashboard/new-items") },
  { href: "/dashboard/catalog", label: "Catalog", match: (p) => p.startsWith("/dashboard/catalog") },
  { href: "/dashboard/sites", label: "Sites", match: (p) => p.startsWith("/dashboard/sites") },
];

/** Same header as the public site (logo left, PageNav right), with the company and the dashboard's own tabs. */
export function DashboardHeader() {
  return (
    <header className="flex flex-wrap items-center justify-between gap-x-7 gap-y-1 border-b border-rule-soft px-6 py-2.5 sm:px-10">
      <div className="flex min-h-11 items-center gap-3">
        <Link href="/dashboard" aria-label={`${APP_NAME}, dashboard overview`} className="flex items-center gap-2.5 text-forest-deep no-underline hover:text-forest-deep">
          <LogoMark />
          <span className="font-display text-2xl leading-none font-extrabold">{APP_NAME}</span>
        </Link>
        <span aria-hidden="true" className="h-5 w-px bg-rule" />
        <span className="text-base font-bold text-ink-2">{COMPANY}</span>
      </div>
      <PageNav pages={TABS} action={{ href: "/camera", label: "← Public site" }} label="Dashboard" />
    </header>
  );
}
