/**
 * Converts core's current API responses (packages/core, owner I) into the UI's
 * view models. Core does not yet return the contract DTOs from
 * `@recyclone/contracts` (`src/api.ts`); when it does, only this file changes.
 *
 * The wire types below describe what core actually returns today (read from
 * packages/core/src/core.ts and metrics.ts, and checked against a running API).
 */
import { outcomeOf } from "../format";
import { businessName, contactInfo, SITE, SITE_INFO, stationName, binCameraId } from "../site";
import type {
  Alert,
  AlertMessage,
  AlertsResponse,
  BinStatus,
  BinType,
  BinsResponse,
  CatalogItem,
  CatalogResponse,
  FeedItem,
  FeedResponse,
  ItemDetail,
  ItemSummary,
  ItemsResponse,
  Period,
  ReviewItem,
  ReviewsResponse,
  Score,
  DisposalEvent,
} from "../types";

// ---- core wire types (current, not the contract DTOs) -----------------------

type CoreFeed = {
  items: (Omit<FeedItem, "outcome" | "source_mode">)[];
  cursor?: string;
  next_cursor?: string;
  demo: boolean;
};

type CoreBin = {
  bin_id: string;
  station_id: string;
  name: string;
  type: BinType;
  capacity_l: number;
  estimated_volume_ml: number;
  estimated_fullness: number;
  observed_count: number;
  unknown_content_count: number;
  initial_contents_known: boolean;
  last_confirmed_emptying: { emptied_at: string } | null;
  items: { name: string; count: number }[];
  illustration: {
    snapshot: { snapshotId: string; takenAt: string };
    result: { imageUrl: string; generatedAt: string; snapshotId: string; mocked: boolean };
  } | null;
};

type CoreMetric = {
  business_id: string | null;
  status: "assessed" | "insufficient_data";
  correct_sorting_percent: number | null;
  assessed_event_count: number;
  station_breakdown: { station_id: string; assessed_event_count: number; correct_event_count: number }[];
};

type CoreComparisonPeriod = { start: string; end: string; assessed_event_count: number; correct_sorting_percent: number | null };

type CoreItem = CatalogItem & {
  metrics: CoreMetric[];
  interventions: {
    intervention_id: string;
    alert_id: string;
    business_id: string;
    action: string;
    confirmed_at: string;
    comparison: { before: CoreComparisonPeriod; after: CoreComparisonPeriod };
  }[];
};

type CoreAlert = {
  alert_id: string;
  kind: "recommendation" | "emptying";
  item_id?: string;
  business_id?: string;
  bin_id?: string;
  contact: { contactId: string };
  state: "open" | "acknowledged" | "action_confirmed" | "resolved";
  created_at: string;
  body: string;
  messages: {
    message_id: string;
    body: string;
    direction: "outbound" | "inbound";
    at: string;
    mocked?: boolean;
    delivery_status?: string;
  }[];
};

type CoreReview = {
  raw: DisposalEvent;
  item_id: string | null;
  business_id: string | null;
  review_status: "pending" | "resolved" | "unresolved" | "not_required";
  reviewed_business_id?: string | null;
};

// ---- adapters -----------------------------------------------------------------

export function adaptFeed(r: CoreFeed, after: string | null): FeedResponse {
  return {
    items: r.items.map((i) => ({ ...i, outcome: i.type === "disposal" ? (outcomeOf(i) ?? undefined) : undefined })),
    cursor: r.next_cursor ?? r.cursor ?? after,
    demo: r.demo,
  };
}

export function adaptBins(r: CoreBin[], catalog: CatalogItem[]): BinsResponse {
  const idByName = new Map(catalog.map((c) => [c.name, c.catalog_item_id]));
  return {
    bins: r.map((b) => ({
      bin_id: b.bin_id,
      name: b.name,
      station_id: b.station_id,
      station_name: stationName(b.station_id),
      camera_id: binCameraId(b.bin_id),
      type: b.type,
      capacity_l: b.capacity_l,
      estimated_fullness: b.estimated_fullness,
      estimated_volume_l: b.estimated_volume_ml / 1000,
      fullness_threshold: SITE_INFO.fullness_threshold ?? 0.8,
      observed_counts: b.items.map((i) => ({ catalog_item_id: idByName.get(i.name) ?? null, name: i.name, count: i.count })),
      unknown_count: b.unknown_content_count,
      initial_contents_known: b.initial_contents_known,
      assumed_initial_l: 0,
      illustration: b.illustration && {
        image_url: b.illustration.result.imageUrl,
        generated_at: b.illustration.result.generatedAt,
        snapshot_id: b.illustration.result.snapshotId,
        snapshot_taken_at: b.illustration.snapshot.takenAt,
        mocked: b.illustration.result.mocked,
      },
      last_emptied_at: b.last_confirmed_emptying?.emptied_at ?? null,
    })),
  };
}

const score = (status: string, pct: number | null): Score =>
  status === "insufficient_data" || pct === null ? { status: "insufficient_data" } : { status: "ok", percent: pct };

const period = (p: CoreComparisonPeriod): Period => ({
  from: p.start,
  to: p.end,
  assessed_count: p.assessed_event_count,
  score: score("assessed", p.correct_sorting_percent),
});

