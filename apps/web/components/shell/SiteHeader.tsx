"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useResource } from "@/hooks/useResource";
import { useScenes } from "@/hooks/useScenes";
import { api } from "@/lib/api";
import { LogoMark } from "./Logo";
import { APP_NAME } from "@/lib/config";

type NavLink = { href: string; label: string; scene?: "live" | "bins" | "messages"; match?: (p: string) => boolean };

// The manager's pages, in one list (user decision, 2026-10-16: no Demo / Manage split).
const PAGES: NavLink[] = [
  { href: "/", label: "Overview", match: (p) => p === "/" || p.startsWith("/items") },
  { href: "/live", label: "Cameras", scene: "live" },
  { href: "/bins", label: "Bins", scene: "bins" },
  { href: "/messages", label: "Messages", scene: "messages" },
  { href: "/reviews", label: "Review queue" },
  { href: "/catalog", label: "Catalog" },
];

function useClock(): string {
  const [now, setNow] = useState<string>("");
  useEffect(() => {
    const tickClock = () => setNow(new Date().toLocaleTimeString([], { hour12: false }));
    tickClock();
    const id = setInterval(tickClock, 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

/** One navigation for the whole app (from the design). */
export function SiteHeader() {
  const path = usePathname();
  const { unseen } = useScenes();
  const reviews = useResource(api.reviews);
  const pending = reviews.data?.reviews.filter((r) => r.status === "pending").length ?? 0;
  const clock = useClock();

  const link = (l: NavLink) => {
    const current = l.match ? l.match(path) : path === l.href;
    const fresh = l.scene && !current && unseen[l.scene];
    return (
      <Link
        key={l.href}
        href={l.href}
        aria-current={current ? "page" : undefined}
        title={fresh ? `${l.label} has new updates` : undefined}
        className={`flex min-h-11 items-center gap-[7px] px-3 text-base no-underline ${
          current ? "font-bold text-forest hover:text-forest" : "font-medium text-ink-2 hover:text-ink"
        }`}
      >
        <span aria-hidden="true" className={`h-[7px] w-[7px] rounded-full ${current ? "bg-forest" : fresh ? "bg-clay" : ""}`} />
        {l.label}
        {l.href === "/reviews" && pending > 0 && <span className="font-bold text-clay-deep">{pending}</span>}
      </Link>
    );
  };

  // Three columns so the nav stays centred on every page, whatever sits either side.
  return (
    <header className="grid grid-cols-[1fr_auto_1fr] items-center gap-x-7 border-b border-rule-soft px-10 py-2.5">
      <Link href="/" aria-label={`${APP_NAME}, overview`} className="flex min-h-11 items-center gap-2.5 justify-self-start text-forest-deep no-underline hover:text-forest-deep">
        <LogoMark />
        <span className="font-display text-2xl leading-none font-extrabold">{APP_NAME}</span>
      </Link>
      <nav aria-label="Pages" className="flex flex-wrap items-center justify-center">
        {PAGES.map(link)}
      </nav>
      <span className="justify-self-end font-mono text-[17px] text-muted tabular-nums">{clock}</span>
    </header>
  );
}
