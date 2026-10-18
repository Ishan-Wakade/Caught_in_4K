import { Section, Swatch } from "@/components/dashboard/charts";
import { DEST_LABEL } from "@/lib/dashboard/sample";
import { listApproved, type CatalogRow } from "@/lib/dashboard/db";
import { num } from "@/lib/dashboard/format";

export const dynamic = "force-dynamic";

/**
 * Every row enters the catalog one of two ways (lib/dashboard/db.ts): seeded from the Cambridge rules file with no
 * confidence score, or camera-caught by the voice guide (a confidence score) and later approved out of New items.
 */
function originLabel(c: CatalogRow): string {
  return c.confidence == null ? "Rules guide" : "Camera · approved";
}

export default async function CatalogPage() {
  let items: CatalogRow[] = [];
  let error: string | null = null;
  try {
    items = await listApproved();
  } catch (e) {
    error = e instanceof Error ? e.message : "Catalog database unavailable";
  }

  // One flat, sortable sheet — the bin is a column, not a grouping.
  const rows = [...items].sort((a, b) => (a.destination === b.destination ? a.name.localeCompare(b.name) : a.destination.localeCompare(b.destination)));

  return (
    <>
      <div className="flex flex-col gap-2">
        <h1 className="m-0 font-display text-[40px] leading-none font-bold">Catalog</h1>
        <span className="text-[15px] text-ink-2">
          {rows.length} approved items · bins follow City of Cambridge, MA rules (2022/23 guide)
        </span>
      </div>
      {error ? (
        <Section>
          <p className="m-0 text-[15px] text-clay-deep">{error}</p>
        </Section>
      ) : (
        // Full-bleed: break out of the dashboard layout's max-w-6xl so the sheet can use nearly the whole page.
        <div className="relative left-1/2 w-screen -translate-x-1/2 px-4 sm:px-6">
          <Section>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] border-collapse text-base">
                <thead>
                  <tr className="text-left">
                    <th scope="col" className="border-b border-rule pr-3 pb-1.5 text-xs font-medium text-muted">Item</th>
                    <th scope="col" className="border-b border-rule px-3 pb-1.5 text-xs font-medium text-muted">From</th>
                    <th scope="col" className="border-b border-rule px-3 pb-1.5 text-xs font-medium text-muted">Bin</th>
                    <th scope="col" className="border-b border-rule px-3 pb-1.5 text-xs font-medium text-muted">Basis</th>
                    <th scope="col" className="border-b border-rule px-3 pb-1.5 text-right text-xs font-medium text-muted">Confidence</th>
                    <th scope="col" className="border-b border-rule pl-3 pb-1.5 text-right text-xs font-medium text-muted">Times caught</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={6} className="py-3 text-sm text-muted">No approved items yet.</td>
                    </tr>
                  )}
                  {rows.map((c, i) => (
                    <tr key={c.id} className={i ? "border-t border-rule-soft" : ""}>
                      <td className="py-[9px] pr-3">{c.name}</td>
                      <td className="px-3 py-[9px] text-sm text-ink-2">{originLabel(c)}</td>
                      <td className="px-3 py-[9px]">
                        <span className="flex items-center gap-2">
                          <Swatch dest={c.destination} />
                          {DEST_LABEL[c.destination]}
                        </span>
                      </td>
                      <td className="px-3 py-[9px] text-sm text-ink-2">{c.basis}</td>
                      <td className="px-3 py-[9px] text-right font-mono text-sm">{c.confidence != null ? `${Math.round(c.confidence * 100)}%` : "—"}</td>
                      <td className="py-[9px] pl-3 text-right font-mono text-sm">{num(c.times_seen)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>
        </div>
      )}
    </>
  );
}
