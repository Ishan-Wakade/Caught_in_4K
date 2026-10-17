import { createHash } from "node:crypto";
import type { DisposalEvent, Illustrator, BinInventorySnapshot, FeedResponse } from "@recyclone/contracts";
import type { CoreState, SiteSeed, FeedRecord, AlertRecord, EventRecord, JobRecord } from "./model.js";
import { initialState } from "./model.js";
import { configFor, configFromSite, type CoreConfig } from "./config.js";
import { binInventory, classify, itemMetric } from "./metrics.js";
import { type Repository, MemoryRepository } from "./repository.js";
import { contact, recommendationContact, projectBin, projectItem, projectItemDetail, projectReview, projectAlert } from "./projections.js";
import { createEventValidator, invariant, instant, validId, validateCatalog, validateSeed } from "./validation.js";

export type CoreOptions = {
  seed: SiteSeed; config?: CoreConfig; repository?: Repository;
  illustrator: Illustrator;
  validateEvent?: (value: unknown) => DisposalEvent;
  clock?: () => Date;
};
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
const active = (a: AlertRecord) => a.state === "open" || a.state === "acknowledged";
function nextId(s: CoreState, prefix: string) { return `${prefix}_${s.epoch}_${++s.sequence}`; }
function feed(s: CoreState, at: string, type: FeedRecord["type"], ref: FeedRecord["ref"], summary: string, mocked?: boolean) {
  const id = ++s.sequence;
  s.feed.push({ cursor: String(id).padStart(12, "0"), at, type, ref, summary: `${summary}${mocked ? " (mocked)" : ""}`, demo: s.config.profile === "demo" });
}
function inventoryKey(s: CoreState, binId: string, now: number) {
  const inv = binInventory(s, binId, now);
  return digest({ binId, epoch: s.epoch, emptying: inv.last_confirmed_emptying?.emptying_id, items: inv.items, unknown: inv.unknown_content_count, count: inv.observed_count, volume: inv.estimated_volume_ml });
}

