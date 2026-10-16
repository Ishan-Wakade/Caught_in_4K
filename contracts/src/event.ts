import { z } from "zod";

/** Where an item belongs, or which kind of bin it entered. */
export const DestinationSchema = z.enum(["trash", "recycling", "compost"]);
export type Destination = z.infer<typeof DestinationSchema>;

const confidence = z.number().min(0).max(1);
const timestamp = z.iso.datetime({ offset: true });

export const EventSourceSchema = z.object({
  camera_id: z.string().min(1),
  clip_id: z.string().min(1),
  /** Tracker ID; for `labeled` events, the label row number. */
  track_id: z.int().min(0),
  mode: z.enum(["recorded", "live", "labeled"]),
});

export const ItemGuessSchema = z.object({
  catalog_item_id: z.string().min(1).nullable(),
  /** Detector's free-text guess; never used for scoring. */
  label: z.string().nullable(),
  confidence: confidence.nullable(),
  candidates: z.array(z.object({ catalog_item_id: z.string().min(1), score: confidence })),
});

export const BusinessGuessSchema = z.object({
  business_id: z.string().min(1).nullable(),
  confidence: confidence.nullable(),
  basis: z.array(z.enum(["logo_text", "reference_match"])),
});

export const EvidenceSchema = z.object({
  kind: z.enum(["crop", "frame"]),
  /** Relative to the worker's evidence directory. */
  uri: z.string().min(1),
  frame: z.int().min(0),
});

const DisposalEventShape = z.object({
  event_id: z.string().regex(/^evt_[0-9a-f]{16}$/),
  source: EventSourceSchema,
  bin_id: z.string().min(1),
  occurred_at: timestamp,
  /** Seconds into the clip; null for live cameras. */
  clip_offset_s: z.number().min(0).nullable(),
  /** Confidence that the item actually entered `bin_id`. */
  destination_confidence: confidence,
  item: ItemGuessSchema,
  business: BusinessGuessSchema,
  evidence: z.array(EvidenceSchema),
});

/**
 * Cross-field rules a single field's type cannot express. Every rule here rejects the
 * whole event at POST /api/events, so a rule that is too strict loses a real event
 * during the live demo; a rule that is too loose lets worker bugs into the database.
 */
export function checkEventInvariants(event: z.infer<typeof DisposalEventShape>, ctx: z.RefinementCtx): void {
  // Only rules a correct worker can never violate AND that the generated JSON Schema also
  // expresses (scripts/json-schema.ts), so the Python worker and core always agree.
  // Candidate membership/order is deliberately not checked: hand-labeled backup events carry an
  // item with no candidates, and JSON Schema cannot express "value appears in this array".
  const { mode } = event.source;
  if (mode === "recorded" && event.clip_offset_s === null) {
    ctx.addIssue({ code: "custom", path: ["clip_offset_s"], message: "recorded events need clip_offset_s" });
  }
  if (mode === "live" && event.clip_offset_s !== null) {
    ctx.addIssue({ code: "custom", path: ["clip_offset_s"], message: "live events have no clip_offset_s" });
  }
}

/** One item that entered one bin (contracts/README.md §1). Correctness is decided by core, not here. */
export const DisposalEventSchema = DisposalEventShape.superRefine(checkEventInvariants);
export type DisposalEvent = z.infer<typeof DisposalEventSchema>;
