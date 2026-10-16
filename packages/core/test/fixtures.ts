import type { DisposalEvent } from "@recyclone/contracts";
import type { SiteSeed } from "../src/model.js";
// Private unit-test input, not E's shared demo fixture or a wire contract.
export const testSeed: SiteSeed = {
  site_id: "site_test",
  businesses: [{ business_id: "biz_cafe", name: "Test Cafe", manager_contact_id: "manager", property_manager_contact_id: "property" }],
  contacts: [{ contactId: "manager" }, { contactId: "property" }, { contactId: "area" }],
  stations: [{ station_id: "patio", name: "Patio", location: "shared_outdoor" }, { station_id: "side", name: "Side", location: "shared_outdoor" }],
  cameras: [{ camera_id: "camera", station_id: "patio" }, { camera_id: "camera2", station_id: "side" }],
  bins: [
    { bin_id: "trash", station_id: "patio", name: "Patio trash", type: "trash", capacity_l: 1, camera_id: "camera", emptying_contact_id: "area", initial_contents_known: true },
    { bin_id: "recycling", station_id: "patio", name: "Patio recycling", type: "recycling", capacity_l: 1, camera_id: "camera", emptying_contact_id: "area", initial_contents_known: true },
    { bin_id: "compost", station_id: "side", name: "Side compost", type: "compost", capacity_l: 1, camera_id: "camera2", emptying_contact_id: "area", initial_contents_known: true },
  ],
  catalog: [
    { catalog_item_id: "cup", name: "Cafe cup", business_id: "biz_cafe", correct_destination: "recycling", reference_photos: [], volume_ml: 400, volume_source: "test assumption" },
    { catalog_item_id: "generic", name: "Generic can", business_id: null, correct_destination: "recycling", reference_photos: [], volume_ml: 200, volume_source: "test assumption" },
    { catalog_item_id: "food", name: "Food", business_id: "biz_cafe", correct_destination: "compost", reference_photos: [], volume_ml: null, volume_source: "unknown" },
  ],
};
export function event(id: string, overrides: Partial<DisposalEvent> = {}): DisposalEvent {
  return { event_id: id, source: { camera_id: "camera", clip_id: "clip", track_id: 1, mode: "recorded" }, bin_id: "trash", occurred_at: "2026-10-17T12:00:00.000Z", clip_offset_s: 0, destination_confidence: 0.99,
    item: { catalog_item_id: "cup", label: "cup", confidence: 0.99, candidates: [] }, business: { business_id: null, confidence: 0, basis: [] }, evidence: [], ...overrides };
}
