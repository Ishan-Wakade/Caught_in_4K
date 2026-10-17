import { useId } from "react";
import { BIN_HEX } from "@/lib/format";
import type { BinStatus } from "@/lib/types";

/** True when nothing at all is known about the bin's contents yet. */
export function fillUnknown(bin: BinStatus): boolean {
  return !bin.initial_contents_known && bin.assumed_initial_l === 0 && bin.observed_counts.length === 0 && !bin.observed_total && bin.unknown_count === 0;
}

// Interior of the large bin drawing (viewBox 0 0 380 390): y=72 is full, y=372 is empty.
const TOP = 72;
const BOTTOM = 372;
const levelY = (fraction: number) => BOTTOM - Math.min(1, Math.max(0, fraction)) * (BOTTOM - TOP);

/** Simple stand-in shapes for observed items, used when no real illustration is available. */
function DrawnContents({ bin, y }: { bin: BinStatus; y: number }) {
  const seen = bin.observed_counts.reduce((a, c) => a + c.count, 0) || bin.observed_total || 0;
  const n = Math.min(9, seen + bin.unknown_count);
  const span = BOTTOM - y;
  if (n === 0 || span < 24) return null;
  const shapes = [];
  for (let i = 0; i < n; i++) {
    const cx = 80 + ((i * 67) % 150);
    const cy = y + 18 + ((i * 41) % Math.max(1, span - 40));
    const rot = ((i * 37) % 60) - 30;
    const k = i % 3;
    shapes.push(
      <g key={i} transform={`rotate(${rot} ${cx} ${cy})`} opacity="0.95">
        {k === 0 && <path d={`M${cx - 20} ${cy - 24} h40 l-7 48 q-1 4 -5 4 h-16 q-4 0 -5 -4 z`} fill="#F7F1E4" />}
        {k === 1 && <rect x={cx - 26} y={cy - 14} width="52" height="28" rx="6" fill="#E9DCC4" />}
        {k === 2 && <path d={`M${cx - 22} ${cy} q10 -20 30 -12 q18 8 10 24 q-20 12 -36 2 q-8 -6 -4 -14 z`} fill="#FBF8F1" />}
      </g>,
    );
  }
  return <g>{shapes}</g>;
}

