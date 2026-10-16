import type { DisposalEvent, DemoSite } from "@recyclone/contracts";
import { makeEventId } from "@recyclone/contracts/event-id";
import demoSite from "../../../contracts/fixtures/demo-site.json" with { type: "json" };
// Private test site in the real shared format, independent of E's demo story.
export const testSeed: DemoSite = {
  site: { site_id: "site_test", name: "Test" },
  businesses: [{ business_id: "biz_cafe", name: "Test Cafe" }],
  contacts: [
    { contact_id: "manager", name: "Manager", role: "restaurant_manager", business_id: "biz_cafe", phone: null, handle: null },
    { contact_id: "property", name: "Property", role: "property_manager", business_id: "biz_cafe", phone: null, handle: null },
    { contact_id: "area", name: "Area", role: "area_manager", business_id: null, phone: null, handle: null },
  ],
  stations: [{ station_id: "patio", name: "Patio" }, { station_id: "side", name: "Side" }],
  cameras: [
    { camera_id: "camera", station_id: "patio", name: "Patio camera", bin_regions: [{ bin_id: "trash", x: 0, y: 0, w: 0.3, h: 0.3 }, { bin_id: "recycling", x: 0.4, y: 0, w: 0.3, h: 0.3 }] },
    { camera_id: "camera2", station_id: "side", name: "Side camera", bin_regions: [{ bin_id: "compost", x: 0, y: 0, w: 0.3, h: 0.3 }] },
  ],
  bins: [
    { bin_id: "trash", station_id: "patio", name: "Patio trash", type: "trash", capacity_l: 1, initial_volume_l: 0, camera_id: "camera", emptying_contact_id: "area" },
    { bin_id: "recycling", station_id: "patio", name: "Patio recycling", type: "recycling", capacity_l: 1, initial_volume_l: 0, camera_id: "camera", emptying_contact_id: "area" },
    { bin_id: "compost", station_id: "side", name: "Side compost", type: "compost", capacity_l: 1, initial_volume_l: 0, camera_id: "camera2", emptying_contact_id: "area" },
  ],
  catalog: [
    { catalog_item_id: "cup", name: "Cafe cup", business_id: "biz_cafe", destination: "recycling", reference_photos: [], branding_text: [], condition_rule: null, volume_ml: 400, volume_source: "test assumption" },
    { catalog_item_id: "generic", name: "Generic can", business_id: null, destination: "recycling", reference_photos: [], branding_text: [], condition_rule: null, volume_ml: 200, volume_source: "test assumption" },
    { catalog_item_id: "food", name: "Food", business_id: "biz_cafe", destination: "compost", reference_photos: [], branding_text: [], condition_rule: null, volume_ml: 100, volume_source: "test assumption" },
  ],
  config_profiles: demoSite.config_profiles,
  provisional: [],
};
export function event(id: string, overrides: Partial<DisposalEvent> = {}): DisposalEvent {
  const e: DisposalEvent = { event_id: "", source: { camera_id: "camera", clip_id: `clip_${id}`, track_id: 1, mode: "recorded" }, bin_id: "trash", occurred_at: "2026-10-17T12:00:00.000Z", clip_offset_s: 0, destination_confidence: 0.99,
    item: { catalog_item_id: "cup", label: "cup", confidence: 0.99, candidates: [] }, business: { business_id: null, confidence: null, basis: [] }, evidence: [], ...overrides };
  e.event_id = overrides.event_id ?? makeEventId(e.source.camera_id, e.source.clip_id, e.source.track_id, e.bin_id);
  return e;
}
