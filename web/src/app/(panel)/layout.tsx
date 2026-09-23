import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { isAuthed } from "@/lib/session";

export default async function PanelLayout({ children }: { children: React.ReactNode }) {
  const jar = await cookies();
  if (!isAuthed(jar.get("docktopus_session")?.value)) redirect("/login");
  return <Shell>{children}</Shell>;
}
