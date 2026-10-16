import {
  CatalogItemSchema, DemoSiteSchema, DisposalEventSchema, checkSiteIntegrity,
  type CatalogItem, type DemoSite, type DisposalEvent,
} from "@recyclone/contracts";
export class CoreError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export function invariant(condition: unknown, message: string, status = 400): asserts condition {
  if (!condition) throw new CoreError(status, message);
}
export function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 500;
}
export function instant(value: string): number {
  const time = Date.parse(value);
  invariant(Number.isFinite(time) && /(?:Z|\+00:00)$/.test(value), "Expected an ISO UTC timestamp");
  return time;
}
/** Use E's browser-safe Zod source of truth; no copied schema or temporary types. */
export function createEventValidator(): (value: unknown) => DisposalEvent {
  return value => {
    const parsed = DisposalEventSchema.safeParse(value);
    invariant(parsed.success, parsed.success ? "" : `Invalid disposal event: ${parsed.error.message}`);
    instant(parsed.data.occurred_at);
    return parsed.data;
  };
}
export function validateCatalog(value: unknown): CatalogItem {
  const parsed = CatalogItemSchema.safeParse(value);
  invariant(parsed.success, parsed.success ? "" : `Invalid catalog item: ${parsed.error.message}`);
  return parsed.data;
}
export function validateSeed(value: unknown): DemoSite {
  const parsed = DemoSiteSchema.safeParse(value);
  invariant(parsed.success, parsed.success ? "" : `Invalid site configuration: ${parsed.error.message}`);
  const problems = checkSiteIntegrity(parsed.data);
  invariant(problems.length === 0, problems.join("; "));
  // Bin-region and station relationships are meaningful to core's authoritative camera rule.
  for (const bin of parsed.data.bins) {
    invariant(parsed.data.cameras.find(c => c.camera_id === bin.camera_id)?.station_id === bin.station_id, "Bin/camera station mismatch");
  }
  return parsed.data;
}
