"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LogoMark } from "./Logo";
import { APP_NAME } from "@/lib/config";

export type NavLink = { href: string; label: string; scene?: "live" | "bins"; match?: (p: string) => boolean; badge?: number };

// The site's tabs (user decisions, 2026-10-17): try it live, watch the recorded demo, run it on your own video, see
// how a store installs it. The old manager pages still exist at their URLs but are no longer linked.
export const PAGES: NavLink[] = [
  { href: "/camera", label: "Live camera" },
  { href: "/demo", label: "Demo video" },
  { href: "/upload", label: "Try your video" },
  { href: "/install", label: "Install" },
];

type Unseen = Partial<Record<NonNullable<NavLink["scene"]>, boolean>>;

export type HeaderAction = { href: string; label: string };

/** The button at the end of the nav that switches between the public site and the manager dashboard. */
export const TO_DASHBOARD: HeaderAction = { href: "/dashboard", label: "Manager dashboard →" };

/**
 * The page links plus that button. Every page anchors them at the right of its top bar, so they never move between
 * pages; the camera page lays them over its video with tone="dark", and the dashboard passes its own tabs.
 */
export function PageNav({
  tone = "light",
  unseen = {},
  pages = PAGES,
  action = TO_DASHBOARD,
  label = "Pages",
}: {
  tone?: "light" | "dark";
  unseen?: Unseen;
  pages?: NavLink[];
  action?: HeaderAction;
  label?: string;
}) {
  const path = usePathname();
  const dark = tone === "dark";

  const link = (l: NavLink) => {
    const current = l.match ? l.match(path) : path === l.href;
    const fresh = l.scene && !current && unseen[l.scene];
    const color = current
      ? dark ? "font-bold text-card hover:text-card" : "font-bold text-forest hover:text-forest"
      : dark ? "font-medium text-[#D9DCD0] hover:text-card" : "font-medium text-ink-2 hover:text-ink";
    return (
      <Link
        key={l.href}
        href={l.href}
        aria-current={current ? "page" : undefined}
        title={fresh ? `${l.label} has new updates` : undefined}
        className={`flex min-h-11 items-center gap-[7px] px-3 text-base no-underline ${color}`}
      >
        <span
          aria-hidden="true"
          className={`h-[7px] w-[7px] rounded-full ${current ? (dark ? "bg-leaf" : "bg-forest") : fresh ? "bg-clay" : ""}`}
        />
        {l.label}
        {l.badge ? <span className={`font-bold ${dark ? "text-clay-light" : "text-clay-deep"}`}>{l.badge}</span> : null}
      </Link>
    );
  };

  return (
    <nav aria-label={label} className="flex flex-wrap items-center justify-end gap-x-1">
      {pages.map(link)}
      <Link
        href={action.href}
        className={`ml-3 flex min-h-10 items-center rounded-lg border px-3.5 text-[15px] font-bold no-underline ${
          dark
            ? "border-card/70 text-card hover:bg-card hover:text-night"
            : "border-forest text-forest hover:bg-forest hover:text-card"
        }`}
      >
        {action.label}
      </Link>
    </nav>
  );
}

/** One navigation for the whole app: logo left, page links right, as on the camera page. */
export function SiteHeader({ unseen = {}, pages }: { unseen?: Unseen; pages?: NavLink[] }) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-x-7 gap-y-1 border-b border-rule-soft px-6 py-2.5 sm:px-10">
      <Link href="/" aria-label={`${APP_NAME}, overview`} className="flex min-h-11 items-center gap-2.5 text-forest-deep no-underline hover:text-forest-deep">
        <LogoMark />
        <span className="font-display text-2xl leading-none font-extrabold">{APP_NAME}</span>
      </Link>
      <PageNav unseen={unseen} pages={pages} />
    </header>
  );
}
