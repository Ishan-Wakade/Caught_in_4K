import type { Messenger, Illustrator, ReplyInterpreter } from "@recyclone/contracts";
/** Local contract-shaped stubs until S's adapters are wired. All outputs are mocked. */
export function createLocalMocks(clock: () => Date = () => new Date()) {
  let sent = 0;
  const messenger: Messenger = { async send() { return { providerMessageId: `core_mock_${++sent}`, sentAt: clock().toISOString(), mocked: true }; } };
  const illustrator: Illustrator = { async illustrate(snapshot) {
    const escape = (text: string) => text.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="240"><rect width="100%" height="100%" fill="#eef4ef"/><text x="24" y="40" font-size="22">MOCKED — estimated inventory</text><text x="24" y="82">${escape(snapshot.binId)}: ${(snapshot.estimatedFullness * 100).toFixed(0)}% estimated</text><text x="24" y="120">${escape(snapshot.items.map(i => `${i.name}: ${i.count}`).join(", "))}</text><text x="24" y="160">Unknown volume/items: ${snapshot.unknownCount}</text><text x="24" y="200">Illustrative placeholder; not a Grok generation</text></svg>`;
    return { imageUrl: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`, generatedAt: clock().toISOString(), snapshotId: snapshot.snapshotId, mocked: true };
  } };
  const interpreter: ReplyInterpreter = { async interpret(reply, alerts) {
    const named = alerts.filter(a => reply.body.includes(a.alertId) || (a.binName && reply.body.toLowerCase().includes(a.binName.toLowerCase())));
    const alert = named.length === 1 ? named[0] : named.length === 0 && alerts.length === 1 ? alerts[0] : undefined;
    if (!alert) return { alertId: null, intent: "unclear" };
    const text = reply.body.toLowerCase();
    // Conservative mock grammar: do not interpret "not installed" or promises as completion.
    if (/\b(not|haven't|haven’t|didn't|didn’t|will|later|tomorrow)\b/.test(text)) return { alertId: alert.alertId, intent: "unclear" };
    if (alert.kind === "emptying" && /\b(emptied|emptying completed)\b/.test(text)) return { alertId: alert.alertId, intent: "bin_emptied" };
    if (alert.kind === "recommendation" && /\b(installed|put up|action completed)\b/.test(text)) return { alertId: alert.alertId, intent: "action_confirmed" };
    if (/^(ok|okay|thanks|received|acknowledged)\b/.test(text)) return { alertId: alert.alertId, intent: "acknowledged" };
    return { alertId: alert.alertId, intent: "unclear" };
  } };
  return { messenger, illustrator, interpreter };
}
