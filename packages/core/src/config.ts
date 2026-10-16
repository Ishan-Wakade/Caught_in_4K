/** These numeric defaults are implementation assumptions, not user decisions. */
export type CoreConfig = {
  profile: "normal" | "demo";
  halfLifeMs: number;
  evidenceWindowMs: number;
  minAssessedEvents: number;
  correctSortingThreshold: number;
  itemConfidence: number;
  businessConfidence: number;
  destinationConfidence: number;
  fullnessThreshold: number;
  followUpMs: number;
  illustrationRefreshMs: number;
  comparisonWindowMs: number;
};
const DAY = 86_400_000;
export function configFor(profile: CoreConfig["profile"], overrides: Partial<CoreConfig> = {}): CoreConfig {
  const config: CoreConfig = {
    profile, halfLifeMs: 2 * DAY, evidenceWindowMs: 7 * DAY,
    minAssessedEvents: profile === "demo" ? 2 : 5,
    correctSortingThreshold: 80, itemConfidence: 0.7,
    businessConfidence: 0.7, destinationConfidence: 0.7,
    fullnessThreshold: 0.8, followUpMs: profile === "demo" ? 30_000 : DAY,
    illustrationRefreshMs: profile === "demo" ? 5_000 : 300_000,
    comparisonWindowMs: profile === "demo" ? 300_000 : 7 * DAY,
    ...overrides,
  };
  if (config.profile !== profile) throw new Error("Profile override is not allowed");
  for (const key of ["halfLifeMs", "evidenceWindowMs", "followUpMs", "illustrationRefreshMs", "comparisonWindowMs"] as const) {
    if (!Number.isFinite(config[key]) || config[key] <= 0) throw new Error(`Invalid ${key}`);
  }
  if (!Number.isInteger(config.minAssessedEvents) || config.minAssessedEvents < 1) throw new Error("Invalid minAssessedEvents");
  if (!Number.isFinite(config.correctSortingThreshold) || config.correctSortingThreshold < 0 || config.correctSortingThreshold > 100) throw new Error("Invalid correctSortingThreshold");
  for (const key of ["itemConfidence", "businessConfidence", "destinationConfidence", "fullnessThreshold"] as const) {
    if (!Number.isFinite(config[key]) || config[key] <= 0 || config[key] > 1) throw new Error(`Invalid ${key}`);
  }
  return config;
}
