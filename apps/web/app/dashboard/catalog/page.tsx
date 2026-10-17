"use client";

import { Section, Swatch } from "@/components/dashboard/charts";
import { CATALOG, DEST_LABEL, type Destination } from "@/lib/dashboard/sample";

export default function CatalogPage() {
  return (
    <>
      <div className="flex flex-col gap-2">
        <h1 className="m-0 font-display text-[40px] leading-none font-bold">Catalog</h1>
        <span className="text-[15px] text-ink-2">Bins follow City of Cambridge, MA rules (2022/23 guide).</span>
      </div>
      <div className="grid gap-6 md:grid-cols-3">
        {(["recycle", "compost", "trash"] as Destination[]).map((d) => (
          <Section key={d} title={DEST_LABEL[d]}>
            <ul className="m-0 flex list-none flex-col divide-y divide-rule-soft p-0">
              {CATALOG.filter((c) => c.dest === d).map((c) => (
                <li key={c.id} className="flex flex-col py-2" title={c.basis}>
                  <span className="flex items-center gap-2.5 text-[15px] text-ink">
                    <Swatch dest={d} />
                    {c.name}
                  </span>
                </li>
              ))}
            </ul>
          </Section>
        ))}
      </div>
    </>
  );
}
