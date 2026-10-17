/**
 * Scripted MOCK run: one instance of every demo scenario from the root AGENTS.md,
 * on a compressed clock (seconds from start), using E's demo-site catalog and
 * demo-profile parameters (3 assessed events, 60% goal, 80% full).
 */
export type ScriptStep = {
  at: number;
  kind: "disposal";
  item: string | null;
  label: string;
  bin: string;
  /** The event's own business guess (contract §6 rule 2), for items without a catalog business. */
  business?: { business_id: string; confidence: number }[];
};

const cup = "item_beanco_cup";
const box = "item_tacostop_box";
const bowl = "item_greenbowl_bowl";
const genericCup = "item_generic_cup";
const chips = "item_chip_bag";
const T = "bin_patio_trash";
const R = "bin_patio_recycling";
const C = "bin_patio_compost";

export const SCRIPT: ScriptStep[] = [
  // Scenario 1: correct disposals.
  { at: 3, kind: "disposal", item: cup, label: "clear plastic cup", bin: R },
  { at: 8, kind: "disposal", item: box, label: "fiber clamshell", bin: C },
  // Scenario 2 (start): the recyclable cup keeps going into trash.
  { at: 13, kind: "disposal", item: cup, label: "clear plastic cup", bin: T },
  // Scenario 5: unknown item → unassessable, not a mistake.
  { at: 18, kind: "disposal", item: null, label: "crumpled object", bin: C },
  // Third assessed cup event: 1 of 3 correct (33% < 60%) → recommendation to Bean Co.
  { at: 23, kind: "disposal", item: cup, label: "clear plastic cup", bin: T },
  // Scenario 4: unbranded cup with a faint Bean Co. logo match → area-manager review, no restaurant message.
  {
    at: 28,
    kind: "disposal",
    item: genericCup,
    label: "clear plastic cup",
    bin: T,
    business: [{ business_id: "biz_beanco", confidence: 0.41 }],
  },
  { at: 33, kind: "disposal", item: chips, label: "chip bag", bin: T },
  // Scenario 3: the trash bin started ~78% full (assumed in the site file); these drops take it past 80% → emptying request.
  { at: 38, kind: "disposal", item: box, label: "fiber clamshell", bin: T },
  { at: 43, kind: "disposal", item: bowl, label: "molded-fiber bowl", bin: C },
  { at: 48, kind: "disposal", item: box, label: "fiber clamshell", bin: T },
  // Staged "after" disposals (illustrative only, not an impact result).
  { at: 175, kind: "disposal", item: cup, label: "clear plastic cup", bin: R },
  { at: 182, kind: "disposal", item: cup, label: "clear plastic cup", bin: R },
];

export const SCRIPT_LENGTH_S = Math.max(...SCRIPT.map((s) => s.at));
