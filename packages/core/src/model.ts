import type { DisposalEvent, ContactRef, BinInventorySnapshot, InboundReply, Messenger, Illustrator } from "@recyclone/contracts";
import type { CoreConfig } from "./config.js";

// Private persistence/configuration records. Shared wire types come from contracts.
export type BinType = BinInventorySnapshot["binType"];
export type CatalogRecord = {
  catalog_item_id: string; name: string; business_id: string | null;
  correct_destination: BinType; reference_photos: string[];
  branding_text?: string[]; volume_ml: number | null; volume_source: string;
  condition_rule?: string | null;
};
export type SiteSeed = {
  site_id: string;
  businesses: { business_id: string; name: string; manager_contact_id: string; property_manager_contact_id?: string }[];
  contacts: ContactRef[];
  stations: { station_id: string; name: string; location: "shared_outdoor" | "in_store" }[];
  cameras: { camera_id: string; station_id: string }[];
  bins: { bin_id: string; station_id: string; name: string; type: BinType; capacity_l: number; camera_id: string; emptying_contact_id?: string; initial_contents_known?: boolean }[];
  catalog: CatalogRecord[];
};
export type EventRecord = {
  raw: DisposalEvent; received_at: string; item_id: string | null; business_id: string | null;
  actual_destination: BinType | null; expected_destination: BinType | null;
  correctness: "correct" | "incorrect" | "unassessable";
  review_status: "pending" | "resolved" | "unresolved" | "not_required";
  reviewed_business_id?: string | null;
};
export type FeedRecord = {
  cursor: string; at: string;
  type: "disposal" | "alert_opened" | "message_sent" | "reply_received" | "intervention_recorded" | "bin_emptied" | "illustration_ready" | "review_queued" | "review_resolved";
  ref: { event_id?: string; alert_id?: string; bin_id?: string; item_id?: string };
  summary: string; demo: boolean; mocked?: boolean;
};
export type AlertRecord = {
  alert_id: string; kind: "recommendation" | "emptying";
  item_id?: string; business_id?: string; bin_id?: string;
  contact: ContactRef; state: "open" | "acknowledged" | "action_confirmed" | "resolved";
  created_at: string; sent_at?: string; responded_at?: string; follow_up_queued: boolean;
  body: string;
};
export type MessageRecord = {
  message_id: string; alert_id: string | null; contact_id?: string; body: string; direction: "outbound" | "inbound";
  at: string; provider_message_id?: string; mocked?: boolean;
  delivery_status?: "pending" | "sending" | "sent" | "failed" | "cancelled";
  error?: string;
};
export type InterventionRecord = { intervention_id: string; alert_id: string; item_id: string; business_id: string; action: string; confirmed_at: string };
export type EmptyingRecord = { emptying_id: string; bin_id: string; emptied_at: string; confirmed_at: string; provider_message_id: string };
export type ImageRecord = { snapshot: BinInventorySnapshot; result: Awaited<ReturnType<Illustrator["illustrate"]>> };
export type JobRecord = {
  job_id: string; kind: "message" | "image"; status: "pending" | "sending" | "sent" | "failed" | "cancelled";
  created_at: string; epoch: number; error?: string;
  message?: Parameters<Messenger["send"]>[0]; snapshot?: BinInventorySnapshot;
};
export type ReplyRecord = { reply: InboundReply; status: "processing" | "applied" | "needs_clarification"; error?: string };
export type CoreState = {
  schema_version: 1; epoch: number; sequence: number; seed: SiteSeed; config: CoreConfig;
  events: Record<string, EventRecord>; alerts: AlertRecord[]; messages: MessageRecord[];
  interventions: InterventionRecord[]; emptyings: EmptyingRecord[]; images: Record<string, ImageRecord>;
  jobs: JobRecord[]; replies: Record<string, ReplyRecord>; feed: FeedRecord[];
};
export function initialState(seed: SiteSeed, config: CoreConfig, epoch = 0): CoreState {
  return { schema_version: 1, epoch, sequence: 0, seed: structuredClone(seed), config: structuredClone(config), events: {}, alerts: [], messages: [], interventions: [], emptyings: [], images: {}, jobs: [], replies: {}, feed: [] };
}
