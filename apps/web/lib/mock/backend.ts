/**
 * In-browser MOCK of I's backend, used when NEXT_PUBLIC_DATA_SOURCE=mock.
 *
 * It exists only so the dashboard can be built and rehearsed before the real
 * API exists. It is deliberately simple (unweighted scores, keyword reply
 * interpretation) and is not a reference for core's rules. Like core
 * (contract §6), it does time-driven work lazily whenever the feed is polled.
 */
import type {
  Alert,
  AlertKind,
  AlertMessage,
  AlertsResponse,
  BinStatus,
  BinsResponse,
  CatalogItem,
  CatalogResponse,
  DisposalEvent,
  FeedItem,
  FeedItemType,
  FeedResponse,
  Intervention,
  ItemDetail,
  ItemSummary,
  ItemsResponse,
  MockReply,
  Outcome,
  Period,
  ReviewDecision,
  ReviewItem,
  ReviewsResponse,
  Score,
} from "@/lib/types";
import {
  BINS,
  BUSINESSES,
  BUSINESS_THRESHOLD,
  CATALOG,
  CONTACTS,
  FOLLOW_UP_AFTER_MS,
  FULLNESS_THRESHOLD,
  MIN_ASSESSED,
  SCORE_THRESHOLD_PERCENT,
  STATION,
} from "./fixtures";
import { SCRIPT, type ScriptStep } from "./script";
import { mockIllustrationSvg } from "./illustration";

type StoredEvent = {
  event: DisposalEvent;
  outcome: Outcome;
  business_id: string | null;
  review: ReviewItem | null;
};

type BinState = {
  epochStart: number;
  last_emptied_at: string | null;
  illustration: BinStatus["illustration"];
};

type StoredIntervention = Omit<Intervention, "before" | "after"> & { item_id: string };