/** Core keys metrics by item + attributed business; the item's own business is the headline. */
function headlineMetric(c: CoreItem): CoreMetric | undefined {
  return c.metrics.find((m) => m.business_id === c.business_id) ?? c.metrics[0];
}

function summary(c: CoreItem): ItemSummary {
  const m = headlineMetric(c);
  return {
    interventions: c.interventions.map((i) => ({
      intervention_id: i.intervention_id,
      alert_id: i.alert_id,
      action: i.action,
      confirmed_at: i.confirmed_at,
      before: period(i.comparison.before),
      after: period(i.comparison.after),
    })),
    catalog_item_id: c.catalog_item_id,
    name: c.name,
    business_id: c.business_id,
    business_name: businessName(c.business_id),
    correct_destination: c.correct_destination,
    score: m ? score(m.status, m.correct_sorting_percent) : { status: "insufficient_data" },
    assessed_count: m?.assessed_event_count ?? 0,
    threshold_percent: SITE_INFO.threshold_percent ?? 60,
    min_assessed: SITE.config_profiles.demo.min_assessed_events,
  };
}



export function adaptItems(r: CoreItem[]): ItemsResponse {
  return { items: r.map(summary) };
}

export function adaptItem(c: CoreItem): ItemDetail {
  const m = headlineMetric(c);
  return {
    ...summary(c),
    stations: (m?.station_breakdown ?? []).map((s) => ({
      station_id: s.station_id,
      station_name: stationName(s.station_id),
      assessed_count: s.assessed_event_count,
      correct_count: s.correct_event_count,
    })),
  };
}

export function adaptCatalog(r: CatalogItem[]): CatalogResponse {
  return { items: r, businesses: SITE.businesses };
}

/** Core prefixes outbound bodies with "[alert_id] " for reply matching; hide it in the UI. */
const stripPrefix = (body: string) => body.replace(/^\[[^\]]+\]\s*/, "");

function alertState(a: CoreAlert): Alert["state"] {
  if (a.state === "acknowledged") return "acknowledged";
  if (a.state === "action_confirmed") return "action_confirmed";
  if (a.state === "resolved") return a.kind === "emptying" ? "emptied" : "action_confirmed";
  const followedUp = a.messages.some((m) => m.direction === "outbound" && /^Following up:/.test(stripPrefix(m.body)));
  return followedUp ? "follow_up_sent" : "sent";
}

/** First sentence of core's alert body, e.g. "Bean Co. clear cold cup: 50.0% correctly sorted across 2 assessed disposals (2 recent)." */
function trigger(body: string): string {
  const m = body.match(/^.*?\)\./) ?? body.match(/^[^.]*\./);
  return (m?.[0] ?? body).replace(/\.$/, "");
}

export function adaptAlerts(r: CoreAlert[]): AlertsResponse {
  let anyMocked = false;
  const alerts: Alert[] = r.map((a) => {
    const info = contactInfo(a.contact.contactId);
    let first = true;
    const messages: AlertMessage[] = a.messages.map((m) => {
      const body = stripPrefix(m.body);
      if (m.mocked) anyMocked = true;
      let kind: AlertMessage["kind"];
      if (m.direction === "outbound") {
        if (/^Following up:/.test(body)) kind = "follow_up";
        else if (first) kind = a.kind === "emptying" ? "emptying_request" : "recommendation";
        else kind = "clarification";
        first = false;
      }
      return { message_id: m.message_id, direction: m.direction, kind, body, at: m.at, mocked: Boolean(m.mocked) };
    });
    return {
      alert_id: a.alert_id,
      kind: a.kind,
      state: alertState(a),
      opened_at: a.created_at,
      trigger: trigger(a.body),
      item_id: a.item_id,
      bin_id: a.bin_id,
      contact: { contact_id: a.contact.contactId, ...info },
      business_name: businessName(a.business_id ?? info.business_id),
      messages,
    };
  });
  // Newest first, like the mock.
  alerts.sort((x, y) => y.opened_at.localeCompare(x.opened_at));
  return { alerts, messenger_mocked: anyMocked };
}

export function adaptReviews(r: CoreReview[], catalog: CatalogItem[]): ReviewsResponse {
  const byId = new Map(catalog.map((c) => [c.catalog_item_id, c]));
  return {
    reviews: r.map((e) => {
      const candidates = new Map<string, { business_id: string; name: string; score: number }>();
      const add = (id: string | null | undefined, s: number | null | undefined) => {
        if (!id || s == null) return;
        const prev = candidates.get(id);
        if (!prev || prev.score < s) candidates.set(id, { business_id: id, name: businessName(id) ?? id, score: s });
      };
      add(e.raw.business?.business_id, e.raw.business?.confidence);
      for (const c of e.raw.item.candidates) add(byId.get(c.catalog_item_id)?.business_id, c.score);
      return {
        event_id: e.raw.event_id,
        occurred_at: e.raw.occurred_at,
        bin_id: e.raw.bin_id,
        item_name: (e.item_id && byId.get(e.item_id)?.name) || e.raw.item.label,
        item: e.raw.item,
        business_candidates: [...candidates.values()].sort((a, b) => b.score - a.score),
        evidence: e.raw.evidence,
        status: e.review_status === "unresolved" ? "left_unresolved" : e.review_status === "pending" ? "pending" : "resolved",
        resolved_business_id: e.reviewed_business_id,
      } satisfies ReviewItem;
    }),
  };
}
