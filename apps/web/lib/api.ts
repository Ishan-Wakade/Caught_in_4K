/**
 * Typed client for I's `/api/*` routes (contract §2), returning UI view models.
 * NEXT_PUBLIC_DATA_SOURCE=api calls the real routes and converts core's
 * responses in `adapters/core.ts`; `mock` (default) uses the in-browser
 * MockBackend so the dashboard runs without a backend.
 */
import { DATA_SOURCE } from "./config";
import { MockBackend } from "./mock/backend";
import type { CatalogItem as ContractCatalogItem, ItemDetail as ContractItemDetail, ItemSummary as ContractItemSummary } from "@recyclone/contracts";
import * as core from "./adapters/core";
import type {
  AlertsResponse,
  BinsResponse,
  CatalogItem,
  CatalogResponse,
  FeedResponse,
  ItemDetail,
  ItemsResponse,
  MockReply,
  ReviewDecision,
  ReviewsResponse,
} from "./types";

let mock: MockBackend | null = null;
function mockBackend(): MockBackend {
  mock ??= new MockBackend();
  return mock;
}

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
    cache: "no-store",
  });
  const text = await res.text();
  if (!res.ok) {
    let detail = "";
    try {
      detail = (JSON.parse(text) as { error?: string }).error ?? "";
    } catch {}
    throw new Error(`${init?.method ?? "GET"} ${path} → ${res.status}${detail ? `: ${detail}` : ""}`);
  }
  return (text ? JSON.parse(text) : undefined) as T;
}

const post = <T,>(path: string, body: unknown) => http<T>(path, { method: "POST", body: JSON.stringify(body) });

// Core's catalog is needed to name things in several responses; cache it briefly.
let catalogCache: { at: number; items: Promise<CatalogItem[]> } | null = null;
function coreCatalog(): Promise<CatalogItem[]> {
  if (!catalogCache || Date.now() - catalogCache.at > 5000) {
    catalogCache = { at: Date.now(), items: http<ContractCatalogItem[]>("/api/catalog").then((r) => r.map(core.fromContractCatalog)) };
    catalogCache.items.catch(() => (catalogCache = null));
  }
  return catalogCache.items;
}

const useMock = DATA_SOURCE === "mock";

export const api = {
  source: DATA_SOURCE,

  feed: async (after: string | null): Promise<FeedResponse> =>
    useMock
      ? mockBackend().feed(after)
      : core.adaptFeed(await http(`/api/feed${after ? `?after=${encodeURIComponent(after)}` : ""}`), after),

  bins: async (): Promise<BinsResponse> =>
    useMock ? mockBackend().bins() : core.adaptBins(await http("/api/bins")),

  items: async (): Promise<ItemsResponse> => {
    if (useMock) return mockBackend().items();
    const list = await http<ContractItemSummary[]>("/api/items");
    // The list has no interventions; fetch details for items with drops (few in a demo site).
    const details = await Promise.all(
      list.filter((i) => i.assessed_count > 0).map((i) => http<ContractItemDetail>(`/api/items/${encodeURIComponent(i.catalog_item_id)}`)),
    );
    return core.adaptItems(list, new Map(details.map((d) => [d.catalog_item_id, d])));
  },

  item: async (id: string): Promise<ItemDetail | null> => {
    if (useMock) return mockBackend().item(id);
    try {
      return core.adaptItem(await http(`/api/items/${encodeURIComponent(id)}`));
    } catch (e) {
      if (e instanceof Error && / → 404/.test(e.message)) return null;
      throw e;
    }
  },

  alerts: async (): Promise<AlertsResponse> => (useMock ? mockBackend().alertsList() : core.adaptAlerts(await http("/api/alerts"))),

  reviews: async (): Promise<ReviewsResponse> =>
    useMock ? mockBackend().reviews() : core.adaptReviews(await http("/api/reviews"), await coreCatalog()),

  decideReview: async (eventId: string, decision: ReviewDecision): Promise<void> => {
    if (useMock) return mockBackend().decideReview(eventId, decision);
    await post(`/api/reviews/${encodeURIComponent(eventId)}`, {
      business_id: decision.action === "assign" ? decision.business_id : null,
    });
  },

  catalog: async (): Promise<CatalogResponse> =>
    useMock ? mockBackend().catalog() : { items: await coreCatalog(), businesses: core.adaptCatalog([]).businesses },

  saveCatalogItem: async (item: CatalogItem): Promise<void> => {
    if (useMock) return mockBackend().saveCatalogItem(item);
    await post("/api/catalog", core.toContractCatalog(item));
    catalogCache = null;
  },

  /** S's route; same path as a real Photon reply (contract §6). */
  mockReply: async (reply: MockReply): Promise<void> => {
    if (useMock) return mockBackend().mockReply(reply);
    await post("/api/photon/mock-reply", reply);
  },

  resetDemo: async (): Promise<void> => {
    if (useMock) return mockBackend().reset();
    await post("/api/demo/reset", {});
  },
};