export class MockBackend {
  private startedAt = 0;
  private nextStep = 0;
  private cursor = 0;
  private feedItems: FeedItem[] = [];
  private events: StoredEvent[] = [];
  private alerts: Alert[] = [];
  private interventions: StoredIntervention[] = [];
  private catalogItems: CatalogItem[] = [];
  private binState = new Map<string, BinState>();
  private ids = 0;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly script: ScriptStep[] = SCRIPT,
  ) {
    this.reset();
  }

  reset(): void {
    this.startedAt = this.now();
    this.nextStep = 0;
    this.cursor = 0;
    this.feedItems = [];
    this.events = [];
    this.alerts = [];
    this.interventions = [];
    this.ids = 0;
    this.catalogItems = structuredClone(CATALOG);
    this.binState = new Map(
      BINS.map((b) => [b.bin_id, { epochStart: 0, last_emptied_at: null, illustration: null }]),
    );
  }

  // ---- public API, mirroring the HTTP endpoints -------------------------

  feed(after: string | null): FeedResponse {
    this.advance();
    const items = after ? this.feedItems.filter((f) => f.cursor > after) : this.feedItems;
    const last = this.feedItems.at(-1)?.cursor ?? after ?? null;
    return clone({ items, cursor: last, demo: true });
  }

  bins(): BinsResponse {
    return clone({ bins: BINS.map((b) => this.binStatus(b.bin_id)) });
  }

  items(): ItemsResponse {
    return clone({ items: this.catalogItems.map((c) => this.itemSummary(c)) });
  }

  item(id: string): ItemDetail | null {
    const c = this.catalogItems.find((x) => x.catalog_item_id === id);
    if (!c) return null;
    const evs = this.events.filter((e) => e.event.item.catalog_item_id === id);
    const assessed = evs.filter((e) => e.outcome !== "unassessable");
    const detail: ItemDetail = {
      ...this.itemSummary(c),
      stations: [
        {
          station_id: STATION.station_id,
          station_name: STATION.station_name,
          assessed_count: assessed.length,
          correct_count: assessed.filter((e) => e.outcome === "correct").length,
        },
      ],
    };
    return clone(detail);
  }

  alertsList(): AlertsResponse {
    return clone({ alerts: [...this.alerts].reverse(), messenger_mocked: true });
  }

  reviews(): ReviewsResponse {
    const reviews = this.events.flatMap((e) => (e.review ? [e.review] : [])).reverse();
    return clone({ reviews });
  }

  decideReview(eventId: string, decision: ReviewDecision): void {
    const stored = this.events.find((e) => e.event.event_id === eventId);
    if (!stored?.review) throw new Error(`No review for ${eventId}`);
    if (decision.action === "assign") {
      stored.review.status = "resolved";
      stored.review.resolved_business_id = decision.business_id;
      stored.business_id = decision.business_id;
      const name = BUSINESSES.find((b) => b.business_id === decision.business_id)?.name ?? decision.business_id;
      this.pushFeed("review_resolved", { event_id: eventId }, `Review resolved: assigned to ${name}`);
    } else {
      stored.review.status = "left_unresolved";
      this.pushFeed("review_resolved", { event_id: eventId }, "Review left unresolved");
    }
  }

  catalog(): CatalogResponse {
    return clone({ items: this.catalogItems, businesses: BUSINESSES });
  }

  saveCatalogItem(item: CatalogItem): void {
    const i = this.catalogItems.findIndex((c) => c.catalog_item_id === item.catalog_item_id);
    if (i >= 0) this.catalogItems[i] = clone(item);
    else this.catalogItems.push(clone(item));
  }

  /** Same path a Photon webhook reply would take (contract §6), with a keyword interpreter. */
  mockReply({ contactId, body }: MockReply): void {
    const now = this.now();
    const open = this.alerts.filter((a) => a.contact.contact_id === contactId && isOpen(a));
    const target = open.at(-1);
    if (!target) return;

    const inbound: AlertMessage = {
      message_id: this.id("msg"),
      direction: "inbound",
      body,
      at: iso(now),
      mocked: true,
    };
    target.messages.push(inbound);
    this.pushFeed("reply_received", { alert_id: target.alert_id }, `${target.contact.name}: “${body}”`);

    const intent = interpret(body, target.kind);
    if (intent === "bin_emptied" && target.kind === "emptying" && target.bin_id) {
      target.state = "emptied";
      this.emptyBin(target.bin_id, now);
      this.pushFeed("bin_emptied", { alert_id: target.alert_id, bin_id: target.bin_id }, `${binName(target.bin_id)} emptied; its inventory reset`);
      this.refreshIllustration(target.bin_id);
    } else if (intent === "action_confirmed" && target.kind === "recommendation" && target.item_id) {
      target.state = "action_confirmed";
      this.interventions.push({
        intervention_id: this.id("int"),
        alert_id: target.alert_id,
        item_id: target.item_id,
        action: body,
        confirmed_at: iso(now),
      });
      this.pushFeed("intervention_recorded", { alert_id: target.alert_id, item_id: target.item_id }, `Intervention recorded for ${itemName(this.catalogItems, target.item_id)}`);
    } else if (intent === "acknowledged") {
      target.state = "acknowledged";
    } else {
      target.state = "needs_clarification";
      this.sendMessage(target, "clarification", "Thanks! Just to confirm: has the suggested change been made? Reply DONE once it is in place.");
    }
  }

  // ---- time-driven work ---------------------------------------------------

  private advance(): void {
    const elapsed = this.now() - this.startedAt;
    while (this.nextStep < this.script.length && this.script[this.nextStep].at * 1000 <= elapsed) {
      const step = this.script[this.nextStep++];
      if (step.kind === "disposal") this.dispose(step, this.startedAt + step.at * 1000);
      else {
        // Scripted replies only answer alerts still open for that contact.
        const waiting = this.alerts.some((a) => a.contact.contact_id === step.contact && isOpen(a));
        if (waiting) this.mockReply({ contactId: step.contact, body: step.body });
      }
    }
    for (const a of this.alerts) {
      if (a.state === "sent" && this.now() - Date.parse(a.opened_at) >= FOLLOW_UP_AFTER_MS) {
        a.state = "follow_up_sent";
        const body =
          a.kind === "recommendation"
            ? `Following up on ${itemName(this.catalogItems, a.item_id)}: did the suggested sign go up? Reply DONE once it's in place.`
            : `Following up: has ${binName(a.bin_id)} been emptied? Reply EMPTIED once it has.`;
        this.sendMessage(a, "follow_up", body);
      }
    }
  }

  private dispose(step: Extract<ScriptStep, { kind: "disposal" }>, at: number): void {
    const cat = step.item ? this.catalogItems.find((c) => c.catalog_item_id === step.item) ?? null : null;
    const bin = BINS.find((b) => b.bin_id === step.bin)!;
    const n = this.events.length + 1;
    const topBiz = step.business?.[0] ?? null;
    const event: DisposalEvent = {
      event_id: `evt_mock_${String(n).padStart(3, "0")}`,
      source: { camera_id: STATION.camera_id, clip_id: "clip_mock", track_id: n, mode: "recorded" },
      bin_id: bin.bin_id,
      occurred_at: iso(at),
      clip_offset_s: step.at,
      destination_confidence: 0.9,
      item: {
        catalog_item_id: cat?.catalog_item_id ?? null,
        label: step.label,
        confidence: cat ? 0.82 : null,
        candidates: cat ? [{ catalog_item_id: cat.catalog_item_id, score: 0.82 }] : [],
      },
      business: topBiz ? { business_id: topBiz.business_id, confidence: topBiz.confidence, basis: ["logo_text"] } : null,
      evidence: [{ kind: "crop", uri: `clip_mock/${n}_entry.jpg`, frame: Math.round(step.at * 30) }],
    };

    const outcome: Outcome = !cat ? "unassessable" : cat.correct_destination === bin.type ? "correct" : "incorrect";
    // Contract §6 attribution order: catalog business, then the event's own business, else review.
    const business_id =
      cat?.business_id ?? (topBiz && topBiz.confidence >= BUSINESS_THRESHOLD ? topBiz.business_id : null);
    // §6 rule 3: only a weak business guess goes to review; no evidence at all (rule 4) stays unattributed.
    const needsReview = !!cat && !business_id && !!topBiz;
    const review: ReviewItem | null = needsReview
      ? {
          event_id: event.event_id,
          occurred_at: event.occurred_at,
          bin_id: bin.bin_id,
          item_name: cat!.name,
          item: event.item,
          business_candidates: (step.business ?? []).map((b) => ({
            business_id: b.business_id,
            name: BUSINESSES.find((x) => x.business_id === b.business_id)?.name ?? b.business_id,
            score: b.confidence,
          })),
          evidence: event.evidence,
          status: "pending",
        }
      : null;
    this.events.push({ event, outcome, business_id, review });

    const what = cat?.name ?? "Unknown item";
    const suffix = outcome === "unassessable" ? "unassessable" : outcome;
    this.pushFeed("disposal", { event_id: event.event_id, bin_id: bin.bin_id, item_id: cat?.catalog_item_id }, `${what} → ${cap(bin.type)} (${suffix})`, { outcome, source_mode: event.source.mode });
    if (review) this.pushFeed("review_queued", { event_id: event.event_id }, `${what}: origin unclear → area-manager review`);
    this.refreshIllustration(bin.bin_id);

    if (cat && business_id) this.maybeRecommend(cat);
    this.maybeRequestEmptying(bin.bin_id);
  }

  private maybeRecommend(cat: CatalogItem): void {
    const s = this.itemSummary(cat);
    if (s.score.status !== "ok" || s.assessed_count < MIN_ASSESSED || s.score.percent >= SCORE_THRESHOLD_PERCENT) return;
    // Like core: one recommendation per item until demo reset (no automatic re-alert after an intervention).
    if (this.alerts.some((a) => a.kind === "recommendation" && a.item_id === cat.catalog_item_id)) return;
    const contact = CONTACTS.find((c) => c.business_id === cat.business_id && c.role === "Restaurant manager");
    if (!contact) return;
    const pct = Math.round(s.score.percent);
    const alert = this.openAlert("recommendation", contact, {
      item_id: cat.catalog_item_id,
      trigger: `${cat.name} score ${pct}% < ${SCORE_THRESHOLD_PERCENT}%, ${s.assessed_count} assessed events`,
    });
    this.sendMessage(
      alert,
      "recommendation",
      `Hi, this is Recyclone at the shared patio. ${cat.name}s went into the right bin ${pct}% of the time (${s.assessed_count} seen). Here they go in ${cap(cat.correct_destination)}. Could you put a small sign where customers pick them up? Reply DONE once it's up.`,
    );
  }

  private maybeRequestEmptying(binId: string): void {
    const s = this.binStatus(binId);
    if (s.estimated_fullness < FULLNESS_THRESHOLD) return;
    if (this.alerts.some((a) => a.kind === "emptying" && a.bin_id === binId && isOpen(a))) return;
    const bin = BINS.find((b) => b.bin_id === binId)!;
    const contact = CONTACTS.find((c) => c.contact_id === bin.emptying_contact_id);
    if (!contact) return; // Emptying responsibility not configured: never guess a recipient.
    const pct = Math.round(s.estimated_fullness * 100);
    const alert = this.openAlert("emptying", contact, {
      bin_id: binId,
      trigger: `${s.name} estimated ${pct}% full ≥ ${Math.round(FULLNESS_THRESHOLD * 100)}% threshold`,
    });
    this.sendMessage(alert, "emptying_request", `${s.name} is estimated at ${pct}% full. Could someone empty it? Reply EMPTIED when done.`);
  }

  private openAlert(
    kind: AlertKind,
    contact: (typeof CONTACTS)[number],
    extra: { trigger: string; item_id?: string; bin_id?: string },
  ): Alert {
    const alert: Alert = {
      alert_id: this.id("alert"),
      kind,
      state: "sent",
      opened_at: iso(this.now()),
      contact: { contact_id: contact.contact_id, name: contact.name, role: contact.role, business_id: contact.business_id },
      business_name: BUSINESSES.find((b) => b.business_id === contact.business_id)?.name ?? null,
      messages: [],
      ...extra,
    };
    this.alerts.push(alert);
    const what = kind === "recommendation" ? `Recommendation for ${contact.name}` : `Emptying request: ${binName(extra.bin_id)}`;
    this.pushFeed("alert_opened", { alert_id: alert.alert_id, item_id: extra.item_id, bin_id: extra.bin_id }, `${what} (${extra.trigger})`);
    return alert;
  }

  private sendMessage(alert: Alert, kind: NonNullable<AlertMessage["kind"]>, body: string): void {
    alert.messages.push({ message_id: this.id("msg"), direction: "outbound", kind, body, at: iso(this.now()), mocked: true });
    this.pushFeed("message_sent", { alert_id: alert.alert_id }, `${kind.replace("_", "-")} sent to ${alert.contact.name}`, { mocked: true });
  }

  // ---- derived state ------------------------------------------------------

  private binStatus(binId: string): BinStatus {
    const bin = BINS.find((b) => b.bin_id === binId)!;
    const st = this.binState.get(binId)!;
    const current = this.events.filter((e) => e.event.bin_id === binId && Date.parse(e.event.occurred_at) >= st.epochStart);
    const counts = new Map<string, { catalog_item_id: string; name: string; count: number }>();
    const assumedInitialL = st.epochStart === 0 ? bin.initial_volume_l : 0;
    let volumeMl = assumedInitialL * 1000;
    let unknown = 0;
    for (const e of current) {
      const id = e.event.item.catalog_item_id;
      const cat = id ? this.catalogItems.find((c) => c.catalog_item_id === id) : undefined;
      if (!cat) {
        unknown++;
        continue;
      }
      volumeMl += cat.volume_ml;
      const row = counts.get(cat.catalog_item_id) ?? { catalog_item_id: cat.catalog_item_id, name: cat.name, count: 0 };
      row.count++;
      counts.set(cat.catalog_item_id, row);
    }
    return {
      bin_id: bin.bin_id,
      name: bin.name,
      station_id: STATION.station_id,
      station_name: STATION.station_name,
      camera_id: STATION.camera_id,
      type: bin.type,
      capacity_l: bin.capacity_l,
      estimated_volume_l: volumeMl / 1000,
      estimated_fullness: volumeMl / 1000 / bin.capacity_l,
      fullness_threshold: FULLNESS_THRESHOLD,
      observed_counts: [...counts.values()],
      unknown_count: unknown,
      initial_contents_known: st.epochStart !== 0,
      assumed_initial_l: assumedInitialL,
      illustration: st.illustration,
      last_emptied_at: st.last_emptied_at,
    };
  }

  private itemSummary(c: CatalogItem): ItemSummary {
    const all = this.events.filter((e) => e.event.item.catalog_item_id === c.catalog_item_id);
    const evs = all.filter((e) => e.outcome !== "unassessable");
    return {
      interventions: this.interventions
        .filter((i) => i.item_id === c.catalog_item_id)
        .map(({ item_id: _, ...i }) => ({
          ...i,
          before: this.period(all, this.startedAt, Date.parse(i.confirmed_at)),
          after: this.period(all, Date.parse(i.confirmed_at), this.now()),
        })),
      catalog_item_id: c.catalog_item_id,
      name: c.name,
      business_id: c.business_id,
      business_name: BUSINESSES.find((b) => b.business_id === c.business_id)?.name ?? null,
      correct_destination: c.correct_destination,
      score: score(evs),
      assessed_count: evs.length,
      threshold_percent: SCORE_THRESHOLD_PERCENT,
      min_assessed: MIN_ASSESSED,
    };
  }

  private period(evs: StoredEvent[], from: number, to: number): Period {
    const inRange = evs.filter((e) => {
      const t = Date.parse(e.event.occurred_at);
      return e.outcome !== "unassessable" && t >= from && t < to;
    });
    return { from: iso(from), to: iso(to), assessed_count: inRange.length, score: score(inRange) };
  }

  private emptyBin(binId: string, at: number): void {
    const st = this.binState.get(binId)!;
    st.epochStart = at;
    st.last_emptied_at = iso(at);
  }

  private refreshIllustration(binId: string): void {
    const s = this.binStatus(binId);
    const now = iso(this.now());
    const snapshotId = this.id("snap");
    this.binState.get(binId)!.illustration = {
      image_url: mockIllustrationSvg(s, now),
      generated_at: now,
      snapshot_id: snapshotId,
      snapshot_taken_at: now,
      mocked: true,
    };
    this.pushFeed("illustration_ready", { bin_id: binId }, `New illustration for ${s.name}`, { mocked: true });
  }

  private pushFeed(type: FeedItemType, ref: FeedItem["ref"], summary: string, extra: Partial<FeedItem> = {}): void {
    this.cursor++;
    this.feedItems.push({ cursor: String(this.cursor).padStart(6, "0"), at: iso(this.now()), type, ref: strip(ref), summary, demo: true, ...extra });
  }

  private id(prefix: string): string {
    return `${prefix}_mock_${++this.ids}`;
  }
}

