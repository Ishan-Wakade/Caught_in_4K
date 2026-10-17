import { readFile, access } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { resolve } from "node:path";
import type { Messenger, Illustrator, ReplyInterpreter } from "@recyclone/contracts";
import { createCore, configFromSite, initialState, connectPostgres, MemoryRepository, createEventValidator, createLocalMocks, validateSeed, type Core, type CoreConfig, type SiteSeed } from "@recyclone/core";
import { createMessenger, createIllustrator, createReplyInterpreter } from "@recyclone/integrations";

/**
 * Seed fixtures keep every contact's phone as null so real numbers never
 * land in git (contract: demo-site.json is committed, phones are not).
 * CONTACT_PHONES_JSON lets an operator supply them at runtime instead, e.g.
 * CONTACT_PHONES_JSON={"ct_shakeshack_mgr":"+1...","ct_area_mgr":"+1..."}.
 */
function applyContactPhones(seed: SiteSeed, raw: string | undefined) {
  if (!raw) return;
  let phones: Record<string, string>;
  try { phones = JSON.parse(raw); }
  catch { throw new Error("CONTACT_PHONES_JSON must be valid JSON mapping contact_id to phone number"); }
  for (const contact of seed.contacts) {
    const phone = phones[contact.contact_id];
    if (phone) contact.phone = phone;
  }
}

type Adapters = { messenger: Messenger; illustrator: Illustrator; interpreter: ReplyInterpreter };
const shared = globalThis as typeof globalThis & { recycloneCore?: Promise<Core>; recycloneAdapters?: Adapters };
/** S can register real/mock adapters before getCore(); the webhook calls getCore().handleReply(). */
export function configureCoreAdapters(adapters: Adapters) {
  if (shared.recycloneCore) throw new Error("Configure adapters before initializing core");
  shared.recycloneAdapters = adapters;
}
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
  applyContactPhones(seed, process.env.CONTACT_PHONES_JSON);
  const overrides = process.env.CORE_CONFIG_JSON ? JSON.parse(process.env.CORE_CONFIG_JSON) as Partial<CoreConfig> : {};
  const config = configFromSite(profile, seed.config_profiles[profile], overrides);
  let adapters = shared.recycloneAdapters;
  if (!adapters) {
    const messengerMode = process.env.MESSENGER_MODE ?? "mock";
    const illustratorMode = process.env.ILLUSTRATOR_MODE ?? "mock";
    if (messengerMode === "mock" && illustratorMode === "mock") {
      adapters = createLocalMocks();
    } else {
      // At least one mode is "live": wire the real integrations adapters
      // (each factory reads its own mode independently, so e.g. a live
      // messenger with a still-mocked illustrator works correctly here).
      adapters = { messenger: createMessenger(), illustrator: createIllustrator(), interpreter: createReplyInterpreter() };
      configureCoreAdapters(adapters);
    }
  }
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
  return createCore({ seed, config, repository, ...adapters, inboundRepliesMocked: (process.env.MESSENGER_MODE ?? "mock") === "mock", validateEvent: createEventValidator() });
}
