/**
 * MOCK backend configuration, derived from E's shared demo site
 * (`contracts/fixtures/demo-site.json`) so mock and real runs use the same
 * businesses, bins and catalog. Parameters come from its demo profile, which
 * marks every value as provisional.
 */
import { SITE } from "@/lib/site";
import type { BinType, Business, CatalogItem } from "@/lib/types";

export const BUSINESSES: Business[] = SITE.businesses;

export type MockContact = { contact_id: string; name: string; role: string; business_id: string | null };

const ROLE: Record<string, string> = {
  restaurant_manager: "Restaurant manager",
  property_manager: "Property manager",
  area_manager: "Area manager",
};

export const CONTACTS: MockContact[] = SITE.contacts.map((c) => ({
  contact_id: c.contact_id,
  name: c.name,
  role: ROLE[c.role] ?? c.role,
  business_id: c.business_id,
}));

const station = SITE.stations[0];
export const STATION = { station_id: station.station_id, station_name: station.name, camera_id: SITE.cameras[0].camera_id };

export type MockBin = {
  bin_id: string;
  name: string;
  type: BinType;
  capacity_l: number;
  /** Onboarding assumption about contents before monitoring started. */
  initial_volume_l: number;
  emptying_contact_id: string | null;
};

export const BINS: MockBin[] = SITE.bins.map((b) => ({
  bin_id: b.bin_id,
  name: b.name,
  type: b.type,
  capacity_l: b.capacity_l,
  initial_volume_l: b.initial_volume_l,
  emptying_contact_id: b.emptying_contact_id,
}));

const demo = SITE.config_profiles.demo;
export const FULLNESS_THRESHOLD = demo.fullness_alert_threshold ?? 0.8;
export const SCORE_THRESHOLD_PERCENT = demo.correct_threshold_pct ?? 60;
export const MIN_ASSESSED = demo.min_assessed_events;
export const BUSINESS_THRESHOLD = demo.business_confidence_threshold;
/** Demo-shortened no-reply interval before the single follow-up. */
export const FOLLOW_UP_AFTER_MS = demo.follow_up_after_minutes * 60_000;

export const CATALOG: CatalogItem[] = SITE.catalog.map((c) => ({
  catalog_item_id: c.catalog_item_id,
  name: c.name,
  business_id: c.business_id,
  reference_photos: c.reference_photos,
  branding_text: c.branding_text,
  correct_destination: c.destination,
  condition_rule: c.condition_rule,
  volume_ml: c.volume_ml,
  volume_source: c.volume_source,
}));
