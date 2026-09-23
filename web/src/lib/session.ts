import { createHash, createHmac, timingSafeEqual } from "crypto";

export function uiPassword(): string {
  return process.env.DOCKTOPUS_UI_PASSWORD || "";
}

export function sessionToken(): string {
  const secret = process.env.DOCKTOPUS_SESSION_SECRET || uiPassword() || "docktopus-dev";
  return createHmac("sha256", secret).update("docktopus-ok").digest("hex");
}

export function passwordMatches(provided: string, expected: string): boolean {
  const left = createHash("sha256").update(provided).digest();
  const right = createHash("sha256").update(expected).digest();
  return timingSafeEqual(left, right);
}

export function isAuthed(cookieValue?: string): boolean {
  if (!uiPassword()) return true;
  if (!cookieValue) return false;
  const expected = Buffer.from(sessionToken());
  const got = Buffer.from(cookieValue);
  if (expected.length !== got.length) return false;
  return timingSafeEqual(expected, got);
}
