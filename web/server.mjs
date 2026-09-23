import http from "http";
import { createHmac, timingSafeEqual } from "crypto";
import next from "next";
import httpProxy from "http-proxy";

const dev = process.env.NODE_ENV !== "production";
const port = Number(process.env.PORT || 3001);
const apiUrl = process.env.DOCKTOPUS_API_URL || "http://127.0.0.1:3000";
const apiToken = process.env.DOCKTOPUS_API_TOKEN || "";
const app = next({ dev });
const handle = app.getRequestHandler();
const proxy = httpProxy.createProxyServer({ ws: true, changeOrigin: true });

function expectedSession() {
  const password = process.env.DOCKTOPUS_UI_PASSWORD || "";
  if (!password) return "";
  const secret = process.env.DOCKTOPUS_SESSION_SECRET || password;
  return createHmac("sha256", secret).update("docktopus-ok").digest("hex");
}

function sessionOk(cookieHeader = "") {
  const expected = expectedSession();
  if (!expected) return true;
  const pair = cookieHeader
    .split(";")
    .map((p) => p.trim())
    .find((p) => p.startsWith("docktopus_session="));
  const got = pair ? decodeURIComponent(pair.slice("docktopus_session=".length)) : "";
  if (!got) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(got);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

app.prepare().then(() => {
  const server = http.createServer((req, res) => {
    handle(req, res);
  });

  server.on("upgrade", (req, socket, head) => {
    if (!req.url?.startsWith("/ws")) {
      socket.destroy();
      return;
    }
    if (!sessionOk(req.headers.cookie)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    const target = apiUrl.replace(/^http/, "ws");
    proxy.ws(req, socket, head, {
      target,
      headers: apiToken ? { authorization: `Bearer ${apiToken}` } : {},
    });
  });

  proxy.on("error", (err) => {
    console.error("[docktopus-web] proxy ws:", err.message);
  });

  server.listen(port, () => {
    console.log(`Docktopus web em http://localhost:${port}`);
  });
});
