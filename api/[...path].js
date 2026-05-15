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

function patchWeChatFetchTimeout() {
  const marker = Symbol.for("smart-note.wechat-fetch-timeout-patched");
  if (globalThis[marker]) return;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (resource, options = {}) => {
    const href = typeof resource === "string" ? resource : resource?.url || String(resource || "");
    if (href.includes("mp.weixin.qq.com")) {
      const headers = {
        ...(options.headers || {}),
        "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 MicroMessenger/8.0.47",
        accept: "text/html,application/xhtml+xml,text/plain",
      };
      const response = await originalFetch(resource, { ...options, headers, signal: undefined });
      return withWeChatImageHints(response);
    }
    return originalFetch(resource, options);
  };
  globalThis[marker] = true;
}

function imageUrlsFromHtml(html) {
  const urls = [];
  const seen = new Set();
  for (const match of String(html || "").matchAll(/<img\b[^>]*>/gi)) {
    const tag = match[0];
    const src = attr(tag, "data-src") || attr(tag, "data-original") || attr(tag, "data-backsrc") || attr(tag, "src");
    const url = normalizeImageUrl(src);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
    if (urls.length >= 10) break;
  }
  return urls;
}

function attr(tag, name) {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return String(match?.[1] || match?.[2] || match?.[3] || "").replace(/&amp;/g, "&");
}

function normalizeImageUrl(value) {
  const raw = String(value || "").trim();
  if (!raw || raw.startsWith("data:") || raw.startsWith("javascript:")) return "";
  const url = raw.startsWith("//") ? `https:${raw}` : raw;
  if (!/^https?:\/\/(?:mmbiz\.qpic\.cn|mmbiz\.qlogo\.cn)\//i.test(url)) return "";
  return url;
}

async function withWeChatImageHints(response) {
  const type = response.headers.get("content-type") || "";
  if (!response.ok || !type.includes("text/html")) return response;
  const html = await response.text();
  const imageUrls = imageUrlsFromHtml(html);
  if (!imageUrls.length) return makeHtmlResponse(html, response);
  const openTag = /<[^>]+id=["']js_content["'][^>]*>/i.exec(html);
  if (!openTag) return makeHtmlResponse(html, response);
  const insertAt = openTag.index + openTag[0].length;
  const imageHintHtml = `<p>图片：</p>${imageUrls.map((url) => `<p>${url}</p>`).join("")}`;
  return makeHtmlResponse(`${html.slice(0, insertAt)}${imageHintHtml}${html.slice(insertAt)}`, response);
}

function makeHtmlResponse(html, sourceResponse) {
  const headers = new Headers(sourceResponse.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  return new Response(html, {
    status: sourceResponse.status,
    statusText: sourceResponse.statusText,
    headers,
  });
}

export default async function handler(req, res) {
  trimConfigEnv();
  patchWeChatFetchTimeout();
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
