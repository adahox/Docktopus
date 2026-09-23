import { NextResponse } from "next/server";
import { isAuthed, passwordMatches, sessionToken, uiPassword } from "@/lib/session";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { password?: string };
  const expected = uiPassword();
  if (expected && !passwordMatches(body.password || "", expected)) {
    return NextResponse.json({ error: "Senha inválida" }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set("docktopus_session", sessionToken(), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.DOCKTOPUS_COOKIE_SECURE === "true",
    path: "/",
    maxAge: 60 * 60 * 24 * 14,
  });
  return res;
}

export async function GET() {
  return NextResponse.json({ required: Boolean(uiPassword()), ok: isAuthed(undefined) && !uiPassword() });
}
