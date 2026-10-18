import type { Metadata } from "next";
import { UploadFlow } from "@/components/upload/UploadFlow";

export const metadata: Metadata = { title: "Try your video", description: "Run the voice guide on a video of you throwing something away" };

export default function UploadPage() {
  return <UploadFlow />;
}
