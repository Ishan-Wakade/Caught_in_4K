import { z } from "zod";
import { BusinessGuessSchema, DestinationSchema, EvidenceSchema, ItemGuessSchema } from "./event.js";

const id = z.string().min(1);
const timestamp = z.iso.datetime({ offset: true });
const pct = z.number().min(0).max(100);

// ---- /api/feed (contracts/README.md §3) ----

export const FeedItemTypeSchema = z.enum([
  "disposal",
  "alert_opened",
  "message_sent",
  "reply_received",
  "intervention_recorded",
  "bin_emptied",
  "illustration_ready",
  "review_queued",
  "review_resolved",
]);

export const FeedItemSchema = z.object({
  /** Opaque, strictly increasing as strings. */
  cursor: id,
  at: timestamp,
  type: FeedItemTypeSchema,
  ref: z.object({ event_id: id, alert_id: id, bin_id: id, item_id: id }).partial(),
  summary: z.string(),
  demo: z.boolean(),
});

export const FeedResponseSchema = z.object({ items: z.array(FeedItemSchema), next_cursor: id });

// ---- /api/bins ----

export const IllustrationSchema = z.object({
  image_url: z.string().min(1),
  generated_at: timestamp,
  snapshot_id: id,
  /** Which inventory the image represents. */
  snapshot_taken_at: timestamp,
  mocked: z.boolean(),
});

export const BinSummarySchema = z.object({
  bin_id: id,
  name: z.string(),
  type: DestinationSchema,
  station_id: id,
  capacity_l: z.number().positive(),
  /** Estimated, not measured: estimated_volume_l / capacity_l. */
  estimated_fullness: z.number().min(0),
  estimated_volume_l: z.number().min(0),
  observed_count: z.int().min(0),
  unknown_count: z.int().min(0),
  last_emptied_at: timestamp.nullable(),
  illustration: IllustrationSchema.nullable(),
});

// ---- /api/items ----

const ItemSummaryShape = z.object({
  catalog_item_id: id,
  name: z.string(),
  business_id: id.nullable(),
  destination: DestinationSchema,
  /**
   * Null when there are no assessed events (never 0 for "no data"). An item can be
   * insufficient_data and still have a pct: it has data, just not enough to alert on.
   */
  correct_sorting_pct: pct.nullable(),
  status: z.enum(["ok", "below_threshold", "insufficient_data"]),
  assessed_count: z.int().min(0),
  by_station: z.array(z.object({ station_id: id, assessed_count: z.int().min(0), correct_count: z.int().min(0) })),
});

const pctMatchesStatus = (s: { status: string; correct_sorting_pct: number | null }) =>
  s.correct_sorting_pct !== null || s.status === "insufficient_data";
const pctIssue = { message: "an item without a pct must have status insufficient_data", path: ["status"] };

export const ItemSummarySchema = ItemSummaryShape.refine(pctMatchesStatus, pctIssue);

export const PeriodSchema = z.object({
  from: timestamp,
  to: timestamp,
  assessed_count: z.int().min(0),
  correct_sorting_pct: pct.nullable(),
});

export const InterventionSchema = z.object({
  intervention_id: id,
  action: z.string(),
  confirmed_at: timestamp,
  before: PeriodSchema,
  after: PeriodSchema,
});

export const ItemDetailSchema = ItemSummaryShape.extend({ interventions: z.array(InterventionSchema) }).refine(
  pctMatchesStatus,
  pctIssue,
);

// ---- /api/alerts ----

export const AlertSummarySchema = z.object({
  alert_id: id,
  kind: z.enum(["recommendation", "emptying"]),
  state: z.enum(["open", "sent", "follow_up_sent", "acknowledged", "action_confirmed", "emptied", "closed"]),
  item_id: id.nullable(),
  bin_id: id.nullable(),
  contact_id: id,
  /** Human-readable reason, e.g. "cup score 40% < 60%, 5 assessed events". */
  trigger: z.string(),
  opened_at: timestamp,
});

// ---- /api/reviews ----

export const ReviewItemSchema = z.object({
  event_id: id,
  bin_id: id,
  occurred_at: timestamp,
  item: ItemGuessSchema,
  business: BusinessGuessSchema,
  evidence: z.array(EvidenceSchema),
  status: z.enum(["pending", "resolved", "left_unresolved"]),
  assigned_business_id: id.nullable(),
});

export type FeedItem = z.infer<typeof FeedItemSchema>;
export type FeedResponse = z.infer<typeof FeedResponseSchema>;
export type BinSummary = z.infer<typeof BinSummarySchema>;
export type ItemSummary = z.infer<typeof ItemSummarySchema>;
export type ItemDetail = z.infer<typeof ItemDetailSchema>;
export type AlertSummary = z.infer<typeof AlertSummarySchema>;
export type ReviewItem = z.infer<typeof ReviewItemSchema>;
