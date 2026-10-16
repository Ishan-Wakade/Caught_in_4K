import type { CoreState, EventRecord } from "./model.js";
export function classify(state: CoreState, record: EventRecord): EventRecord {
  const { raw } = record;
  const catalog = raw.item.confidence !== null && raw.item.confidence >= state.config.itemConfidence
    ? state.seed.catalog.find(c => c.catalog_item_id === raw.item.catalog_item_id) : undefined;
  const bin = state.seed.bins.find(b => b.bin_id === raw.bin_id);
  const manual = Object.hasOwn(record, "reviewed_business_id");
  const rawBusiness = raw.business.confidence !== null && raw.business.confidence >= state.config.businessConfidence && state.seed.businesses.some(b => b.business_id === raw.business.business_id) ? raw.business.business_id : null;
  record.item_id = catalog?.catalog_item_id ?? null;
  record.business_id = manual ? record.reviewed_business_id ?? null : catalog?.business_id ?? rawBusiness;
  record.actual_destination = bin && raw.destination_confidence >= state.config.destinationConfidence ? bin.type : null;
  record.expected_destination = catalog?.destination ?? null;
  // No observation field yet captures food residue or other conditional rules.
  record.correctness = catalog && !catalog.condition_rule && record.actual_destination
    ? record.actual_destination === record.expected_destination ? "correct" : "incorrect" : "unassessable";
  record.review_status = manual ? record.business_id ? "resolved" : "unresolved" : record.business_id || raw.business.business_id === null ? "not_required" : "pending";
  return record;
}
export function itemMetric(state: CoreState, itemId: string, businessId: string | null | undefined, now: number) {
  const events = Object.values(state.events).filter(e => e.item_id === itemId && (businessId === undefined || e.business_id === businessId) && Date.parse(e.raw.occurred_at) <= now);
  const assessed = events.filter(e => e.correctness !== "unassessable");
  const recent = assessed.filter(e => (state.config.evidenceWindowMs === null || now - Date.parse(e.raw.occurred_at) <= state.config.evidenceWindowMs));
  // A common scaling factor cancels; anchoring at the latest event avoids underflow.
  const anchor = Math.max(...assessed.map(e => Date.parse(e.raw.occurred_at)));
  let total = 0, correct = 0;
  for (const e of assessed) {
    const w = 2 ** (-(anchor - Date.parse(e.raw.occurred_at)) / state.config.halfLifeMs);
    total += w;
    if (e.correctness === "correct") correct += w;
  }
  const percentage = total > 0 ? 100 * correct / total : null;
  return {
    catalog_item_id: itemId, business_id: businessId,
    status: percentage === null ? "insufficient_data" as const : "assessed" as const,
    correct_sorting_percent: percentage, assessed_event_count: assessed.length,
    recent_assessed_event_count: recent.length, unknown_event_count: events.length - assessed.length,
    alert_eligible: percentage !== null && state.config.correctSortingThreshold !== null && percentage < state.config.correctSortingThreshold && recent.length >= state.config.minAssessedEvents,
    station_breakdown: state.seed.stations.map(s => {
      const local = assessed.filter(e => state.seed.bins.find(b => b.bin_id === e.raw.bin_id)?.station_id === s.station_id);
      return { station_id: s.station_id, assessed_event_count: local.length, correct_event_count: local.filter(e => e.correctness === "correct").length };
    }),
  };
}
export function binInventory(state: CoreState, binId: string, now: number) {
  const bin = state.seed.bins.find(b => b.bin_id === binId)!;
  const emptying = state.emptyings.filter(e => e.bin_id === binId).sort((a, b) => Date.parse(b.emptied_at) - Date.parse(a.emptied_at))[0];
  const start = emptying ? Date.parse(emptying.emptied_at) : -Infinity;
  const events = Object.values(state.events).filter(e => e.raw.bin_id === binId && e.actual_destination !== null && Date.parse(e.raw.occurred_at) > start && Date.parse(e.raw.occurred_at) <= now);
  const grouped = new Map<string, { name: string; count: number }>();
  let volume = emptying ? 0 : bin.initial_volume_l * 1000, unknown = 0;
  for (const e of events) {
    const item = state.seed.catalog.find(c => c.catalog_item_id === e.item_id);
    if (!item) { unknown++; continue; }
    const entry = grouped.get(item.catalog_item_id) ?? { name: item.name, count: 0 };
    entry.count++; grouped.set(item.catalog_item_id, entry);
    if (item.volume_ml === null) unknown++; else volume += item.volume_ml;
  }
  return {
    bin_id: binId, station_id: bin.station_id, name: bin.name, type: bin.type, capacity_l: bin.capacity_l,
    estimated_volume_ml: volume, estimated_fullness: volume / (bin.capacity_l * 1000),
    observed_count: events.length, unknown_content_count: unknown,
    initial_contents_known: Boolean(emptying) || bin.initial_volume_l === 0,
    last_confirmed_emptying: emptying ?? null,
    items: [...grouped.values()], illustration: Object.hasOwn(state.images, binId) ? state.images[binId]! : null,
    estimate_label: "Estimated from observed deposits; packing and missed items are not measured",
  };
}
export function comparison(state: CoreState, itemId: string, businessId: string, confirmedAt: string, now: number) {
  const at = Date.parse(confirmedAt), window = state.config.comparisonWindowMs;
  const summarize = (start: number, end: number) => {
    const events = Object.values(state.events).filter(e => e.item_id === itemId && e.business_id === businessId && e.correctness !== "unassessable" && Date.parse(e.raw.occurred_at) >= start && Date.parse(e.raw.occurred_at) < end);
    return { start: new Date(start).toISOString(), end: new Date(end).toISOString(), assessed_event_count: events.length, correct_sorting_percent: events.length ? 100 * events.filter(e => e.correctness === "correct").length / events.length : null };
  };
  return { before: summarize(at - window, at), after: summarize(at, Math.max(at, Math.min(at + window, now))), label: "Observed comparison; does not establish causation" };
}
