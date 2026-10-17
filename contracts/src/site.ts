import { z } from "zod";
import { DestinationSchema } from "./event.js";

const id = z.string().min(1);
const unit = z.number().min(0).max(1);

export const SiteSchema = z.object({ site_id: id, name: z.string() });
export const BusinessSchema = z.object({ business_id: id, name: z.string() });

export const ContactSchema = z.object({
  contact_id: id,
  name: z.string(),
  role: z.enum(["property_manager", "restaurant_manager", "area_manager"]),
  business_id: id.nullable(),
  phone: z.string().nullable(),
  handle: z.string().nullable(),
});

export const StationSchema = z.object({ station_id: id, name: z.string() });

/** A bin opening in a camera's frame, normalized to 0..1 of width/height. */
export const BinRegionSchema = z.object({ bin_id: id, x: unit, y: unit, w: unit, h: unit });

export const CameraSchema = z.object({
  camera_id: id,
  station_id: id,
  name: z.string(),
  bin_regions: z.array(BinRegionSchema),
});

export const BinSchema = z.object({
  bin_id: id,
  station_id: id,
  name: z.string(),
  type: DestinationSchema,
  capacity_l: z.number().positive(),
  /** Estimated contents when monitoring starts (onboarding assumption). */
  initial_volume_l: z.number().min(0),
  /** The one camera whose events count for this bin. */
  camera_id: id,
  emptying_contact_id: id.nullable(),
});

export const CatalogItemSchema = z.object({
  catalog_item_id: id,
  name: z.string(),
  business_id: id.nullable(),
  reference_photos: z.array(z.string()),
  branding_text: z.array(z.string()),
  destination: DestinationSchema,
  condition_rule: z.string().nullable(),
  volume_ml: z.number().positive(),
  volume_source: z.string().min(1),
});

export const ConfigProfileSchema = z.object({
  half_life_hours: z.number().positive(),
  correct_threshold_pct: z.number().min(0).max(100).nullable(),
  min_assessed_events: z.int().min(1),
  evidence_window_hours: z.number().positive().nullable(),
  fullness_alert_threshold: z.number().positive().nullable(),
  item_confidence_threshold: unit,
  business_confidence_threshold: unit,
  /** Keys whose values are placeholders, not user decisions. */
  provisional: z.array(z.string()),
});

export const DemoSiteSchema = z.object({
  site: SiteSchema,
  businesses: z.array(BusinessSchema),
  contacts: z.array(ContactSchema),
  stations: z.array(StationSchema),
  cameras: z.array(CameraSchema),
  bins: z.array(BinSchema),
  catalog: z.array(CatalogItemSchema),
  config_profiles: z.object({ normal: ConfigProfileSchema, demo: ConfigProfileSchema }),
  /** Site-level fields that are placeholders, not user decisions. */
  provisional: z.array(z.string()),
});

export type Contact = z.infer<typeof ContactSchema>;
export type Camera = z.infer<typeof CameraSchema>;
export type Bin = z.infer<typeof BinSchema>;
export type CatalogItem = z.infer<typeof CatalogItemSchema>;
export type ConfigProfile = z.infer<typeof ConfigProfileSchema>;
export type DemoSite = z.infer<typeof DemoSiteSchema>;

/** Cross-reference checks the schema cannot express. Returns human-readable problems; empty means OK. */
export function checkSiteIntegrity(site: DemoSite): string[] {
  const problems: string[] = [];
  const idsOf = <T>(kind: string, rows: T[], key: (r: T) => string) => {
    const seen = new Set<string>();
    for (const r of rows) {
      const k = key(r);
      if (seen.has(k)) problems.push(`duplicate ${kind} id ${k}`);
      seen.add(k);
    }
    return seen;
  };
  const businesses = idsOf("business", site.businesses, (b) => b.business_id);
  const contacts = idsOf("contact", site.contacts, (c) => c.contact_id);
  const stations = idsOf("station", site.stations, (s) => s.station_id);
  const cameras = idsOf("camera", site.cameras, (c) => c.camera_id);
  const bins = idsOf("bin", site.bins, (b) => b.bin_id);
  idsOf("catalog item", site.catalog, (i) => i.catalog_item_id);

  const refs = (what: string, value: string | null, known: Set<string>) => {
    if (value !== null && !known.has(value)) problems.push(`${what} refers to unknown ${value}`);
  };
  for (const c of site.contacts) refs(`contact ${c.contact_id} business`, c.business_id, businesses);
  for (const c of site.cameras) {
    refs(`camera ${c.camera_id} station`, c.station_id, stations);
    for (const r of c.bin_regions) refs(`camera ${c.camera_id} region`, r.bin_id, bins);
  }
  for (const b of site.bins) {
    refs(`bin ${b.bin_id} station`, b.station_id, stations);
    refs(`bin ${b.bin_id} camera`, b.camera_id, cameras);
    refs(`bin ${b.bin_id} emptying contact`, b.emptying_contact_id, contacts);
    const own = site.cameras.find((c) => c.camera_id === b.camera_id);
    if (own && !own.bin_regions.some((r) => r.bin_id === b.bin_id)) {
      problems.push(`bin ${b.bin_id} has no region on its camera ${b.camera_id}`);
    }
  }
  for (const i of site.catalog) refs(`catalog item ${i.catalog_item_id} business`, i.business_id, businesses);
  return problems;
}
