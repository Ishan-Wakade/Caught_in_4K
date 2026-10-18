import { redirect } from "next/navigation";

/** The dashboard's Live camera is the full-screen camera page (Jolie's layout, the improved model): one page, one look. */
export default function LiveDashboardPage() {
  redirect("/camera");
}
