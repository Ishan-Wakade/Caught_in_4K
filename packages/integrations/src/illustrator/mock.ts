import type { BinInventorySnapshot, Illustrator } from "@recyclone/contracts";

type IllustrateResult = Awaited<ReturnType<Illustrator["illustrate"]>>;

function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c] as string));
}

// Renders the snapshot's own data as a labeled placeholder image instead of
// calling Grok Imagine, so core/web can build against a real BinInventorySnapshot
// -> image round trip before Grok credentials exist. Output is a self-contained
// data: URI (no network, no file storage).
export function renderMockIllustration(snapshot: BinInventorySnapshot): string {
  const lines = [
    `MOCKED ILLUSTRATION`,
    `bin: ${snapshot.binId} (${snapshot.binType})`,
    `snapshot: ${snapshot.snapshotId}`,
    `taken at: ${snapshot.takenAt}`,
    `estimated fullness: ${Math.round(snapshot.estimatedFullness * 100)}%`,
    ...snapshot.items.map((i) => `  ${i.count}x ${i.name}`),
    `unknown items: ${snapshot.unknownCount}`,
  ];

  const lineHeight = 22;
  const height = 40 + lines.length * lineHeight;
  const width = 480;

  const textEls = lines
    .map((line, i) => `<text x="16" y="${40 + i * lineHeight}" font-family="monospace" font-size="14" fill="#1a1a1a">${escapeXml(line)}</text>`)
    .join("");

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<rect width="100%" height="100%" fill="#fef3c7" stroke="#b45309" stroke-width="2"/>` +
    `<text x="16" y="24" font-family="monospace" font-size="12" font-weight="bold" fill="#b45309">GENERATED • ILLUSTRATIVE • MOCKED</text>` +
    textEls +
    `</svg>`;

  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf-8").toString("base64")}`;
}

export class MockIllustrator implements Illustrator {
  async illustrate(snapshot: BinInventorySnapshot): Promise<IllustrateResult> {
    return {
      imageUrl: renderMockIllustration(snapshot),
      generatedAt: new Date().toISOString(),
      snapshotId: snapshot.snapshotId,
      mocked: true,
    };
  }
}
