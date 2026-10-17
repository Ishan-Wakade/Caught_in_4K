/**
 * Converts the API's responses into the UI's view models.
 *
 * Core (owner I) returns the contract DTOs from `@recyclone/contracts`
 * (`contracts/src/api.ts`). The contract leaves out a few things the screens
 * show (business and contact names, per-item bin counts, interventions on the
 * item list), so names come from the site fixture (`lib/site.ts`) and the rest
 * is filled in by `lib/api.ts` or the pages.
 */
import type {
  AlertSummary,
  BinSummary,
  CatalogItem as ContractCatalogItem,
  FeedResponse as ContractFeed,
  ItemDetail as ContractItemDetail,
  ItemSummary as ContractItemSummary,
  ReviewItem as ContractReviewItem,
} from "@recyclone/contracts";
import { outcomeOf } from "../format";
import { binCameraId, businessName, contactInfo, SITE, SITE_INFO, stationName } from "../site";
import type {
  Alert,
  AlertMessage,
  AlertsResponse,
  BinsResponse,
  CatalogItem,
  CatalogResponse,
  FeedResponse,
  ItemDetail,
  ItemSummary,
  ItemsResponse,
  Period,
  ReviewItem,
  ReviewsResponse,
  Score,
} from "../types";

// ---- feed --------------------------------------------------------------------

export function adaptFeed(r: ContractFeed, after: string | null): FeedResponse {
  return {
    items: r.items.map((i) => ({
      ...i,
      outcome: i.type === "disposal" ? (outcomeOf(i) ?? undefined) : undefined,
      // Core marks these in the summary text rather than with fields.
      source_mode: /\[labeled backup input\]/i.test(i.summary) ? "labeled" : undefined,
      mocked: /\(mocked\)/i.test(i.summary) || undefined,
    })),
    cursor: r.next_cursor || after,
    demo: r.items.some((i) => i.demo),
  };
}

// ---- bins --------------------------------------------------------------------

export function adaptBins(r: BinSummary[]): BinsResponse {
  return {
    bins: r.map((b) => {
      const site = SITE.bins.find((s) => s.bin_id === b.bin_id);
      // Core's estimate includes the site file's assumed starting contents until the first emptying.
      const assumed = b.last_emptied_at ? 0 : (site?.initial_volume_l ?? 0);
      return {
        bin_id: b.bin_id,
        name: b.name,
        station_id: b.station_id,
        station_name: stationName(b.station_id),
        camera_id: binCameraId(b.bin_id),
        type: b.type,
        capacity_l: b.capacity_l,
        estimated_fullness: b.estimated_fullness,
        estimated_volume_l: b.estimated_volume_l,
        fullness_threshold: SITE_INFO.fullness_threshold ?? 0.8,
        // The contract carries only a total; the Bins page fills per-item counts from the feed.
        observed_counts: [],
        observed_total: b.observed_count,
        unknown_count: b.unknown_count,
        initial_contents_known: true,
        assumed_initial_l: assumed,
        illustration: b.illustration,
        last_emptied_at: b.last_emptied_at,
      };
    }),
  };
}

// ---- items -------------------------------------------------------------------

const score = (pct: number | null): Score => (pct === null ? { status: "insufficient_data" } : { status: "ok", percent: pct });

type ContractPeriod = ContractItemDetail["interventions"][number]["before"];
const period = (p: ContractPeriod): Period => ({
  from: p.from,
  to: p.to,
  assessed_count: p.assessed_count,
  score: score(p.correct_sorting_pct),
});

function summary(c: ContractItemSummary, interventions: ContractItemDetail["interventions"] = []): ItemSummary {
  return {
    catalog_item_id: c.catalog_item_id,
    name: c.name,
    business_id: c.business_id,
    business_name: businessName(c.business_id),
    correct_destination: c.destination,
    score: score(c.correct_sorting_pct),
    assessed_count: c.assessed_count,
    threshold_percent: SITE_INFO.threshold_percent ?? 60,
    min_assessed: SITE.config_profiles.demo.min_assessed_events,
    interventions: interventions.map((i) => ({
      intervention_id: i.intervention_id,
      alert_id: "",
      action: i.action,
      confirmed_at: i.confirmed_at,
      before: period(i.before),
      after: period(i.after),
    })),
  };
}

