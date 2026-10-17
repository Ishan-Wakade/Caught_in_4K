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
// Bins is the main page (2026-10-17): it swapped spots with Overview, including routes.
const PAGES: NavLink[] = [
  { href: "/", label: "Bins", scene: "bins" },
  { href: "/live", label: "Cameras", scene: "live" },
  { href: "/overview", label: "Overview", match: (p) => p === "/overview" || p.startsWith("/items") },
  { href: "/messages", label: "Messages", scene: "messages" },
  { href: "/reviews", label: "Review queue" },
  { href: "/catalog", label: "Catalog" },
];

function useClock(): string {
  const [now, setNow] = useState<string>("");
  useEffect(() => {
    const tickClock = () => setNow(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }));
    tickClock();
    const id = setInterval(tickClock, 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

/** `/logo.png` (44px) with a graceful fallback to the existing mark if the file isn't there. */
function HeaderLogo() {
  const [broken, setBroken] = useState(false);
  if (broken) return <LogoMark size={30} />;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- local /public asset with a fallback, same pattern as the catalog page's photo previews
    <img src="/logo.png" alt={`${APP_NAME} camera logo`} width={44} height={44} className="h-11 w-11 rounded-xl object-cover" onError={() => setBroken(true)} />
  );
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
        className={`flex min-h-11 items-center gap-1.5 rounded-full px-4 text-base no-underline ${
          current
            ? "bg-forest-deep font-bold text-paper hover:text-paper"
            : `font-medium hover:text-ink ${fresh ? "text-clay-deep" : "text-ink-2"}`
        }`}
      >
        {l.label}
        {l.href === "/reviews" && pending > 0 && (
          <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-clay-deep px-1.5 font-mono text-[11px] font-bold text-paper">
            {pending}
          </span>
        )}
      </Link>
    );
  };

  // Three columns so the nav stays centred on every page, whatever sits either side.
  return (
    <header className="grid grid-cols-[1fr_auto_1fr] items-center gap-x-7 border-b border-rule-soft px-10 py-2.5">
      <Link href="/" aria-label={`${APP_NAME}, home`} className="flex min-h-11 items-center gap-2.5 justify-self-start text-forest-deep no-underline hover:text-forest-deep">
        <HeaderLogo />
        <span className="font-display text-2xl leading-none font-extrabold">{APP_NAME}</span>
      </Link>
      <nav aria-label="Pages" className="flex flex-wrap items-center justify-center gap-1">
        {PAGES.map(link)}
      </nav>
      <span className="justify-self-end font-mono text-[17px] text-muted tabular-nums">{clock}</span>
    </header>
  );
}
