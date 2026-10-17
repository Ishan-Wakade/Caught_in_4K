"use client";

import Link from "next/link";
import { Fragment, useState } from "react";
import { useResource } from "@/hooks/useResource";
import { api } from "@/lib/api";
import { BIN_HEX, BIN_LABEL, cap, scoreLabel } from "@/lib/format";
import type { BinType, Business, CatalogItem, ItemSummary } from "@/lib/types";
import { BinTag, Empty, LoadError } from "@/components/ui";

const NEW: CatalogItem = {
  catalog_item_id: "",
  name: "",
  business_id: null,
  reference_photos: [],
  branding_text: [],
  correct_destination: "recycling",
  condition_rule: null,
  volume_ml: 500,
  volume_source: "assumption",
};

const input = "min-h-11 rounded-xl border border-rule bg-white px-3 text-base text-ink";

function Field({ label, htmlFor, hint, children, className = "" }: { label: string; htmlFor?: string; hint?: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`flex flex-col gap-1 ${className}`}>
      <label htmlFor={htmlFor} className="text-[13px] font-bold">{label}</label>
      {children}
      {hint && <span className="text-xs text-muted-2">{hint}</span>}
    </div>
  );
}

function EditForm({ initial, isNew, businesses, onClose, onSaved }: { initial: CatalogItem; isNew: boolean; businesses: Business[]; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState(initial);
  const [photos, setPhotos] = useState(initial.reference_photos.join("\n"));
  const [branding, setBranding] = useState(initial.branding_text.join(", "));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = <K extends keyof CatalogItem>(k: K, v: CatalogItem[K]) => setF((p) => ({ ...p, [k]: v }));
  const photoList = photos.split("\n").map((s) => s.trim()).filter(Boolean);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!f.catalog_item_id.trim() || !f.name.trim()) return setErr("Give the item an ID and a name.");
    setBusy(true);
    setErr(null);
    try {
      await api.saveCatalogItem({
        ...f,
        catalog_item_id: f.catalog_item_id.trim(),
        name: f.name.trim(),
        condition_rule: f.condition_rule?.trim() || null,
        reference_photos: photoList,
        branding_text: branding.split(",").map((s) => s.trim()).filter(Boolean),
      });
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={save}
      aria-labelledby="edit-h"
      className="flex min-w-0 max-w-2xl flex-col gap-3.5 rounded-3xl bg-card px-[22px] py-5 shadow-[0_2px_4px_rgba(70,60,35,0.04),0_14px_36px_rgba(70,60,35,0.10)]"
    >
      <div className="flex items-end justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <span className="text-xs text-muted">{isNew ? "Adding" : "Editing"}</span>
          <h2 id="edit-h" className="m-0 font-display text-[26px] leading-[1.1] font-bold">{isNew ? "New packaging" : initial.name}</h2>
        </div>
        {!isNew && <Link href={`/items/${initial.catalog_item_id}`} className="flex min-h-9 items-center text-sm font-bold">View details →</Link>}
      </div>

      {isNew && (
        <Field label="Item ID" htmlFor="cat-id" hint="Lowercase, no spaces, e.g. item_beanco_lid">
          <input id="cat-id" className={input} value={f.catalog_item_id} onChange={(e) => set("catalog_item_id", e.target.value)} />
        </Field>
      )}

      <div className="flex flex-wrap gap-3">
        <Field label="Item name" htmlFor="cat-name" className="flex-[1_1_170px]">
          <input id="cat-name" className={input} value={f.name} onChange={(e) => set("name", e.target.value)} />
        </Field>
        <Field label="Restaurant" htmlFor="cat-rest" className="flex-[1_1_150px]">
          <select id="cat-rest" className={input} value={f.business_id ?? ""} onChange={(e) => set("business_id", e.target.value || null)}>
            <option value="">None (generic packaging)</option>
            {businesses.map((b) => (
              <option key={b.business_id} value={b.business_id}>{b.name}</option>
            ))}
          </select>
        </Field>
      </div>

      <fieldset className="m-0 flex flex-col gap-1 border-0 p-0">
        <legend className="pb-1.5 text-[13px] font-bold">Belongs in</legend>
        <div className="flex flex-wrap gap-2">
          {(Object.keys(BIN_LABEL) as BinType[]).map((t) => {
            const on = f.correct_destination === t;
            return (
              <label
                key={t}
                className="flex min-h-[46px] flex-[1_1_110px] cursor-pointer items-center gap-2.5 rounded-[14px] px-3.5 text-[15px] font-bold"
                style={{ background: on ? BIN_HEX[t].body : "#F3EEE4", color: BIN_HEX[t].ink }}
              >
                <input type="radio" name="cat-bin" checked={on} onChange={() => set("correct_destination", t)} className="m-0 h-[18px] w-[18px] accent-forest" />
                <span className="h-[9px] w-[9px] rounded-full" style={{ background: BIN_HEX[t].fill }} />
                {BIN_LABEL[t]}
              </label>
            );
          })}
        </div>
      </fieldset>

      <Field label="Only if… (optional)" htmlFor="cat-rule" hint="A condition under the site's rules, e.g. “Compost only when emptied of liquid”. Drops of items with a condition aren't scored yet.">
        <input id="cat-rule" className={input} value={f.condition_rule ?? ""} onChange={(e) => set("condition_rule", e.target.value)} />
      </Field>

      <div className="flex flex-wrap gap-3">
        <Field label="Size" htmlFor="cat-vol" className="flex-[0_1_140px]">
          <div className="flex items-center gap-2">
            <input id="cat-vol" type="number" min={1} className={`${input} w-[100px] font-mono`} value={f.volume_ml} onChange={(e) => set("volume_ml", Number(e.target.value))} />
            <span>ml</span>
          </div>
        </Field>
        <Field label="Where the size came from" htmlFor="cat-vsrc" className="flex-[1_1_200px]">
          <input id="cat-vsrc" className={input} value={f.volume_source} onChange={(e) => set("volume_source", e.target.value)} />
        </Field>
      </div>
      <p className="-mt-1.5 mb-0 text-[13px] leading-snug text-muted">Sizes are used to estimate how full each bin is.</p>

      <Field label="Printed text or logo" htmlFor="cat-brand" hint="Comma-separated. Helps the camera tell restaurants' packaging apart.">
        <input id="cat-brand" className={input} value={branding} onChange={(e) => setBranding(e.target.value)} />
      </Field>

      <div className="flex flex-col gap-1.5">
        <span className="text-[13px] font-bold">
          Camera stills used for matching <span className="font-normal text-muted-2">· real crops, not illustrations</span>
        </span>
        {photoList.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {photoList.map((u) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={u} src={u} alt="" className="h-16 w-16 rounded-xl bg-[#4A5044] object-cover" />
            ))}
          </div>
        )}
        <textarea
          aria-label="Photo URLs, one per line"
          className="min-h-16 rounded-xl border border-rule bg-white px-3 py-2 font-mono text-[13px]"
          placeholder="Photo URLs, one per line (upload isn't available yet)"
          value={photos}
          onChange={(e) => setPhotos(e.target.value)}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2.5 pt-1">
        <button disabled={busy} className="min-h-12 cursor-pointer rounded-[14px] bg-forest px-[22px] text-base font-bold text-white disabled:opacity-50">
          {isNew ? "Add item" : "Save changes"}
        </button>
        <button type="button" onClick={onClose} className="min-h-12 cursor-pointer rounded-[14px] bg-transparent px-[18px] text-base font-bold text-forest">
          Discard
        </button>
        {err && <span className="text-sm text-clay-deep">{err}</span>}
      </div>
      <p className="m-0 text-xs text-muted-2">The camera worker picks up catalog changes the next time it starts.</p>
    </form>
  );
}

