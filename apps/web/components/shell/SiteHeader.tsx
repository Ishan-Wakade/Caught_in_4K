"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useResource } from "@/hooks/useResource";
import { useScenes } from "@/hooks/useScenes";
import { api } from "@/lib/api";
import { LogoMark } from "./Logo";
import { APP_NAME } from "@/lib/config";

export type NavLink = { href: string; label: string; scene?: "live" | "bins" | "messages"; match?: (p: string) => boolean };

// The manager's pages, in one list (user decision, 2026-10-16: no Demo / Manage split).
export const PAGES: NavLink[] = [
  { href: "/", label: "Overview", match: (p) => p === "/" || p.startsWith("/items") },
  { href: "/camera", label: "Live camera" },
  { href: "/live", label: "Cameras", scene: "live" },
  { href: "/reviews", label: "Review queue" },
  { href: "/catalog", label: "Catalog" },
];

type Unseen = Partial<Record<NonNullable<NavLink["scene"]>, boolean>>;

/**
 * The page links. Every page anchors them at the right of its top bar, so they never move between pages;
 * the camera page lays them over its video with tone="dark".
 */
export function PageNav({ tone = "light", unseen = {} }: { tone?: "light" | "dark"; unseen?: Unseen }) {
  const path = usePathname();
  const reviews = useResource(api.reviews);
  const pending = reviews.data?.reviews.filter((r) => r.status === "pending").length ?? 0;
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
        {l.href === "/reviews" && pending > 0 && <span className={`font-bold ${dark ? "text-clay-light" : "text-clay-deep"}`}>{pending}</span>}
      </Link>
    );
  };

  return (
    <nav aria-label="Pages" className="flex flex-wrap items-center justify-end">
      {PAGES.map(link)}
    </nav>
  );
}

/** One navigation for the whole app: logo left, page links right, as on the camera page. */
export function SiteHeader() {
  const { unseen } = useScenes();

  return (
    <header className="flex items-center justify-between gap-x-7 border-b border-rule-soft px-10 py-2.5">
      <Link href="/" aria-label={`${APP_NAME}, overview`} className="flex min-h-11 items-center gap-2.5 text-forest-deep no-underline hover:text-forest-deep">
        <LogoMark />
        <span className="font-display text-2xl leading-none font-extrabold">{APP_NAME}</span>
      </Link>
      <PageNav unseen={unseen} />
    </header>
  );
}