// ---- helpers ---------------------------------------------------------------

function score(evs: StoredEvent[]): Score {
  if (evs.length === 0) return { status: "insufficient_data" };
  return { status: "ok", percent: (100 * evs.filter((e) => e.outcome === "correct").length) / evs.length };
}

function isOpen(a: Alert): boolean {
  return a.state !== "action_confirmed" && a.state !== "emptied";
}

/** Keyword stand-in for S's ReplyInterpreter. "ok thanks" is an acknowledgement, not a confirmation. */
export function interpret(body: string, kind: AlertKind): "bin_emptied" | "action_confirmed" | "acknowledged" | "unclear" {
  const t = body.toLowerCase();
  if (kind === "emptying" && /\bempt(ied|y)\b|\bdone\b/.test(t)) return "bin_emptied";
  if (kind === "recommendation" && /\b(done|installed|put up|we put|added|placed)\b/.test(t)) return "action_confirmed";
  if (/\b(ok|okay|thanks|thank you|got it|will do)\b/.test(t)) return "acknowledged";
  return "unclear";
}

function binName(binId?: string): string {
  return BINS.find((b) => b.bin_id === binId)?.name ?? binId ?? "bin";
}

function itemName(catalog: CatalogItem[], id?: string): string {
  return catalog.find((c) => c.catalog_item_id === id)?.name ?? id ?? "item";
}

function strip<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null)) as T;
}

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
const iso = (ms: number) => new Date(ms).toISOString();
const clone = <T,>(v: T): T => structuredClone(v);
