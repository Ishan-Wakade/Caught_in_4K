import type { BinStatus } from "@/lib/types";

const FILL: Record<BinStatus["type"], string> = {
  trash: "#3f3f46",
  recycling: "#1d4ed8",
  compost: "#15803d",
};

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** MOCK stand-in for a Grok Imagine image: a placeholder that just shows the snapshot data. */
export function mockIllustrationSvg(bin: BinStatus, takenAt: string): string {
  const lines = [
    ...bin.observed_counts.map((c) => `${c.count} × ${c.name}`),
    ...(bin.unknown_count ? [`${bin.unknown_count} × unknown`] : []),
  ];
  const level = Math.min(1, bin.estimated_fullness);
  const h = 220;
  const fillH = Math.round(level * 160);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="${h}" viewBox="0 0 320 ${h}">
  <rect width="320" height="${h}" fill="#0b0f14"/>
  <rect x="20" y="40" width="110" height="160" rx="8" fill="none" stroke="${FILL[bin.type]}" stroke-width="4"/>
  <rect x="22" y="${200 - fillH}" width="106" height="${fillH}" rx="6" fill="${FILL[bin.type]}" opacity="0.7"/>
  <text x="20" y="26" fill="#fbbf24" font-family="monospace" font-size="13" font-weight="bold">MOCK ILLUSTRATION</text>
  ${(lines.length ? lines : ["(empty)"])
    .slice(0, 8)
    .map((l, i) => `<text x="145" y="${60 + i * 18}" fill="#e5e7eb" font-family="sans-serif" font-size="12">${esc(l)}</text>`)
    .join("\n  ")}
  <text x="145" y="205" fill="#9ca3af" font-family="monospace" font-size="10">snapshot ${esc(takenAt.slice(11, 19))}Z</text>
</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
