import { Section } from "@/components/dashboard/charts";
import { listPending, type CatalogRow } from "@/lib/dashboard/db";
import { NewItemsList } from "@/components/dashboard/NewItemsList";

export const dynamic = "force-dynamic";

export default async function NewItemsPage() {
  let items: CatalogRow[] = [];
  let error: string | null = null;
  try {
    items = await listPending();
  } catch (e) {
    error = e instanceof Error ? e.message : "Catalog database unavailable";
  }

  return (
    <>
      <div className="flex flex-col gap-2">
        <h1 className="m-0 font-display text-[40px] leading-none font-bold">New items</h1>
        <span className="text-[15px] text-ink-2">Items the camera couldn&apos;t match to your approved catalog, pending manual review.</span>
        {!error && <span className="text-[15px] text-ink-2">{items.length ? `${items.length} to review. Approved items join your catalog.` : "All caught up."}</span>}
      </div>
      {error ? (
        <Section>
          <p className="m-0 text-[15px] text-clay-deep">{error}</p>
        </Section>
      ) : (
        <Section>
          <NewItemsList initial={items} />
        </Section>
      )}
    </>
  );
}
