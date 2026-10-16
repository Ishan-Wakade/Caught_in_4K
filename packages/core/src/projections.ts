import type { AlertSummary, BinSummary, ContactRef, ItemDetail, ItemSummary, ReviewItem } from "@recyclone/contracts";
import type { AlertRecord, CoreState, EventRecord } from "./model.js";
import { binInventory, comparison, itemMetric } from "./metrics.js";

export function contact(s: CoreState, id: string | undefined | null): ContactRef | undefined {
  const c = s.seed.contacts.find(c => c.contact_id === id);
  return c ? { contactId: c.contact_id, ...(c.phone ? { phone: c.phone } : {}), ...(c.handle ? { handle: c.handle } : {}) } : undefined;
}
export function recommendationContact(s: CoreState, businessId: string, stationId?: string): ContactRef | undefined {
  const role = stationId && s.config.stationLocations[stationId] === "in_store" ? "property_manager" : "restaurant_manager";
  const scoped = s.seed.contacts.filter(c => c.role === role && c.business_id === businessId);
  const candidates = scoped.length ? scoped : role === "property_manager" ? s.seed.contacts.filter(c => c.role === role && c.business_id === null) : [];
  // Ambiguous routing must be configured; never guess among managers.
  return candidates.length === 1 ? contact(s, candidates[0]!.contact_id) : undefined;
}
export function projectBin(s: CoreState, id: string, time: number): BinSummary {
  const inv = binInventory(s, id, time), image = inv.illustration;
  return {
    bin_id: inv.bin_id, name: inv.name, type: inv.type, station_id: inv.station_id, capacity_l: inv.capacity_l,
    estimated_fullness: inv.estimated_fullness, estimated_volume_l: inv.estimated_volume_ml / 1000,
    observed_count: inv.observed_count, unknown_count: inv.unknown_content_count,
    last_emptied_at: inv.last_confirmed_emptying?.emptied_at ?? null,
    illustration: image ? { image_url: image.result.imageUrl, generated_at: image.result.generatedAt, snapshot_id: image.snapshot.snapshotId, snapshot_taken_at: image.snapshot.takenAt, mocked: image.result.mocked } : null,
  };
}
export function projectItem(s: CoreState, id: string, time: number): ItemSummary {
  const item = s.seed.catalog.find(c => c.catalog_item_id === id)!;
  const m = itemMetric(s, id, undefined, time);
  return {
    catalog_item_id: id, name: item.name, business_id: item.business_id, destination: item.destination,
    correct_sorting_pct: m.correct_sorting_percent,
    status: m.correct_sorting_percent === null || m.recent_assessed_event_count < s.config.minAssessedEvents
      ? "insufficient_data" : s.config.correctSortingThreshold !== null && m.correct_sorting_percent < s.config.correctSortingThreshold ? "below_threshold" : "ok",
    assessed_count: m.assessed_event_count,
    by_station: m.station_breakdown.map(st => ({ station_id: st.station_id, assessed_count: st.assessed_event_count, correct_count: st.correct_event_count })),
  };
}
export function projectItemDetail(s: CoreState, id: string, time: number): ItemDetail {
  return { ...projectItem(s, id, time), interventions: s.interventions.filter(i => i.item_id === id).map(i => {
    const c = comparison(s, id, i.business_id, i.confirmed_at, time);
    const period = (p: typeof c.before) => ({ from: p.start, to: p.end, assessed_count: p.assessed_event_count, correct_sorting_pct: p.correct_sorting_percent });
    return { intervention_id: i.intervention_id, action: i.action, confirmed_at: i.confirmed_at, before: period(c.before), after: period(c.after) };
  }) };
}
export function projectReview(e: EventRecord): ReviewItem {
  return { event_id: e.raw.event_id, bin_id: e.raw.bin_id, occurred_at: e.raw.occurred_at, item: e.raw.item, business: e.raw.business, evidence: e.raw.evidence,
    status: e.review_status === "resolved" ? "resolved" : e.review_status === "unresolved" ? "left_unresolved" : "pending", assigned_business_id: e.reviewed_business_id ?? null };
}
export function projectAlert(s: CoreState, a: AlertRecord): AlertSummary {
  const messages = s.messages.filter(m => (m.alert_id === a.alert_id || (m.alert_id === null && m.contact_id === a.contact.contactId)) && (m.direction === "inbound" || m.delivery_status === "sent"));
  const errors = s.jobs.filter(j => j.kind === "message" && j.message?.alertId === a.alert_id && j.status === "failed");
  return {
    alert_id: a.alert_id, kind: a.kind,
    state: a.state === "resolved" ? "emptied" : a.state !== "open" ? a.state : messages.some(m => m.kind === "follow_up") ? "follow_up_sent" : a.sent_at ? "sent" : "open",
    item_id: a.item_id ?? null, bin_id: a.bin_id ?? null, contact_id: a.contact.contactId,
    trigger: `${a.body}${errors.length ? " Delivery failed or uncertain; manual reconciliation required." : ""}`,
    opened_at: a.created_at,
    messages: messages.map(m => ({ message_id: m.message_id, direction: m.direction, kind: m.kind, body: m.body, at: m.at, mocked: m.mocked ?? false })),
  };
}
