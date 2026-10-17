import { readFile, access } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { resolve } from "node:path";
import { createIntegrationAdapters, integrationMode } from "./adapters.js";
import { createCore, configFromSite, initialState, connectPostgres, MemoryRepository, createEventValidator, validateSeed, type Core, type CoreConfig } from "@recyclone/core";

const shared = globalThis as typeof globalThis & { recycloneCore?: Promise<Core> };
export function getCore(): Promise<Core> {
  if (!shared.recycloneCore) shared.recycloneCore = initialize().catch(error => { shared.recycloneCore = undefined; throw error; });
  return shared.recycloneCore;
}
async function initialize(): Promise<Core> {
  const profile = process.env.CONFIG_PROFILE ?? "normal";
  if (profile !== "normal" && profile !== "demo") throw new Error("CONFIG_PROFILE must be normal or demo");
  let workspace = process.env.RECYCLONE_ROOT;
  if (!workspace) {
    let candidate = process.cwd();
    for (;;) {
      try { await access(resolve(candidate, "contracts/fixtures/demo-site.json")); workspace = candidate; break; }
      catch { const parent = resolve(candidate, ".."); if (parent === candidate) throw new Error("Set RECYCLONE_ROOT to locate contracts/fixtures/demo-site.json"); candidate = parent; }
    }
  }
  const seedPath = process.env.CORE_SITE_CONFIG_PATH ?? resolve(workspace, "contracts/fixtures/demo-site.json");
  const seed = validateSeed(JSON.parse(await readFile(seedPath, "utf8")));
  const overrides = process.env.CORE_CONFIG_JSON ? JSON.parse(process.env.CORE_CONFIG_JSON) as Partial<CoreConfig> : {};
  const config = configFromSite(profile, seed.config_profiles[profile], overrides);
  integrationMode(process.env.ILLUSTRATOR_MODE, "ILLUSTRATOR_MODE");
  const adapters = createIntegrationAdapters();
  const state = initialState(seed, config);
  const storage = process.env.CORE_STORAGE ?? "postgres";
  let repository;
  if (storage === "memory") {
    if (profile !== "demo") throw new Error("Memory storage is only permitted in explicit demo mode");
    repository = new MemoryRepository(state);
  } else if (storage === "postgres") {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for persistent core storage");
    repository = await connectPostgres(process.env.DATABASE_URL, state);
    try { await repository.transaction(s => {
      try { validateSeed(s.seed); } catch { throw new Error("Persisted site uses an older contract; migrate it or use a separate site/database"); }
      if (!isDeepStrictEqual(s.config, config)) throw new Error("Persisted configuration differs from runtime. Use a separate site/database for each profile, or explicitly migrate configuration.");
    }); } catch (error) { await repository.close(); throw error; }
  } else throw new Error("CORE_STORAGE must be postgres or memory");
  return createCore({ seed, config, repository, ...adapters, validateEvent: createEventValidator() });
}
