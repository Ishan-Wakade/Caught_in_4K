"use client";

import { useMemo } from "react";
import { useFeed } from "./useFeed";
import { useResource } from "./useResource";
import { api } from "@/lib/api";
import { outcomeOf } from "@/lib/format";
import { binTypeOf, businessName } from "@/lib/site";
import type { BinType, Outcome } from "@/lib/types";

export type Disposal = {
  cursor: string;
  at: string;
  event_id: string | null;
  item_id: string | null;
  /** Catalog name, or the detector's free-text label when the item wasn't identified. */
  item_name: string;
  identified: boolean;
  business_name: string | null;
  bin: BinType | null;
  belongs_in: BinType | null;
  outcome: Outcome | null;
  /** Origin unclear: queued for the area manager. */
  in_review: boolean;
  labeled: boolean;
};

/** Disposals from the feed, newest first, joined with the catalog for names and correct bins. */
export function useDisposals(): Disposal[] {
  const { items } = useFeed();
  const catalog = useResource(api.catalog);
  return useMemo(() => {
    const byId = new Map((catalog.data?.items ?? []).map((c) => [c.catalog_item_id, c]));
    const queued = new Set(items.filter((i) => i.type === "review_queued").map((i) => i.ref.event_id));
    const resolved = new Set(items.filter((i) => i.type === "review_resolved").map((i) => i.ref.event_id));
    return items
      .filter((i) => i.type === "disposal")
      .map((i) => {
        const cat = i.ref.item_id ? byId.get(i.ref.item_id) : undefined;
        const fallback = i.summary.split("→")[0].trim();
        return {
          cursor: i.cursor,
          at: i.at,
          event_id: i.ref.event_id ?? null,
          item_id: i.ref.item_id ?? null,
          item_name: cat?.name ?? fallback,
          identified: Boolean(cat),
          business_name: businessName(cat?.business_id),
          bin: binTypeOf(i.ref.bin_id),
          belongs_in: cat?.correct_destination ?? null,
          outcome: outcomeOf(i),
          in_review: Boolean(i.ref.event_id && queued.has(i.ref.event_id) && !resolved.has(i.ref.event_id)),
          labeled: i.source_mode === "labeled",
        };
      })
      .reverse();
  }, [items, catalog.data]);
}
