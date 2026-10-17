import { SiteHeader } from "@/components/shell/SiteHeader";

/** The Demo video and Install tabs: the same header as every page, content in one centered column. */
export default function SiteLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-paper text-ink">
      <SiteHeader />
      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-6 pt-16 pb-24 sm:px-10">{children}</main>
    </div>
  );
}
