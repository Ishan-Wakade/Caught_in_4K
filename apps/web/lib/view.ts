/**
 * View models: the shapes the screens render.
 *
 * They are not wire types. API responses are converted into these in
 * `lib/adapters/core.ts` (real backend) or produced directly by the mock in
 * `lib/mock/`. When core's responses change (for example to match the
 * contract DTOs in `@recyclone/contracts`), only the adapter changes.
 *
 * App code imports from `@/lib/types`.
 */

// ---- shared primitives -----------------------------------------------------

export type BinType = "trash" | "recycling" | "compost";
export type SourceMode = "recorded" | "live" | "labeled";

// ---- §1 DisposalEvent (worker → core) -------------------------------------

export type Evidence = { kind: "crop" | string; uri: string; frame?: number };

export type DisposalEvent = {
  event_id: string;
  source: { camera_id: string; clip_id: string; track_id: number | null; mode: SourceMode };
  bin_id: string;
  occurred_at: string;
  clip_offset_s?: number;
  destination_confidence: number;
  item: {
    catalog_item_id: string | null;
    label: string | null;
    confidence: number | null;
    candidates: { catalog_item_id: string; score: number }[];
  };
  business: { business_id: string | null; confidence: number | null; basis: string[] } | null;
  evidence: Evidence[];
};

// ---- §3 Feed items (core → web) -------------------------------------------

export type FeedItemType =
  | "disposal"
  | "alert_opened"
  | "message_sent"
  | "reply_received"
  | "intervention_recorded"
  | "bin_emptied"
  | "illustration_ready"
  | "review_queued"
  | "review_resolved";

/** Classification core assigns to a disposal. */
export type Outcome = "correct" | "incorrect" | "unassessable";

export type FeedItem = {
  cursor: string;
  at: string;
  type: FeedItemType;
  ref: { event_id?: string; alert_id?: string; bin_id?: string; item_id?: string };
  summary: string;
  demo: boolean;
  /** Outcome for `disposal` items (parsed from `summary` when the API doesn't send it). */
  outcome?: Outcome;
  /** The event's `source.mode`, when known, to show the "labeled backup input" label. */
  source_mode?: SourceMode;
  /** True when the item came from a mocked integration (message or illustration). */
  mocked?: boolean;
};

export type FeedResponse = { items: FeedItem[]; cursor: string | null; demo: boolean };

// ---- Catalog / site -------------------------------------------------------

export type CatalogItem = {
  catalog_item_id: string;
  name: string;
  business_id: string | null;
  reference_photos: string[];
  branding_text: string[];
  correct_destination: BinType;
  condition_rule: string | null;
  volume_ml: number;
  volume_source: string;
};

export type Business = { business_id: string; name: string };

export type CatalogResponse = { items: CatalogItem[]; businesses: Business[] };

// ---- Bins -----------------------------------------------------------------

export type Illustration = {
  image_url: string;
  generated_at: string;
  snapshot_id: string;
  snapshot_taken_at: string;
  mocked: boolean;
};

export type BinStatus = {
  bin_id: string;
  name: string;
  station_id: string;
  station_name: string;
  camera_id: string;
  type: BinType;
  capacity_l: number;
  /** 0..1 (may exceed 1). Always an estimate. */
  estimated_fullness: number;
  estimated_volume_l: number;
  fullness_threshold: number;
  observed_counts: { catalog_item_id: string | null; name: string; count: number }[];
  unknown_count: number;
  /** Total items seen since the last emptying, when per-item counts aren't available. */
  observed_total?: number;
  /** False when nothing is known about what was in the bin before monitoring began. */
  initial_contents_known: boolean;
  /** Litres assumed to be in the bin when monitoring began (included in the estimate); 0 if none. */
  assumed_initial_l: number;
  illustration: Illustration | null;
  last_emptied_at: string | null;
};

export type BinsResponse = { bins: BinStatus[] };

// ---- Items ----------------------------------------------------------------

export type Score = { status: "ok"; percent: number } | { status: "insufficient_data" };

export type ItemSummary = {
  catalog_item_id: string;
  name: string;
  business_id: string | null;
  business_name: string | null;
  correct_destination: BinType;
  score: Score;
  assessed_count: number;
  threshold_percent: number;
  min_assessed: number;
  interventions: Intervention[];
};

export type Period = { from: string; to: string; assessed_count: number; score: Score };

export type Intervention = {
  intervention_id: string;
  alert_id: string;
  action: string;
  confirmed_at: string;
  before: Period;
  after: Period;
};

export type ItemDetail = ItemSummary & {
  stations: { station_id: string; station_name: string; assessed_count: number; correct_count: number }[];
};

export type ItemsResponse = { items: ItemSummary[] };

// ---- Alerts ---------------------------------------------------------------

export type AlertKind = "recommendation" | "emptying";
export type AlertState =
  | "sent"
  | "follow_up_sent"
  | "acknowledged"
  | "action_confirmed"
  | "emptied"
  | "needs_clarification";

export type AlertMessage = {
  message_id: string;
  direction: "outbound" | "inbound";
  kind?: "recommendation" | "follow_up" | "emptying_request" | "clarification";
  body: string;
  at: string;
  mocked: boolean;
};

export type Alert = {
  alert_id: string;
  kind: AlertKind;
  state: AlertState;
  opened_at: string;
  /** Human-readable trigger, e.g. "cup score 40% < 60%, 5 assessed events". */
  trigger: string;
  item_id?: string;
  bin_id?: string;
  contact: { contact_id: string; name: string; role: string; business_id?: string | null };
  business_name?: string | null;
  messages: AlertMessage[];
};

/** `messenger_mocked` decides whether the mock reply box is shown. */
export type AlertsResponse = { alerts: Alert[]; messenger_mocked: boolean };

// ---- Reviews --------------------------------------------------------------

export type ReviewItem = {
  event_id: string;
  occurred_at: string;
  bin_id: string;
  item_name: string | null;
  item: DisposalEvent["item"];
  business_candidates: { business_id: string; name: string; score: number }[];
  evidence: Evidence[];
  status: "pending" | "resolved" | "left_unresolved";
  resolved_business_id?: string | null;
};

export type ReviewsResponse = { reviews: ReviewItem[] };

export type ReviewDecision = { action: "assign"; business_id: string } | { action: "leave_unresolved" };

/** Body of `POST /api/photon/mock-reply` (contract §6). */
export type MockReply = { contactId: string; body: string };

// ---- Site settings shown in the UI -----------------------------------------

export type SiteInfo = {
  site_name: string;
  /** Correct-sorting goal (percent) for the active profile, or null when not configured. */
  threshold_percent: number | null;
  fullness_threshold: number | null;
};
