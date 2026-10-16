// Rehearsal server: the same core the dashboard uses, wired like apps/web/app/api/_core/runtime.ts
// (demo profile, in-memory storage, mock messenger/illustrator), behind plain node:http routes.
// For local end-to-end rehearsal of worker -> core only. Not deployed; binds to 127.0.0.1.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { createCore, configFromSite, initialState, MemoryRepository, createEventValidator, createLocalMocks, validateSeed } from "@recyclone/core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const port = Number(process.env.REHEARSAL_PORT ?? 3000);
const token = process.env.WORKER_INGEST_TOKEN ?? "rehearsal";

async function makeCore() {
  const seed = validateSeed(JSON.parse(await readFile(resolve(root, "contracts/fixtures/demo-site.json"), "utf8")));
  const config = configFromSite("demo", seed.config_profiles.demo, {});
  const repository = new MemoryRepository(initialState(seed, config));
  return createCore({ seed, config, repository, ...createLocalMocks(), inboundRepliesMocked: true, validateEvent: createEventValidator() });
}

let core = await makeCore();

const readBody = (req: import("node:http").IncomingMessage) =>
  new Promise<string>((ok, fail) => { let b = ""; req.on("data", c => (b += c)); req.on("end", () => ok(b)); req.on("error", fail); });

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  const send = (status: number, body: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
  try {
    if (req.method === "POST" && url.pathname === "/api/events") {
      if (req.headers.authorization !== `Bearer ${token}`) return send(401, { error: "Invalid worker token" });
      return send(200, await core.ingest(JSON.parse(await readBody(req))));
    }
    if (req.method === "POST" && url.pathname === "/api/demo/reset") { await core.close(); core = await makeCore(); return send(200, { status: "reset" }); }
    if (req.method === "GET" && url.pathname === "/api/feed") return send(200, await core.getFeed(url.searchParams.get("after") ?? ""));
    if (req.method === "GET" && url.pathname === "/api/bins") return send(200, await core.getBins());
    if (req.method === "GET" && url.pathname === "/api/items") return send(200, await core.getItems());
    if (req.method === "GET" && url.pathname === "/api/catalog") return send(200, await core.getCatalog());
    send(404, { error: "not found" });
  } catch (e: any) {
    send(typeof e?.status === "number" ? e.status : 500, { error: e?.message ?? String(e) });
  }
}).listen(port, "127.0.0.1", () => console.log(`rehearsal core on http://127.0.0.1:${port} (token: ${token})`));
