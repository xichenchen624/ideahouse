import { handleApi } from "../server.js";

const ALLOW_TEMP_STORE = process.env.ALLOW_TEMP_STORE === "true";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const GITHUB_REPO = process.env.GITHUB_REPO || "";
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";
const GITHUB_DATA_PATH = process.env.GITHUB_DATA_PATH || "remote-data/notes.enc.json";

function useGitHubStore() {
  return Boolean(GITHUB_TOKEN && GITHUB_REPO);
}

function storageStatus() {
  const missing = [];
  if (!GITHUB_TOKEN) missing.push("GITHUB_TOKEN");
  if (!GITHUB_REPO) missing.push("GITHUB_REPO");
  if (useGitHubStore()) {
    return {
      store: "github",
      durable: true,
      repo: GITHUB_REPO,
      branch: GITHUB_BRANCH,
      dataPath: GITHUB_DATA_PATH,
    };
  }
  return {
    store: process.env.VERCEL ? "temp" : "local",
    durable: !process.env.VERCEL,
    missing,
    allowTempStore: ALLOW_TEMP_STORE,
  };
}

function persistenceRequired() {
  return Boolean(process.env.VERCEL && !useGitHubStore() && !ALLOW_TEMP_STORE);
}

function isWriteRequest(method, pathname) {
  if (method === "POST" && ["/api/content", "/api/notes"].includes(pathname)) return true;
  if (["PATCH", "DELETE"].includes(method) && pathname.startsWith("/api/notes/")) return true;
  if (method === "POST" && /^\/api\/notes\/[^/]+\/sync$/.test(pathname)) return true;
  return false;
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

export default async function handler(req, res) {
  const url = new URL(req.url || "/", `https://${req.headers.host || "localhost"}`);
  try {
    if (req.method === "GET" && url.pathname === "/api/health") {
      json(res, 200, { ok: true, name: "智慧笔记摘要本", kbDir: process.env.KB_DIR || "/var/task/kb", storage: storageStatus() });
      return;
    }
    if (persistenceRequired() && isWriteRequest(req.method, url.pathname)) {
      json(res, 503, {
        error: "persistence_not_configured",
        detail: "线上长期存储还没配置：请在 Vercel 环境变量中添加 GITHUB_TOKEN 和 GITHUB_REPO。",
        storage: storageStatus(),
      });
      return;
    }
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