/** Large bin: the bin itself fills to the estimated level, with the illustration inside. */
export function BinFigure({ bin, height = 300 }: { bin: BinStatus; height?: number }) {
  const uid = useId().replace(/:/g, "");
  const c = BIN_HEX[bin.type];
  const unknown = fillUnknown(bin);
  const y = levelY(bin.estimated_fullness);
  const ty = levelY(bin.fullness_threshold);
  const ill = bin.illustration;
  const showImage = ill && !ill.mocked;
  const label = unknown
    ? `${bin.name}, fill level unknown`
    : `${bin.name} drawn about ${Math.round(bin.estimated_fullness * 100)}% full${ill ? ", with an AI illustration of its estimated contents" : ""}`;

  return (
    <svg viewBox="0 0 380 390" style={{ height, width: "auto", maxWidth: "100%" }} className="block" role="img" aria-label={label}>
      <defs>
        <clipPath id={`in-${uid}`}>
          <path d="M44 72 L256 72 L237 362 Q235 372 225 372 L75 372 Q65 372 63 362 Z" />
        </clipPath>
        <clipPath id={`lvl-${uid}`}>
          <rect x="0" y={y} width="300" height={BOTTOM - y + 10} />
        </clipPath>
        <pattern id={`hatch-${uid}`} width="14" height="14" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="14" height="14" fill={c.body} />
          <rect width="5" height="14" fill={c.layer1} opacity="0.5" />
        </pattern>
        <filter id={`sh-${uid}`} x="-20%" y="-10%" width="140%" height="130%">
          <feDropShadow dx="0" dy="12" stdDeviation="12" floodColor="#5A4A30" floodOpacity="0.16" />
        </filter>
      </defs>

      <path
        d="M40 66 L260 66 L240 364 Q238 376 226 376 L74 376 Q62 376 60 364 Z"
        fill={unknown ? `url(#hatch-${uid})` : c.body}
        filter={`url(#sh-${uid})`}
      />

      {!unknown && (
        <g clipPath={`url(#in-${uid})`}>
          <g style={{ transition: "transform 700ms ease" }}>
            <path d={`M30 ${y} Q70 ${y - 18} 112 ${y - 4} T194 ${y - 8} T276 ${y} L276 380 L30 380 Z`} fill={c.layer1} />
            <path d={`M30 ${y + (BOTTOM - y) * 0.45} Q90 ${y + (BOTTOM - y) * 0.45 - 20} 150 ${y + (BOTTOM - y) * 0.45 - 4} T276 ${y + (BOTTOM - y) * 0.45 - 6} L276 380 L30 380 Z`} fill={c.layer2} />
          </g>
          {showImage ? (
            <image
              href={ill.image_url}
              x="44"
              y={y}
              width="212"
              height={Math.max(0, BOTTOM - y)}
              preserveAspectRatio="xMidYMid slice"
              clipPath={`url(#lvl-${uid})`}
            />
          ) : (
            <DrawnContents bin={bin} y={y} />
          )}
        </g>
      )}

      {unknown && (
        <text x="150" y="230" textAnchor="middle" fontFamily="var(--font-dm-sans), sans-serif" fontSize="15" fill={c.ink}>
          fill level unknown
        </text>
      )}

      <rect x="120" y="28" width="60" height="16" rx="8" fill={c.fill} />
      <rect x="24" y="40" width="252" height="28" rx="14" fill={c.fill} />
      <line x1="44" y1={ty} x2="256" y2={ty} stroke="#2F332B" strokeOpacity="0.55" strokeWidth="2" strokeDasharray="6 6" />
      <text x="266" y={ty + 5} fontFamily="var(--font-dm-sans), sans-serif" fontSize="14" fill="#5E6357">
        empty at {Math.round(bin.fullness_threshold * 100)}%
      </text>
    </svg>
  );
}

/** Small bin glyph for the overview band. */
export function MiniBin({ bin }: { bin: BinStatus }) {
  const uid = useId().replace(/:/g, "");
  const c = BIN_HEX[bin.type];
  const unknown = fillUnknown(bin);
  // Interior y=23 (full) … 114 (empty) in viewBox 0 0 100 120.
  const y = 114 - Math.min(1, bin.estimated_fullness) * 91;
  const ty = 114 - bin.fullness_threshold * 91;
  return (
    <svg width="68" height="82" viewBox="0 0 100 120" role="img" aria-label={unknown ? `${bin.name}, fill level unknown` : `${bin.name} about ${Math.round(bin.estimated_fullness * 100)}% full`}>
      <defs>
        <clipPath id={`m-${uid}`}>
          <path d="M15 23 L85 23 L79 111 Q78 114 75 114 L25 114 Q22 114 21 111 Z" />
        </clipPath>
        <pattern id={`mh-${uid}`} width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="8" height="8" fill="#F5F2EA" />
          <rect width="3" height="8" fill="#D6E3CA" />
        </pattern>
      </defs>
      <path d="M13 21 L87 21 L81 112 Q80 117 75 117 L25 117 Q20 117 19 112 Z" fill={unknown ? `url(#mh-${uid})` : "#F5F2EA"} />
      {!unknown && <rect x="0" y={y} width="100" height={120 - y} fill={c.fill} clipPath={`url(#m-${uid})`} />}
      <rect x="6" y="8" width="88" height="11" rx="5.5" fill={c.fill} />
      <line x1="15" y1={ty} x2="85" y2={ty} stroke="#2F332B" strokeOpacity="0.6" strokeWidth="1.5" strokeDasharray="3 3" />
    </svg>
  );
}
