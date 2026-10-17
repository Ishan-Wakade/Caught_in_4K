"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import type { Range } from "@/lib/dashboard/sample";

type Filters = { site: string; setSite: (s: string) => void; range: Range; setRange: (r: Range) => void };

const Ctx = createContext<Filters | null>(null);

/** Site and date range, shared by every dashboard tab so switching tabs keeps the same slice. */
export function DashboardProvider({ children }: { children: ReactNode }) {
  const [site, setSite] = useState("all");
  const [range, setRange] = useState<Range>("7d");
  return <Ctx.Provider value={{ site, setSite, range, setRange }}>{children}</Ctx.Provider>;
}

export function useFilters(): Filters {
  const v = useContext(Ctx);
  if (!v) throw new Error("useFilters must be used inside <DashboardProvider>");
  return v;
}