export function createCore(options: CoreOptions) {
  const seed = validateSeed(options.seed);
  const config = options.config ? configFor(options.config.profile, options.config) : configFromSite("normal", seed.config_profiles.normal);
  const validateEvent = options.validateEvent ?? createEventValidator();
  const repository: Repository = options.repository ?? new MemoryRepository(initialState(seed, config));
  const now = () => (options.clock?.() ?? new Date()).toISOString();

  async function evaluate() {
    const at = now(), t = instant(at);
    await repository.transaction(s => {
      for (const item of s.seed.catalog) {
        // Generic catalog items can accumulate separate, reviewed business assignments.
        const businesses = new Set(Object.values(s.events).filter(e => e.item_id === item.catalog_item_id && e.business_id).map(e => e.business_id!));
        for (const businessId of businesses) {
          const metric = itemMetric(s, item.catalog_item_id, businessId, t);
          if (!metric.alert_eligible || s.alerts.some(a => a.kind === "recommendation" && a.item_id === item.catalog_item_id && a.business_id === businessId)) continue;
          const latest = Object.values(s.events).filter(e => e.item_id === item.catalog_item_id && e.business_id === businessId && e.correctness === "incorrect" && instant(e.raw.occurred_at) <= t).sort((a, b) => instant(b.raw.occurred_at) - instant(a.raw.occurred_at))[0];
          const bin = s.seed.bins.find(b => b.bin_id === latest?.raw.bin_id);
          const to = recommendationContact(s, businessId, bin?.station_id);
          if (!to) continue; // Missing routing is surfaced in configuration; never guess a contact.
          const a: AlertRecord = { alert_id: nextId(s, "alert"), kind: "recommendation", item_id: item.catalog_item_id, business_id: businessId, bin_id: bin?.bin_id, contact: to, state: "open", created_at: at,
            body: `${item.name}: ${metric.correct_sorting_percent!.toFixed(1)}% correctly sorted across ${metric.assessed_event_count} assessed disposals (${metric.recent_assessed_event_count} recent). Under this site's rules it belongs in ${item.destination}.` };
          s.alerts.push(a);
          feed(s, at, "alert_opened", { alert_id: a.alert_id, item_id: item.catalog_item_id }, a.body);
        }
      }
      for (const bin of s.seed.bins) {
        const inv = binInventory(s, bin.bin_id, t);
        const to = contact(s, bin.emptying_contact_id);
        if (to && s.config.fullnessThreshold !== null && inv.estimated_fullness >= s.config.fullnessThreshold && !s.alerts.some(a => a.kind === "emptying" && a.bin_id === bin.bin_id && active(a))) {
          const a: AlertRecord = { alert_id: nextId(s, "alert"), kind: "emptying", bin_id: bin.bin_id, contact: to, state: "open", created_at: at,
            body: `${bin.name} (${bin.bin_id}) is estimated at ${(100 * inv.estimated_fullness).toFixed(0)}% of capacity from observed deposits.` };
          s.alerts.push(a);
          feed(s, at, "alert_opened", { alert_id: a.alert_id, bin_id: bin.bin_id }, a.body);
        }
        const key = inventoryKey(s, bin.bin_id, t);
        const id = `image_${key}`;
        const latest = Object.hasOwn(s.images, bin.bin_id) ? s.images[bin.bin_id] : undefined;
        const waiting = s.jobs.some(j => j.snapshot.binId === bin.bin_id && (j.status === "pending" || j.status === "sending"));
        if (!waiting && !s.jobs.some(j => j.job_id === id) && (!latest || t - instant(latest.result.generatedAt) >= s.config.illustrationRefreshMs)) {
          const snapshot: BinInventorySnapshot = { snapshotId: id, binId: bin.bin_id, binType: bin.type, takenAt: at, estimatedFullness: inv.estimated_fullness, items: inv.items, unknownCount: inv.unknown_content_count };
          s.jobs.push({ job_id: id, epoch: s.epoch, status: "pending", created_at: at, snapshot });
        }
      }
    });
  }

  async function dispatch() {
    // Claim and commit before external I/O. A crashed/ambiguous send stays visible as
    // 'sending' or 'failed'; it is not automatically retried and potentially duplicated.
    for (let count = 0; count < 100; count++) {
      const job = await repository.transaction(s => {
        const job = s.jobs.find(j => j.status === "pending");
        if (!job) return null;
        job.status = "sending";
        return job;
      });
      if (!job) break;
      try {
        const result = await options.illustrator.illustrate(job.snapshot);
        invariant(result.snapshotId === job.snapshot.snapshotId, "Illustration returned a mismatched snapshot");
        instant(result.generatedAt);
        await repository.transaction(s => {
          if (s.epoch !== job.epoch) return;
          s.jobs.find(j => j.job_id === job.job_id)!.status = "sent";
          // A reset or catalog/review update during generation invalidates this picture.
          const key = `image_${inventoryKey(s, job.snapshot.binId, instant(now()))}`;
          if (key !== job.job_id) return;
          Object.defineProperty(s.images, job.snapshot.binId, { value: { snapshot: job.snapshot, result }, enumerable: true, writable: true, configurable: true });
          feed(s, result.generatedAt, "illustration_ready", { bin_id: job.snapshot.binId }, "Generated illustration of estimated contents", result.mocked);
        });
      } catch (error) {
        await repository.transaction(s => {
          if (s.epoch !== job.epoch) return;
          const stored = s.jobs.find(j => j.job_id === job.job_id);
          if (stored) { stored.status = "failed"; stored.error = error instanceof Error ? error.message : "Adapter failed"; }
        });
      }
    }
  }
  async function tick() { await evaluate(); await dispatch(); }

  async function ingest(input: unknown) {
    const rawEvents = input && typeof input === "object" && "events" in input ? (input as { events: unknown }).events : [input];
    invariant(Array.isArray(rawEvents) && rawEvents.length > 0 && rawEvents.length <= 100, "Supply 1–100 events");
    const events = rawEvents.map(validateEvent);
    const at = now();
    const results = await repository.transaction(s => {
      // Validate the complete batch before making any change.
      for (const event of events) {
        const bin = s.seed.bins.find(b => b.bin_id === event.bin_id);
        invariant(bin, "Unknown bin", 422);
        invariant(bin.camera_id === event.source.camera_id, "Event must use the bin's authoritative camera", 422);
        invariant(instant(event.occurred_at) <= instant(at) + 5_000, "Event timestamp is too far in the future", 422);
      }
      return events.map(raw => {
        if (Object.hasOwn(s.events, raw.event_id)) return { event_id: raw.event_id, status: "duplicate" as const };
        const record = classify(s, { raw, received_at: at, item_id: null, business_id: null, actual_destination: null, expected_destination: null, correctness: "unassessable", review_status: "pending" });
        Object.defineProperty(s.events, raw.event_id, { value: record, enumerable: true, writable: true, configurable: true });
        feed(s, at, "disposal", { event_id: raw.event_id, bin_id: raw.bin_id, item_id: record.item_id ?? undefined }, `${raw.item.label ?? "Unknown item"} → ${s.seed.bins.find(b => b.bin_id === raw.bin_id)!.type} (${record.correctness})${raw.source.mode === "labeled" ? " [labeled backup input]" : ""}`);
        if (record.review_status === "pending") feed(s, at, "review_queued", { event_id: raw.event_id }, "Area manager: identify source business");
        return { event_id: raw.event_id, status: "created" as const };
      });
    });
    await tick();
    return Array.isArray(rawEvents) && input && typeof input === "object" && "events" in input ? { events: results } : results[0];
  }

  return {
    ingest, tick,
    async close() { await repository.close?.(); },
    async getFeed(after = ""): Promise<FeedResponse> {
      invariant(after === "" || /^\d{1,20}$/.test(after), "Invalid feed cursor");
      await tick();
      return repository.transaction(s => {
        const items = s.feed.filter(f => !after || BigInt(f.cursor) > BigInt(after)).slice(0, 200);
        return { items, next_cursor: items.at(-1)?.cursor ?? (after || "000000000000") };
      });
    },
    async getBins() { return repository.transaction(s => s.seed.bins.map(b => projectBin(s, b.bin_id, instant(now())))); },
    async getItems() { return repository.transaction(s => s.seed.catalog.map(c => projectItem(s, c.catalog_item_id, instant(now())))); },
    async getItem(id: string) { return repository.transaction(s => {
      invariant(s.seed.catalog.some(c => c.catalog_item_id === id), "Unknown item", 404);
      return projectItemDetail(s, id, instant(now()));
    }); },
    async getCatalog() { return repository.transaction(s => s.seed.catalog); },
    async upsertCatalog(input: unknown) {
      const item = validateCatalog(input);
      const result = await repository.transaction(s => {
        invariant(item.business_id === null || s.seed.businesses.some(b => b.business_id === item.business_id), "Unknown business", 422);
        const index = s.seed.catalog.findIndex(c => c.catalog_item_id === item.catalog_item_id);
        if (index === -1) s.seed.catalog.push(item); else s.seed.catalog[index] = item;
        for (const record of Object.values(s.events)) classify(s, record);
        // Images based on old item identity/volume are no longer current.
        s.images = {};
        return item;
      });
      await tick(); return result;
    },
    async getReviews() { return repository.transaction(s => Object.values(s.events).filter(e => e.review_status === "pending" || e.review_status === "unresolved").map(projectReview)); },
    async review(eventId: string, businessId: string | null) {
      invariant(businessId === null || validId(businessId), "Invalid business identifier");
      const result = await repository.transaction(s => {
        const e = s.events[eventId]; invariant(e && Object.hasOwn(s.events, eventId), "Unknown event", 404);
        invariant(businessId === null || s.seed.businesses.some(b => b.business_id === businessId), "Unknown business", 422);
        const item = s.seed.catalog.find(c => c.catalog_item_id === e.item_id);
        invariant(!item?.business_id || businessId === null || businessId === item.business_id, "Business conflicts with identified catalog item", 409);
        e.reviewed_business_id = businessId; classify(s, e);
        feed(s, now(), "review_resolved", { event_id: eventId }, businessId ? "Business assigned by area manager" : "Origin left unresolved");
        return projectReview(e);
      });
      await tick(); return result;
    },
    async getAlerts() { return repository.transaction(s => s.alerts.map(a => projectAlert(s, a))); },
    async resetDemo() {
      await repository.transaction(s => {
        invariant(s.config.profile === "demo", "Demo reset disabled outside demo profile", 403);
        invariant(!s.jobs.some(j => j.status === "sending"), "Wait for in-flight integrations before resetting", 409);
        const replacement = initialState(seed, config, s.epoch + 1);
        replacement.sequence = s.sequence; // Existing polling cursors still advance after reset.
        Object.assign(s, replacement);
      });
      return { status: "reset" as const };
    },
  };
}
export type Core = ReturnType<typeof createCore>;
