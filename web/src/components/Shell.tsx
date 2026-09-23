"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

const links = [
  { href: "/", label: "Ambientes" },
  { href: "/environments/new", label: "Nova topologia" },
];

export function Shell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const router = useRouter();

  const fullBleed = path === "/environments/new" || /\/environments\/[^/]+\/edit$/.test(path);

  return (
    <div className={fullBleed ? "grid h-screen w-screen grid-cols-[240px_minmax(0,1fr)] overflow-hidden" : "grid min-h-screen grid-cols-[240px_1fr]"}>
      <aside className="sticky top-0 flex h-screen flex-col border-r border-line bg-white/80 px-4 py-5 backdrop-blur">
        <Link href="/" className="flex items-center gap-3 px-2">
          <span className="grid h-10 w-10 place-items-center rounded-2xl bg-ink text-white text-lg">🐙</span>
          <span>
            <strong className="block text-ink leading-tight">Docktopus</strong>
            <small className="text-slate-500">Cloud environments</small>
          </span>
        </Link>
        <nav className="mt-8 flex flex-col gap-1">
          {links.map((link) => {
            const active = path === link.href;
            return (
              <Link
                key={link.href}
                href={link.href}
                className={`rounded-xl px-3 py-2 text-sm font-semibold ${
                  active ? "bg-ink text-white" : "text-slate-600 hover:bg-mist"
                }`}
              >
                {link.label}
              </Link>
            );
          })}
        </nav>
        <button
          type="button"
          className="mt-auto text-left text-sm text-slate-500 px-3 py-2"
          onClick={async () => {
            await fetch("/api/logout", { method: "POST" });
            router.push("/login");
          }}
        >
          Sair
        </button>
      </aside>
      <div className={fullBleed ? "min-h-0 min-w-0 overflow-hidden" : "min-w-0"}>{children}</div>
    </div>
  );
}
