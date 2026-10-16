import { createHash } from "node:crypto";
import type { DisposalEvent, Messenger, Illustrator, ReplyInterpreter, InboundReply, OpenAlertSummary, BinInventorySnapshot, ContactRef, FeedResponse } from "@recyclone/contracts";
import type { CoreState, SiteSeed, FeedRecord, AlertRecord, EventRecord, JobRecord } from "./model.js";
import { initialState } from "./model.js";
import { configFor, configFromSite, type CoreConfig } from "./config.js";
import { binInventory, classify, itemMetric } from "./metrics.js";
import { type Repository, MemoryRepository } from "./repository.js";
import { contact, recommendationContact, projectBin, projectItem, projectItemDetail, projectReview, projectAlert } from "./projections.js";
import { createEventValidator, invariant, instant, validId, validateCatalog, validateSeed } from "./validation.js";

export type CoreOptions = {
  seed: SiteSeed; config?: CoreConfig; repository?: Repository;
  messenger: Messenger; illustrator: Illustrator; interpreter: ReplyInterpreter;
  validateEvent?: (value: unknown) => DisposalEvent;
  inboundRepliesMocked?: boolean;
  clock?: () => Date;
};
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
const active = (a: AlertRecord) => a.state === "open" || a.state === "acknowledged";
function nextId(s: CoreState, prefix: string) { return `${prefix}_${s.epoch}_${++s.sequence}`; }
function feed(s: CoreState, at: string, type: FeedRecord["type"], ref: FeedRecord["ref"], summary: string, mocked?: boolean) {
  const id = ++s.sequence;
  s.feed.push({ cursor: String(id).padStart(12, "0"), at, type, ref, summary: `${summary}${mocked ? " (mocked)" : ""}`, demo: s.config.profile === "demo" });
}
function queueMessage(s: CoreState, at: string, a: AlertRecord, kind: Parameters<Messenger["send"]>[0]["kind"], body: string) {
  const id = nextId(s, "message");
  s.jobs.push({ job_id: id, epoch: s.epoch, kind: "message", status: "pending", created_at: at, message: { to: a.contact, body, alertId: a.alert_id, kind } });
  s.messages.push({ message_id: id, alert_id: a.alert_id, body, direction: "outbound", kind, at, delivery_status: "pending" });
}
function inventoryKey(s: CoreState, binId: string, now: number) {
  const inv = binInventory(s, binId, now);
  return digest({ binId, epoch: s.epoch, emptying: inv.last_confirmed_emptying?.emptying_id, items: inv.items, unknown: inv.unknown_content_count, count: inv.observed_count, volume: inv.estimated_volume_ml });
}
function openSummaries(s: CoreState, from: ContactRef): OpenAlertSummary[] {
  return s.alerts.filter(a => active(a) && a.sent_at && a.contact.contactId === from.contactId).map(a => ({ alertId: a.alert_id, kind: a.kind, sentAt: a.sent_at!, itemName: s.seed.catalog.find(c => c.catalog_item_id === a.item_id)?.name, binName: s.seed.bins.find(b => b.bin_id === a.bin_id)?.name }));
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
          const a: AlertRecord = { alert_id: nextId(s, "alert"), kind: "recommendation", item_id: item.catalog_item_id, business_id: businessId, contact: to, state: "open", created_at: at, follow_up_queued: false,
            body: `${item.name}: ${metric.correct_sorting_percent!.toFixed(1)}% correctly sorted across ${metric.assessed_event_count} assessed disposals (${metric.recent_assessed_event_count} recent). Under this site's rules it belongs in ${item.destination}. Please place a sign near where customers collect this item explaining its correct bin. Reply when the sign is installed.` };
          s.alerts.push(a); queueMessage(s, at, a, "recommendation", `[${a.alert_id}] ${a.body}`);
          feed(s, at, "alert_opened", { alert_id: a.alert_id, item_id: item.catalog_item_id }, a.body);
        }
      }
      for (const bin of s.seed.bins) {
        const inv = binInventory(s, bin.bin_id, t);
        const to = contact(s, bin.emptying_contact_id);
        if (to && s.config.fullnessThreshold !== null && inv.estimated_fullness >= s.config.fullnessThreshold && !s.alerts.some(a => a.kind === "emptying" && a.bin_id === bin.bin_id && active(a))) {
          const a: AlertRecord = { alert_id: nextId(s, "alert"), kind: "emptying", bin_id: bin.bin_id, contact: to, state: "open", created_at: at, follow_up_queued: false,
            body: `${bin.name} (${bin.bin_id}) is estimated at ${(100 * inv.estimated_fullness).toFixed(0)}% of capacity from observed deposits. Please empty it and reply with the bin ID to confirm completion.` };
          s.alerts.push(a); queueMessage(s, at, a, "emptying_request", `[${a.alert_id}] ${a.body}`);
          feed(s, at, "alert_opened", { alert_id: a.alert_id, bin_id: bin.bin_id }, a.body);
        }
        const key = inventoryKey(s, bin.bin_id, t);
        const id = `image_${key}`;
        const latest = Object.hasOwn(s.images, bin.bin_id) ? s.images[bin.bin_id] : undefined;
        const waiting = s.jobs.some(j => j.kind === "image" && j.snapshot?.binId === bin.bin_id && (j.status === "pending" || j.status === "sending"));
        if (!waiting && !s.jobs.some(j => j.job_id === id) && (!latest || t - instant(latest.result.generatedAt) >= s.config.illustrationRefreshMs)) {
          const snapshot: BinInventorySnapshot = { snapshotId: id, binId: bin.bin_id, binType: bin.type, takenAt: at, estimatedFullness: inv.estimated_fullness, items: inv.items, unknownCount: inv.unknown_content_count };
          s.jobs.push({ job_id: id, epoch: s.epoch, kind: "image", status: "pending", created_at: at, snapshot });
        }
      }
      for (const a of s.alerts) {
        if (a.state === "open" && a.sent_at && !a.responded_at && !a.follow_up_queued && t - instant(a.sent_at) >= s.config.followUpMs) {
          a.follow_up_queued = true;
          queueMessage(s, at, a, "follow_up", `[${a.alert_id}] Following up: ${a.body}`);
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
        if (job.kind === "message" && job.message?.kind === "follow_up") {
          const alert = s.alerts.find(a => a.alert_id === job.message!.alertId);
          if (!alert || alert.responded_at || !active(alert)) {
            job.status = "cancelled";
            const message = s.messages.find(m => m.message_id === job.job_id);
            if (message) message.delivery_status = "cancelled";
            return { ...job, skip: true };
          }
        }
        job.status = "sending";
        const msg = s.messages.find(m => m.message_id === job.job_id);
        if (msg) msg.delivery_status = "sending";
        return job;
      });
      if (!job) break;
      if ("skip" in job) continue;
      try {
        if (job.kind === "message") {
          const result = await options.messenger.send(job.message!);
          instant(result.sentAt);
          await repository.transaction(s => {
            if (s.epoch !== job.epoch) return;
            const stored = s.jobs.find(j => j.job_id === job.job_id)!;
            stored.status = "sent";
            const message = s.messages.find(m => m.message_id === job.job_id)!;
            Object.assign(message, { at: result.sentAt, provider_message_id: result.providerMessageId, mocked: result.mocked, delivery_status: "sent" });
            const a = s.alerts.find(a => a.alert_id === job.message!.alertId)!;
            if (job.message!.kind === "recommendation" || job.message!.kind === "emptying_request") a.sent_at ??= result.sentAt;
            feed(s, result.sentAt, "message_sent", { alert_id: a.alert_id, bin_id: a.bin_id, item_id: a.item_id }, message.body, result.mocked);
          });
        } else {
          const result = await options.illustrator.illustrate(job.snapshot!);
          invariant(result.snapshotId === job.snapshot!.snapshotId, "Illustration returned a mismatched snapshot");
          instant(result.generatedAt);
          await repository.transaction(s => {
            if (s.epoch !== job.epoch) return;
            s.jobs.find(j => j.job_id === job.job_id)!.status = "sent";
            // A reset or catalog/review update during generation invalidates this picture.
            const key = `image_${inventoryKey(s, job.snapshot!.binId, instant(now()))}`;
            if (key !== job.job_id) return;
            Object.defineProperty(s.images, job.snapshot!.binId, { value: { snapshot: job.snapshot!, result }, enumerable: true, writable: true, configurable: true });
            feed(s, result.generatedAt, "illustration_ready", { bin_id: job.snapshot!.binId }, "Generated illustration of estimated contents", result.mocked);
          });
        }
      } catch (error) {
        await repository.transaction(s => {
          if (s.epoch !== job.epoch) return;
          const stored = s.jobs.find(j => j.job_id === job.job_id);
          if (stored) { stored.status = "failed"; stored.error = error instanceof Error ? error.message : "Adapter failed"; }
          const message = s.messages.find(m => m.message_id === job.job_id);
          if (message) { message.delivery_status = "failed"; message.error = "Delivery failed or uncertain; manual reconciliation required"; }
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

  async function handleReply(reply: InboundReply): Promise<{ status: "applied" | "duplicate" | "needs_clarification" }> {
    invariant(typeof reply.providerMessageId === "string" && reply.providerMessageId.length > 0 && reply.providerMessageId.length <= 500 && validId(reply.from.contactId) && typeof reply.body === "string" && reply.body.length > 0 && reply.body.length <= 10_000, "Invalid reply");
    invariant(instant(reply.receivedAt) <= instant(now()) + 5000, "Reply timestamp is too far in the future");
    const replyKey = Buffer.from(reply.providerMessageId).toString("base64url");
    const reserved = await repository.transaction(s => {
      if (Object.hasOwn(s.replies, replyKey)) return null;
      invariant(contact(s, reply.from.contactId), "Unknown manager contact", 403);
      s.replies[replyKey] = { reply, status: "processing" };
      s.messages.push({ message_id: nextId(s, "reply"), alert_id: null, contact_id: reply.from.contactId, body: reply.body, direction: "inbound", kind: "reply", mocked: options.inboundRepliesMocked ?? false, at: reply.receivedAt, provider_message_id: reply.providerMessageId });
      const alerts = openSummaries(s, reply.from);
      feed(s, now(), "reply_received", {}, "Manager reply received");
      return { epoch: s.epoch, alerts, feedCursor: s.feed.at(-1)!.cursor };
    });
    if (!reserved) return { status: "duplicate" };
    let interpreted: Awaited<ReturnType<ReplyInterpreter["interpret"]>>;
    try { interpreted = await options.interpreter.interpret(reply, reserved.alerts); }
    catch {
      interpreted = { alertId: null, intent: "unclear" };
    }
    const status = await repository.transaction(s => {
      invariant(s.epoch === reserved.epoch, "Demo state changed while processing reply", 409);
      const entry = s.replies[replyKey];
      const a = s.alerts.find(a => a.alert_id === interpreted.alertId && active(a) && a.contact.contactId === reply.from.contactId && reserved.alerts.some(open => open.alertId === a.alert_id));
      const replyFeed = s.feed.find(f => f.cursor === reserved.feedCursor)!;
      replyFeed.summary = `Manager: ${reply.body}${options.inboundRepliesMocked ? " (mocked)" : ""}`;
      const inbound = s.messages.find(m => m.direction === "inbound" && m.provider_message_id === reply.providerMessageId)!;
      const clarify = () => {
        entry.status = "needs_clarification";
        // A known pending conversation supplies a real alert ID for the adapter.
        const candidates = s.alerts.filter(a => active(a) && a.contact.contactId === reply.from.contactId);
        if (candidates.length) {
          const target = a ?? candidates[0];
          if (a || candidates.length === 1) {
            target.responded_at = reply.receivedAt;
            inbound.alert_id = target.alert_id; replyFeed.ref.alert_id = target.alert_id;
          }
          queueMessage(s, now(), target, "clarification", `Please name the alert or bin and confirm whether the action is completed. Open alerts: ${candidates.map(a => a.alert_id).join(", ")}.`);
        }
        return "needs_clarification" as const;
      };
      if (!a || interpreted.intent === "unclear") return clarify();
      if ((interpreted.intent === "bin_emptied" && a.kind !== "emptying") || (interpreted.intent === "action_confirmed" && a.kind !== "recommendation")) return clarify();
      if (interpreted.intent === "bin_emptied" && interpreted.emptiedAt) {
        const value = Date.parse(interpreted.emptiedAt);
        if (!Number.isFinite(value) || !/(?:Z|\+00:00)$/.test(interpreted.emptiedAt) || value > instant(reply.receivedAt) || value > instant(now())) return clarify();
        const last = s.emptyings.filter(e => e.bin_id === a.bin_id).sort((x, y) => instant(y.emptied_at) - instant(x.emptied_at))[0];
        if (last && value < instant(last.emptied_at)) return clarify();
      }
      a.responded_at = reply.receivedAt;
      inbound.alert_id = a.alert_id; replyFeed.ref.alert_id = a.alert_id;
      if (interpreted.intent === "acknowledged") a.state = "acknowledged";
      else if (interpreted.intent === "action_confirmed") {
        a.state = "action_confirmed";
        s.interventions.push({ intervention_id: nextId(s, "intervention"), alert_id: a.alert_id, item_id: a.item_id!, business_id: a.business_id!, action: reply.body, confirmed_at: reply.receivedAt });
        feed(s, reply.receivedAt, "intervention_recorded", { alert_id: a.alert_id, item_id: a.item_id }, reply.body);
      } else if (interpreted.intent === "bin_emptied") {
        a.state = "resolved";
        s.emptyings.push({ emptying_id: nextId(s, "emptying"), bin_id: a.bin_id!, emptied_at: interpreted.emptiedAt ?? reply.receivedAt, confirmed_at: reply.receivedAt, provider_message_id: reply.providerMessageId });
        delete s.images[a.bin_id!];
        for (const job of s.jobs) if (job.kind === "image" && job.snapshot?.binId === a.bin_id && job.status === "pending") { job.status = "failed"; job.error = "Superseded by confirmed emptying"; }
        feed(s, reply.receivedAt, "bin_emptied", { alert_id: a.alert_id, bin_id: a.bin_id }, "Manager confirmed bin emptying; history preserved");
      } else return clarify();
      entry.status = "applied";
      return "applied" as const;
    });
    await tick();
    return { status };
  }

  return {
    ingest, handleReply, tick,
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
        invariant(!s.jobs.some(j => j.status === "sending") && !Object.values(s.replies).some(r => r.status === "processing"), "Wait for in-flight integrations before resetting", 409);
        const replacement = initialState(seed, config, s.epoch + 1);
        replacement.sequence = s.sequence; // Existing polling cursors still advance after reset.
        Object.assign(s, replacement);
      });
      return { status: "reset" as const };
    },
  };
}
export type Core = ReturnType<typeof createCore>;
