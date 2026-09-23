import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { isAuthed } from "@/lib/session";

async function forward(req: NextRequest, path: string[]) {
  const jar = await cookies();
  if (!isAuthed(jar.get("docktopus_session")?.value)) {
    return NextResponse.json({ error: "Não autorizado" }, { status: 401 });
  }

  const api = process.env.DOCKTOPUS_API_URL || "http://127.0.0.1:3000";
  const token = process.env.DOCKTOPUS_API_TOKEN || "";
  const url = `${api}/api/${path.join("/")}${req.nextUrl.search}`;
  const headers = new Headers();
  const contentType = req.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  if (token) headers.set("authorization", `Bearer ${token}`);

  const init: RequestInit = { method: req.method, headers, cache: "no-store" };
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = await req.text();
  }

  const res = await fetch(url, init);
  if (res.status === 204) return new NextResponse(null, { status: 204 });
  const body = await res.text();
  return new NextResponse(body, {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") || "application/json" },
  });
}

type Ctx = { params: Promise<{ path: string[] }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  return forward(req, (await ctx.params).path);
}
export async function POST(req: NextRequest, ctx: Ctx) {
  return forward(req, (await ctx.params).path);
}
export async function PUT(req: NextRequest, ctx: Ctx) {
  return forward(req, (await ctx.params).path);
}
export async function DELETE(req: NextRequest, ctx: Ctx) {
  return forward(req, (await ctx.params).path);
}
