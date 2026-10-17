import type { Metadata } from "next";
import { DashboardHeader } from "@/components/dashboard/DashboardHeader";
import { DashboardProvider } from "@/components/dashboard/DashboardContext";

export const metadata: Metadata = { title: "Manager dashboard", description: "What the bins' voice guide announced, per site and camera" };

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <DashboardProvider>
      <div className="flex min-h-screen flex-col bg-paper text-ink">
        <DashboardHeader />
        <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 px-6 pt-10 pb-24 sm:px-10">{children}</main>
      </div>
    </DashboardProvider>
  );
}
