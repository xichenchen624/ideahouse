import { handleApi } from "../server.js";

export default async function handler(req, res) {
  const url = new URL(req.url || "/", `https://${req.headers.host || "localhost"}`);
  try {
    await handleApi(req, res, url);
  } catch (error) {
    const body = JSON.stringify({ error: "server_error", detail: error?.message || String(error) });
    res.writeHead(500, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
    });
    res.end(body);
  }
}
