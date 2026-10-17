import type { ReactNode } from "react";
import { BIN_DOT, BIN_INK, BIN_LABEL } from "@/lib/format";
import type { BinType } from "@/lib/types";

export function Dot({ className = "", size = 8 }: { className?: string; size?: number }) {
  return <span aria-hidden="true" className={`inline-block shrink-0 rounded-full ${className}`} style={{ width: size, height: size }} />;
}

/** "● Compost" in the bin's colour. */
export function BinTag({ type, size = 8, bold = false, className = "" }: { type: BinType; size?: number; bold?: boolean; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 ${BIN_INK[type]} ${bold ? "font-bold" : ""} ${className}`}>
      <Dot className={BIN_DOT[type]} size={size} />
      {BIN_LABEL[type]}
    </span>
  );
}

export function Display({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <span className={`font-display leading-none font-extrabold tracking-[-0.02em] ${className}`}>{children}</span>;
}

export function Mono({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <span className={`font-mono ${className}`}>{children}</span>;
}

/** Page container used by the management pages. */
export function Page({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`mx-auto w-full max-w-[1440px] px-10 ${className}`}>{children}</div>;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 py-20 text-center">
      <span className="font-display text-3xl font-bold text-ink">{title}</span>
      {children && <span className="max-w-md text-[15px] text-muted">{children}</span>}
    </div>
  );
}

export function LoadError({ error }: { error: string }) {
  return <Empty title="Couldn't load this">{error}</Empty>;
}
