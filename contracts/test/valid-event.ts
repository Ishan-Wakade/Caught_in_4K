// The contracts/README.md §1 example, with a 16-hex event_id.
export const validEvent = {
  event_id: "evt_3f9a1c2b7d10e4a5",
  source: { camera_id: "cam_patio_1", clip_id: "clip_demo_v1", track_id: 17, mode: "recorded" },
  bin_id: "bin_patio_trash",
  occurred_at: "2026-10-17T15:02:41.300Z",
  clip_offset_s: 41.3,
  destination_confidence: 0.92,
  item: {
    catalog_item_id: "item_beanco_cup",
    label: "paper coffee cup",
    confidence: 0.81,
    candidates: [
      { catalog_item_id: "item_beanco_cup", score: 0.81 },
      { catalog_item_id: "item_generic_cup", score: 0.12 },
    ],
  },
  business: { business_id: "biz_beanco", confidence: 0.74, basis: ["logo_text", "reference_match"] },
  evidence: [{ kind: "crop", uri: "evidence/clip_demo_v1/17_entry.jpg", frame: 1239 }],
};

export const withPatch = (patch: (e: any) => void) => {
  const copy = structuredClone(validEvent) as any;
  patch(copy);
  return copy;
};