/** The list endpoint has no interventions; pass details (by id) when they were fetched. */
export function adaptItems(r: ContractItemSummary[], details: Map<string, ContractItemDetail> = new Map()): ItemsResponse {
  return { items: r.map((c) => summary(c, details.get(c.catalog_item_id)?.interventions)) };
}

export function adaptItem(c: ContractItemDetail): ItemDetail {
  return {
    ...summary(c, c.interventions),
    stations: c.by_station.map((s) => ({
      station_id: s.station_id,
      station_name: stationName(s.station_id),
      assessed_count: s.assessed_count,
      correct_count: s.correct_count,
    })),
  };
}

// ---- catalog -----------------------------------------------------------------

export function fromContractCatalog(c: ContractCatalogItem): CatalogItem {
  const { destination, ...rest } = c;
  return { ...rest, correct_destination: destination };
}

export function toContractCatalog(c: CatalogItem): ContractCatalogItem {
  const { correct_destination, ...rest } = c;
  return { ...rest, destination: correct_destination };
}

export function adaptCatalog(r: ContractCatalogItem[]): CatalogResponse {
  return { items: r.map(fromContractCatalog), businesses: SITE.businesses };
}

// ---- alerts ------------------------------------------------------------------

/** Core prefixes outbound bodies with "[alert_id] " for reply matching; hide it in the UI. */
const stripPrefix = (body: string) => body.replace(/^\[[^\]]+\]\s*/, "");

function alertState(a: AlertSummary): Alert["state"] {
  switch (a.state) {
    case "open":
    case "sent":
      return "sent";
    case "closed":
      return a.kind === "emptying" ? "emptied" : "action_confirmed";
    default:
      return a.state;
  }
}

/** First sentence of core's alert text, e.g. "Bean Co. clear cold cup: 33.3% correctly sorted across 3 assessed disposals (3 recent)". */
function trigger(body: string): string {
  const m = body.match(/^.*?\)\./) ?? body.match(/^[^.]*\./);
  return (m?.[0] ?? body).replace(/\.$/, "");
}

export function adaptAlerts(r: AlertSummary[]): AlertsResponse {
  let anyMocked = false;
  const alerts: Alert[] = r.map((a) => {
    const info = contactInfo(a.contact_id);
    const messages: AlertMessage[] = a.messages.map((m) => {
      if (m.mocked) anyMocked = true;
      return {
        message_id: m.message_id,
        direction: m.direction,
        kind: m.kind === "reply" ? undefined : m.kind,
        body: stripPrefix(m.body),
        at: m.at,
        mocked: m.mocked,
      };
    });
    return {
      alert_id: a.alert_id,
      kind: a.kind,
      state: alertState(a),
      opened_at: a.opened_at,
      trigger: trigger(a.trigger),
      item_id: a.item_id ?? undefined,
      bin_id: a.bin_id ?? undefined,
      contact: { contact_id: a.contact_id, ...info },
      business_name: businessName(info.business_id),
      messages,
    };
  });
  alerts.sort((x, y) => y.opened_at.localeCompare(x.opened_at));
  return { alerts, messenger_mocked: anyMocked };
}

// ---- reviews -----------------------------------------------------------------

export function adaptReviews(r: ContractReviewItem[], catalog: CatalogItem[]): ReviewsResponse {
  const byId = new Map(catalog.map((c) => [c.catalog_item_id, c]));
  return {
    reviews: r.map((e) => {
      const candidates = new Map<string, { business_id: string; name: string; score: number }>();
      const add = (id: string | null | undefined, s: number | null | undefined) => {
        if (!id || s == null) return;
        const prev = candidates.get(id);
        if (!prev || prev.score < s) candidates.set(id, { business_id: id, name: businessName(id) ?? id, score: s });
      };
      add(e.business.business_id, e.business.confidence);
      for (const c of e.item.candidates) add(byId.get(c.catalog_item_id)?.business_id, c.score);
      return {
        event_id: e.event_id,
        occurred_at: e.occurred_at,
        bin_id: e.bin_id,
        item_name: (e.item.catalog_item_id && byId.get(e.item.catalog_item_id)?.name) || e.item.label,
        item: e.item,
        business_candidates: [...candidates.values()].sort((a, b) => b.score - a.score),
        evidence: e.evidence,
        status: e.status,
        resolved_business_id: e.assigned_business_id,
      } satisfies ReviewItem;
    }),
  };
}
