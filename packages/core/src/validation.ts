import { Ajv } from "ajv";
import formatsPlugin, { type FormatsPlugin } from "ajv-formats";
import type { DisposalEvent } from "@recyclone/contracts";
import type { CatalogRecord, SiteSeed } from "./model.js";
export class CoreError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export function invariant(condition: unknown, message: string, status = 400): asserts condition {
  if (!condition) throw new CoreError(status, message);
}
export function validId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/.test(value) && !["constructor", "prototype"].includes(value);
}
export function instant(value: string): number {
  const time = Date.parse(value);
  invariant(Number.isFinite(time) && /(?:Z|\+00:00)$/.test(value), "Expected an ISO UTC timestamp");
  return time;
}
export function createEventValidator(schema: object): (value: unknown) => DisposalEvent {
  const ajv = new Ajv({ allErrors: true, strict: false });
  (formatsPlugin as unknown as FormatsPlugin)(ajv);
  const validate = ajv.compile(schema);
  return (value) => {
    invariant(validate(value), `Invalid disposal event: ${ajv.errorsText(validate.errors)}`);
    const event = value as DisposalEvent;
    invariant(validId(event.event_id) && validId(event.bin_id) && validId(event.source.camera_id) && validId(event.source.clip_id), "Invalid event/source/bin identifier");
    instant(event.occurred_at);
    for (const confidence of [event.item.confidence, event.business.confidence, event.destination_confidence]) {
      invariant(Number.isFinite(confidence) && confidence >= 0 && confidence <= 1, "Confidence must be between 0 and 1");
    }
    return structuredClone(event);
  };
}
export function validateCatalog(value: unknown): CatalogRecord {
  invariant(value && typeof value === "object", "Expected catalog item");
  const c = value as CatalogRecord;
  invariant(validId(c.catalog_item_id) && typeof c.name === "string" && c.name.trim().length > 0 && c.name.length <= 500, "Invalid catalog identity");
  invariant(c.business_id === null || validId(c.business_id), "Invalid catalog business");
  invariant(["trash", "recycling", "compost"].includes(c.correct_destination), "Invalid disposal destination");
  invariant(Array.isArray(c.reference_photos) && c.reference_photos.every(x => typeof x === "string" && x.length <= 2048), "Invalid reference photos");
  invariant(c.volume_ml === null || (Number.isFinite(c.volume_ml) && c.volume_ml > 0), "Item volume must be positive or unknown");
  invariant(typeof c.volume_source === "string", "Missing volume source");
  invariant(c.condition_rule == null || typeof c.condition_rule === "string", "Invalid condition rule");
  return structuredClone(c);
}
export function validateSeed(seed: SiteSeed): SiteSeed {
  invariant(validId(seed.site_id), "Invalid site ID");
  for (const [records, key] of [[seed.businesses, "business_id"], [seed.contacts, "contactId"], [seed.stations, "station_id"], [seed.cameras, "camera_id"], [seed.bins, "bin_id"], [seed.catalog, "catalog_item_id"]] as const) {
    invariant(Array.isArray(records), `Missing ${key} collection`);
    const ids = records.map(r => (r as unknown as Record<string, unknown>)[key]);
    invariant(ids.every(validId) && new Set(ids).size === ids.length, `Invalid or duplicate ${key}`);
  }
  for (const c of seed.catalog) {
    validateCatalog(c);
    invariant(c.business_id === null || seed.businesses.some(b => b.business_id === c.business_id), "Unknown catalog business");
  }
  for (const station of seed.stations) invariant(["shared_outdoor", "in_store"].includes(station.location), "Invalid station location");
  for (const camera of seed.cameras) invariant(seed.stations.some(s => s.station_id === camera.station_id), "Unknown camera station");
  for (const bin of seed.bins) {
    invariant(Number.isFinite(bin.capacity_l) && bin.capacity_l > 0, "Bin capacity must be positive");
    invariant(["trash", "recycling", "compost"].includes(bin.type), "Invalid bin type");
    invariant(seed.stations.some(s => s.station_id === bin.station_id), "Unknown bin station");
    invariant(seed.cameras.some(c => c.camera_id === bin.camera_id && c.station_id === bin.station_id), "Invalid authoritative camera");
    invariant(!bin.emptying_contact_id || seed.contacts.some(c => c.contactId === bin.emptying_contact_id), "Unknown emptying contact");
  }
  for (const business of seed.businesses) {
    invariant(seed.contacts.some(c => c.contactId === business.manager_contact_id), "Unknown restaurant manager");
    invariant(!business.property_manager_contact_id || seed.contacts.some(c => c.contactId === business.property_manager_contact_id), "Unknown property manager");
  }
  return structuredClone(seed);
}
