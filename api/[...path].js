function trimConfigEnv() {
  for (const key of ["GITHUB_TOKEN", "GITHUB_REPO", "GITHUB_BRANCH", "GITHUB_DATA_PATH", "GITHUB_KB_PREFIX"]) {
    if (process.env[key]) process.env[key] = String(process.env[key]).trim();
  }
}

function isValidGitHubToken() {
  const token = process.env.GITHUB_TOKEN || "";
  return /^(github_pat_|ghp_|gho_|ghu_|ghs_|ghr_)[!-~]+$/.test(token);
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function blockInvalidGitHubToken(req, res, url) {
  if (!process.env.VERCEL || !process.env.GITHUB_TOKEN || isValidGitHubToken()) return false;

  const storage = {
    store: "temp",
    durable: false,
    missing: ["valid GITHUB_TOKEN"],
    detail: "GITHUB_TOKEN 不是有效的 GitHub Token。请在 GitHub 生成 fine-grained token，并替换 Vercel 里的 GITHUB_TOKEN。",
  };

  if (req.method === "GET" && url.pathname === "/api/health") {
    sendJson(res, 200, { ok: true, name: "智慧笔记摘要本", storage });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/notes") {
    sendJson(res, 200, { items: [], nextCursor: null, total: 0, storage });
    return true;
  }

  if (url.pathname === "/api/content" || url.pathname.startsWith("/api/notes")) {
    sendJson(res, 503, {
      error: "persistence_not_configured",
      detail: storage.detail,
      storage,
    });
    return true;
  }

  return false;
}

export default async function handler(req, res) {
  trimConfigEnv();
  const url = new URL(req.url || "/", `https://${req.headers.host || "localhost"}`);
  if (blockInvalidGitHubToken(req, res, url)) return;
  const { handleApi } = await import("../server.js");
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
