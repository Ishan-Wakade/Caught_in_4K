/** These numeric defaults are implementation assumptions, not user decisions. */
import type { ConfigProfile } from "@recyclone/contracts";
export type CoreConfig = {
  profile: "normal" | "demo";
  stationLocations: Record<string, "shared_outdoor" | "in_store">;
  halfLifeMs: number;
  evidenceWindowMs: number | null;
  minAssessedEvents: number;
  correctSortingThreshold: number | null;
  itemConfidence: number;
  businessConfidence: number;
  destinationConfidence: number;
  fullnessThreshold: number | null;
  illustrationRefreshMs: number;
  comparisonWindowMs: number;
};
const DAY = 86_400_000;
export function configFor(profile: CoreConfig["profile"], overrides: Partial<CoreConfig> = {}): CoreConfig {
  const config: CoreConfig = {
    profile, stationLocations: {}, halfLifeMs: 2 * DAY, evidenceWindowMs: profile === "normal" ? null : 7 * DAY,
    minAssessedEvents: profile === "demo" ? 2 : 5,
    correctSortingThreshold: profile === "normal" ? null : 80, itemConfidence: 0.7,
    businessConfidence: 0.7, destinationConfidence: 0.7,
    fullnessThreshold: profile === "normal" ? null : 0.8,
    illustrationRefreshMs: profile === "demo" ? 5_000 : 300_000,
    comparisonWindowMs: profile === "demo" ? 300_000 : 7 * DAY,
    ...overrides,
  };
  if (config.profile !== profile) throw new Error("Profile override is not allowed");
  for (const key of ["halfLifeMs", "illustrationRefreshMs", "comparisonWindowMs"] as const) {
    if (!Number.isFinite(config[key]) || config[key] <= 0) throw new Error(`Invalid ${key}`);
  }
  if (!Number.isInteger(config.minAssessedEvents) || config.minAssessedEvents < 1) throw new Error("Invalid minAssessedEvents");
  if (config.evidenceWindowMs !== null && (!Number.isFinite(config.evidenceWindowMs) || config.evidenceWindowMs <= 0)) throw new Error("Invalid evidenceWindowMs");
  if (config.correctSortingThreshold !== null && (!Number.isFinite(config.correctSortingThreshold) || config.correctSortingThreshold < 0 || config.correctSortingThreshold > 100)) throw new Error("Invalid correctSortingThreshold");
  for (const key of ["itemConfidence", "businessConfidence", "destinationConfidence"] as const) {
    if (!Number.isFinite(config[key]) || config[key] < 0 || config[key] > 1) throw new Error(`Invalid ${key}`);
  }
  if (config.fullnessThreshold !== null && (!Number.isFinite(config.fullnessThreshold) || config.fullnessThreshold <= 0)) throw new Error("Invalid fullnessThreshold");
  if (!config.stationLocations || typeof config.stationLocations !== "object" || Array.isArray(config.stationLocations) || Object.values(config.stationLocations).some(v => v !== "shared_outdoor" && v !== "in_store")) throw new Error("Invalid stationLocations");
  return config;
}

/** Unit conversion only. Explicit nulls disable unconfigured alert thresholds. */
export function configFromSite(profile: CoreConfig["profile"], source: ConfigProfile, overrides: Partial<CoreConfig> = {}): CoreConfig {
  return configFor(profile, {
    halfLifeMs: source.half_life_hours * 3_600_000,
    evidenceWindowMs: source.evidence_window_hours === null ? null : source.evidence_window_hours * 3_600_000,
    minAssessedEvents: source.min_assessed_events,
    correctSortingThreshold: source.correct_threshold_pct,
    fullnessThreshold: source.fullness_alert_threshold,
    itemConfidence: source.item_confidence_threshold,
    businessConfidence: source.business_confidence_threshold,
    ...overrides,
  });
}