export default function CatalogPage() {
  const catalog = useResource(api.catalog);
  const items = useResource(api.items);
  const [editing, setEditing] = useState<{ item: CatalogItem; isNew: boolean } | null>(null);

  if (catalog.error && !catalog.data) return <LoadError error={catalog.error} />;
  if (!catalog.data) return <Empty title="Loading the catalog…" />;

  const scores = new Map((items.data?.items ?? []).map((i) => [i.catalog_item_id, i] as [string, ItemSummary]));
  const bizName = new Map(catalog.data.businesses.map((b) => [b.business_id, b.name]));
  // One flat, sortable sheet — restaurant is a column, not a grouping.
  const rows = [...catalog.data.items].sort((a, b) => {
    const an = (a.business_id && bizName.get(a.business_id)) || "￿";
    const bn = (b.business_id && bizName.get(b.business_id)) || "￿";
    return an === bn ? a.name.localeCompare(b.name) : an.localeCompare(bn);
  });

  const closeEdit = () => setEditing(null);
  const onSaved = () => {
    setEditing(null);
    catalog.reload();
    items.reload();
  };

  return (
    <div className="mx-auto box-border flex w-full max-w-[1600px] flex-1 flex-col gap-4 px-10 pt-4 pb-[22px]">
      <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-2.5">
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <h1 className="m-0 font-display text-[40px] leading-none font-extrabold">Catalog</h1>
          <span className="text-[15px] text-muted">
            {catalog.data.items.length} kinds of packaging across {catalog.data.businesses.length} restaurants
          </span>
        </div>
        <button
          onClick={() => setEditing({ item: { ...NEW }, isNew: true })}
          className="min-h-[46px] cursor-pointer rounded-[14px] bg-forest px-[22px] text-base font-bold text-white"
        >
          Add item
        </button>
      </div>

      <div className="min-w-0 flex-1 overflow-x-auto">
        <table className="w-full min-w-[720px] border-collapse text-base">
          <thead>
            <tr className="text-left">
              <th scope="col" className="border-b border-[#CFC5B1] pr-3 pb-1.5 text-xs font-medium text-muted">Item</th>
              <th scope="col" className="border-b border-[#CFC5B1] px-3 pb-1.5 text-xs font-medium text-muted">Restaurant</th>
              <th scope="col" className="border-b border-[#CFC5B1] px-3 pb-1.5 text-xs font-medium text-muted">Belongs in</th>
              <th scope="col" className="border-b border-[#CFC5B1] px-3 pb-1.5 text-right text-xs font-medium text-muted">Sorted correctly</th>
              <th scope="col" className="border-b border-[#CFC5B1] pb-1.5 pl-3 text-right text-xs font-medium text-muted">Drops</th>
            </tr>
          </thead>
          <tbody>
            {editing?.isNew && (
              <tr>
                <td colSpan={5} className="py-3">
                  <EditForm key="new" initial={editing.item} isNew businesses={catalog.data.businesses} onClose={closeEdit} onSaved={onSaved} />
                </td>
              </tr>
            )}
            {rows.map((c, i) => {
              const on = editing !== null && !editing.isNew && editing.item.catalog_item_id === c.catalog_item_id;
              const s = scores.get(c.catalog_item_id);
              const below = s && s.score.status === "ok" && s.score.percent < s.threshold_percent;
              const restaurant = c.business_id ? bizName.get(c.business_id) : undefined;
              const name = restaurant ? cap(c.name.replace(`${restaurant} `, "")) : c.name;
              return (
                <Fragment key={c.catalog_item_id}>
                  <tr
                    aria-selected={on || undefined}
                    onClick={() => setEditing(on ? null : { item: structuredClone(c), isNew: false })}
                    className={`cursor-pointer ${on ? "bg-sage" : "hover:bg-paper-deep"} ${i || editing?.isNew ? "border-t border-rule-soft" : ""}`}
                  >
                    <td className="py-[9px] pr-3 pl-3">
                      <button type="button" className={`cursor-pointer text-left ${on ? "font-bold text-forest-deep" : "text-ink"}`}>
                        {name}
                      </button>
                      {on && <span className="text-xs text-forest"> · editing</span>}
                      {c.condition_rule && <span className="block text-xs text-muted-2">only if: {c.condition_rule}</span>}
                    </td>
                    <td className="px-3 py-[9px] text-ink-2">{restaurant ?? <span className="text-muted">Generic</span>}</td>
                    <td className="px-3 py-[9px]"><BinTag type={c.correct_destination} /></td>
                    <td className={`px-3 py-[9px] text-right font-mono text-sm ${below ? "font-bold text-clay-deep" : ""}`}>{s ? scoreLabel(s.score) : "—"}</td>
                    <td className="py-[9px] pr-3 pl-3 text-right font-mono text-sm">{s?.assessed_count ?? 0}</td>
                  </tr>
                  {on && (
                    <tr>
                      <td colSpan={5} className="bg-sage/30 py-3">
                        <EditForm key={c.catalog_item_id} initial={editing!.item} isNew={false} businesses={catalog.data!.businesses} onClose={closeEdit} onSaved={onSaved} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
