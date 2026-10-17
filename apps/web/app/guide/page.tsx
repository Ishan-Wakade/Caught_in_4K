import type { Metadata } from "next";
import GuideCamera from "@/components/guide/GuideCamera";

export const metadata: Metadata = { title: "Bin guide", description: "Voice guidance at the bin (camera page)" };

export default function GuidePage() {
  return <GuideCamera />;
}
