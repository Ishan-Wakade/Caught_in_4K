import { Section, Swatch } from "@/components/dashboard/charts";
import { DEST_LABEL, SITES } from "@/lib/dashboard/sample";
import { listApproved, type CatalogRow } from "@/lib/dashboard/db";
import { ago } from "@/lib/dashboard/format";

export const dynamic = "force-dynamic";

/** "Cambridge guide 2022/23: RECYCLE: metal cans and foil" → "Metal cans and foil" (the subtitle already names the guide). */
function reason(basis: string): string {
  const s = basis
    .replace(/^[^:]*guide[^:]*:\s*/i, "")
    .replace(/^[A-Z]+:\s*/, "")
    .replace(/^NOT recycling:\s*/, "Not recyclable: ")
    .trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Catalog items aren't tied to a real site yet (one store = one database, AGENTS.md) — a stable, made-up label per row. */
function siteLabel(id: string): string {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return SITES[h % SITES.length].name;
}

export default async function CatalogPage() {
  let items: CatalogRow[] = [];
  let error: string | null = null;
  try {
    items = await listApproved();
  } catch (e) {
    error = e instanceof Error ? e.message : "Catalog database unavailable";
  }

  // The rules file has per-brand entries that share a name (three "clear plastic cup"s); a manager sees each item once.
  const seen = new Set<string>();
  const rows = [...items]
    .sort((a, b) => (a.destination === b.destination ? a.name.localeCompare(b.name) : a.destination.localeCompare(b.destination)))
    .filter((c) => {
      const key = `${c.destination}:${c.name.toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  return (
    <>
      <div className="relative left-1/2 flex w-screen -translate-x-1/2 flex-col gap-2 px-4 sm:px-6">
        <h1 className="m-0 font-display text-[40px] leading-none font-bold">Catalog</h1>
        <span className="text-[15px] text-ink-2">{rows.length} approved items</span>
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
              <table className="w-full min-w-[760px] border-collapse text-[15px]">
                <thead>
                  <tr className="text-left">
                    <th scope="col" className="border-b border-rule pr-3 pb-1.5 text-xs font-medium text-muted">Item</th>
                    <th scope="col" className="border-b border-rule px-3 pb-1.5 text-xs font-medium text-muted">Site</th>
                    <th scope="col" className="border-b border-rule px-3 pb-1.5 text-right text-xs font-medium text-muted">Last caught</th>
                    <th scope="col" className="border-b border-rule px-3 pb-1.5 text-xs font-medium text-muted">Bin</th>
                    <th scope="col" className="border-b border-rule pl-3 pb-1.5 text-xs font-medium text-muted">Why</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={5} className="py-3 text-sm text-muted">No approved items yet.</td>
                    </tr>
                  )}
                  {rows.map((c, i) => (
                    <tr key={c.id} className={i ? "border-t border-rule-soft" : ""}>
                      <td className="py-2.5 pr-3 text-ink">{c.name}</td>
                      <td className="px-3 py-2.5 text-sm text-ink-2">{siteLabel(c.id)}</td>
                      <td className="px-3 py-2.5 text-right text-sm text-ink-2 whitespace-nowrap">{ago(c.last_seen_at)}</td>
                      <td className="px-3 py-2.5 whitespace-nowrap">
                        <span className="flex items-center gap-2">
                          <Swatch dest={c.destination} />
                          {DEST_LABEL[c.destination]}
                        </span>
                      </td>
                      <td className="py-2.5 pl-3 text-sm text-ink-2">{reason(c.basis)}</td>
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
