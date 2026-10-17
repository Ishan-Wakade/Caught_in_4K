import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { POST as ingest } from "../../../apps/web/app/api/events/route.js";
import { getCore } from "../../../apps/web/app/api/_core/runtime.js";
const python = process.env.CORE_TEST_PYTHON ?? "python3";
const available = spawnSync(python, ["-c", "import jsonschema"], { stdio: "ignore" }).status === 0;

test("E's real Python HTTP client sends all fixtures through API/S mock adapters and replay deduplicates", { skip: !available }, async () => {
  const previous = { ...process.env };
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const dir = await mkdtemp(join(tmpdir(), "recyclone-worker-client-"));
  const shared = globalThis as typeof globalThis & { recycloneCore?: ReturnType<typeof getCore> };
  Object.assign(process.env, { CONFIG_PROFILE: "demo", CORE_STORAGE: "memory", RECYCLONE_ROOT: root, WORKER_INGEST_TOKEN: "worker_client_test", ILLUSTRATOR_MODE: "mock" });
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const req = new Request("http://localhost/api/events", { method: "POST", headers: { authorization: request.headers.authorization ?? "", "content-type": "application/json" }, body: Buffer.concat(chunks) });
    const result = await ingest(req);
    response.writeHead(result.status, { "Content-Type": "application/json" }); response.end(await result.text());
  });
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const script = `
import json, sys
from datetime import datetime, timezone
from pathlib import Path
from recyclone_worker.client import HttpSink
from recyclone_worker.events import validate_event
sink = HttpSink(sys.argv[1], "worker_client_test", Path(sys.argv[2]) / "outbox.jsonl")
events = [json.loads(line) for line in Path(sys.argv[3]).read_text().splitlines() if line.strip()]
for event in events:
    event["occurred_at"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    validate_event(event)
    assert sink.send(event) == "created"
for event in events:
    assert sink.send(event) == "duplicate"
print(json.dumps(dict(sink.stats)))
`;
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(python, ["-c", script, `http://127.0.0.1:${address.port}`, dir, join(root, "contracts/fixtures/synthetic-events.jsonl")], { env: { ...process.env, PYTHONPATH: join(root, "worker") }, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      child.stdout.on("data", data => stdout += data); child.stderr.on("data", data => stderr += data);
      child.once("error", reject); child.once("exit", code => code === 0 ? resolve(stdout) : reject(new Error(`Worker HTTP test failed (${code}): ${stderr}`)));
    });
    assert.deepEqual(JSON.parse(output), { created: 11, duplicate: 11 });
    const core = await getCore();
    assert.equal((await core.getFeed()).items.filter(f => f.type === "disposal").length, 11);
    assert.equal((await core.getReviews()).length, 1);
    const alerts = await core.getAlerts(); assert.ok(alerts.some(a => a.kind === "recommendation")); assert.ok(alerts.some(a => a.kind === "emptying"));
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (shared.recycloneCore) await (await shared.recycloneCore).close(); delete shared.recycloneCore;
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]; Object.assign(process.env, previous);
    await rm(dir, { recursive: true, force: true });
  }
});
