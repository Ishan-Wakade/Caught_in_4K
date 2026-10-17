/**
 * Static site configuration from E's shared fixture (`contracts/fixtures/demo-site.json`).
 *
 * Core's API does not return business names, contact names, or the active
 * config profile, so the UI reads them from the same file core is seeded
 * from. Catalog contents still come from the API (core is the source of truth).
 */
import type { DemoSite } from "@recyclone/contracts";
import siteJson from "../../../contracts/fixtures/demo-site.json";
import type { BinType, SiteInfo } from "./types";

export const SITE = siteJson as unknown as DemoSite;

const businessById = new Map(SITE.businesses.map((b) => [b.business_id, b.name]));
const contactById = new Map(SITE.contacts.map((c) => [c.contact_id, c]));
const stationById = new Map(SITE.stations.map((s) => [s.station_id, s.name]));
const binById = new Map(SITE.bins.map((b) => [b.bin_id, b]));

export function businessName(id: string | null | undefined): string | null {
  return id ? (businessById.get(id) ?? id) : null;
}

const ROLE_LABEL: Record<string, string> = {
  restaurant_manager: "Restaurant manager",
  property_manager: "Property manager",
  area_manager: "Area manager",
};

export function contactInfo(id: string): { name: string; role: string; business_id: string | null } {
  const c = contactById.get(id);
  if (!c) return { name: id, role: "Contact", business_id: null };
  return { name: c.name, role: ROLE_LABEL[c.role] ?? c.role, business_id: c.business_id ?? null };
}

export function stationName(id: string): string {
  return stationById.get(id) ?? id;
}

export function binCameraId(binId: string): string {
  return binById.get(binId)?.camera_id ?? "";
}

export function binTypeOf(binId: string | undefined): BinType | null {
  return (binId && binById.get(binId)?.type) || null;
}

/** Demo-profile values from the fixture. Core's own config may differ (see AGENTS.md). */
export const SITE_INFO: SiteInfo = {
  site_name: SITE.site.name,
  threshold_percent: SITE.config_profiles.demo.correct_threshold_pct ?? null,
  fullness_threshold: SITE.config_profiles.demo.fullness_alert_threshold ?? null,
};
