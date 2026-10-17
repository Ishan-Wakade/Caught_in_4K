import type { Illustrator } from "@recyclone/contracts";
/** Local contract-shaped stub until S's adapter is wired. All outputs are mocked. */
export function createLocalMocks(clock: () => Date = () => new Date()) {
  const illustrator: Illustrator = { async illustrate(snapshot) {
    const escape = (text: string) => text.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="240"><rect width="100%" height="100%" fill="#eef4ef"/><text x="24" y="40" font-size="22">MOCKED — estimated inventory</text><text x="24" y="82">${escape(snapshot.binId)}: ${(snapshot.estimatedFullness * 100).toFixed(0)}% estimated</text><text x="24" y="120">${escape(snapshot.items.map(i => `${i.name}: ${i.count}`).join(", "))}</text><text x="24" y="160">Unknown volume/items: ${snapshot.unknownCount}</text><text x="24" y="200">Illustrative placeholder; not a Grok generation</text></svg>`;
    return { imageUrl: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`, generatedAt: clock().toISOString(), snapshotId: snapshot.snapshotId, mocked: true };
  } };
  return { illustrator };
}
