"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  return (
    <main className="min-h-screen grid place-items-center p-6">
      <form
        className="w-full max-w-sm rounded-3xl bg-white shadow-card border border-line p-8"
        onSubmit={async (event) => {
          event.preventDefault();
          setError("");
          const res = await fetch("/api/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ password }),
          });
          if (!res.ok) {
            const json = await res.json().catch(() => ({}));
            setError(json.error || "Não foi possível entrar");
            return;
          }
          router.push("/");
          router.refresh();
        }}
      >
        <p className="text-sm text-sea font-semibold">Docktopus</p>
        <h1 className="mt-1 text-2xl font-semibold">Entrar no painel</h1>
        <p className="mt-2 text-sm text-slate-500">A API e o socket do Docker ficam fora do navegador.</p>
        <label className="mt-6 block text-sm font-medium text-slate-600">
          Senha
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full rounded-xl border border-line px-3 py-2"
            autoFocus
          />
        </label>
        {error ? <p className="mt-3 text-sm text-red-700">{error}</p> : null}
        <button className="mt-5 w-full rounded-xl bg-ink text-white py-2.5 font-semibold" type="submit">
          Continuar
        </button>
      </form>
    </main>
  );
}
