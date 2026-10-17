import { SiteHeader } from "@/components/shell/SiteHeader";

/**
 * The Demo video and Install tabs: the same header as every page. The page itself never scrolls; a page taller than
 * the window (Install) scrolls inside <main>, and each page sets its own padding.
 */
export default function SiteLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-dvh flex-col bg-paper text-ink">
      <SiteHeader />
      <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">{children}</main>
    </div>
  );
}
