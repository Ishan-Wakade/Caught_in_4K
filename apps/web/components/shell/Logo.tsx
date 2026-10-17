/** A camera (the surveillance feed) with the three-arc recycling mark in its lens. */
export function LogoMark({ size = 30, tone = "light" }: { size?: number; tone?: "light" | "dark" }) {
  const body = tone === "dark" ? "#D9DCD0" : "#3A3C38";
  const c = tone === "dark" ? ["#A3A59F", "#8DB3D9", "#8CC474"] : ["#6E706B", "#5B86B0", "#5B9447"];
  return (
    <svg width={size} height={size} viewBox="0 0 44 44" aria-hidden="true">
      {/* Viewfinder bump */}
      <rect x="14" y="9" width="13" height="8" rx="2" fill="none" stroke={body} strokeWidth="3" />
      {/* Camera body */}
      <rect x="2" y="16" width="40" height="22" rx="5" fill="none" stroke={body} strokeWidth="3" />
      {/* Lens ring */}
      <circle cx="22" cy="27" r="10" fill="none" stroke={body} strokeWidth="3" />
      {/* Recycling mark, scaled into the lens */}
      <g transform="translate(13.2,18.2) scale(0.4)">
        <path d="M22 6 A16 16 0 0 1 37.76 24.78" fill="none" stroke={c[0]} strokeWidth="6" strokeLinecap="round" />
        <path d="M35.86 30 A16 16 0 0 1 11.72 34.26" fill="none" stroke={c[1]} strokeWidth="6" strokeLinecap="round" />
        <path d="M8.14 30 A16 16 0 0 1 16.53 6.96" fill="none" stroke={c[2]} strokeWidth="6" strokeLinecap="round" />
      </g>
    </svg>
  );
}
