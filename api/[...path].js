import crypto from "node:crypto";

function trimConfigEnv() {
  for (const key of ["GITHUB_TOKEN", "GITHUB_REPO", "GITHUB_BRANCH", "GITHUB_DATA_PATH", "GITHUB_KB_PREFIX", "OPENAI_API_KEY", "OPENAI_MODEL", "OPENAI_VISION_MODEL", "OPENAI_BASE_URL"]) {
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

function cleanText(input) {
  return String(input || "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function signPayload(payload) {
  const secret = process.env.APP_SECRET || process.env.APP_PASSCODE || "local-dev-secret-change-me";
  return crypto.createHmac("sha256", secret).update(payload).digest("base64url");
}

function verifySessionToken(token) {
  const [payload, signature] = String(token || "").split(".");
  if (!payload || !signature) return false;
  const expected = signPayload(payload);
  const expectedBuffer = Buffer.from(expected);
  const signatureBuffer = Buffer.from(signature);
  if (expectedBuffer.length !== signatureBuffer.length || !crypto.timingSafeEqual(expectedBuffer, signatureBuffer)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return Number(data.exp || 0) > Date.now();
  } catch {
    return false;
  }
}

function hasSession(req) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  return verifySessionToken(token);
}

function requestBody(req, maxBytes = 200_000) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > maxBytes) {
        reject(new Error("payload_too_large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("invalid_json"));
      }
    });
    req.on("error", reject);
  });
}

function outputText(payload) {
  if (typeof payload?.output_text === "string") return payload.output_text;
  const parts = [];
  for (const item of payload?.output || []) {
    for (const content of item?.content || []) {
      if (typeof content?.text === "string") parts.push(content.text);
    }
  }
  return parts.join("\n").trim();
}

async function handleExpand(req, res) {
  if (!hasSession(req)) {
    sendJson(res, 401, { error: "unauthorized", detail: "需要登录后访问" });
    return true;
  }
  const body = await requestBody(req);
  const text = cleanText(body.text || body.body || "");
  if (!text) {
    sendJson(res, 422, { error: "missing_content", detail: "请先写下要扩写的灵感内容" });
    return true;
  }
  const apiKey = String(process.env.OPENAI_API_KEY || "").trim();
  const model = String(process.env.OPENAI_MODEL || "gpt-5.5").trim() || "gpt-5.5";
  const baseUrl = String(process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").trim().replace(/\/+$/, "");
  if (!apiKey) {
    sendJson(res, 503, { error: "ai_not_configured", detail: "AI 扩写还没配置：请在 Vercel 环境变量里添加 OPENAI_API_KEY。" });
    return true;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 18_000);
  try {
    const prompt = [
      "你是一个中文知识整理助手。请把用户写下的灵感扩写成一篇可直接保存到知识库的结构化笔记。",
      "",
      "要求：保留用户原意，不编造事实；结构固定为：一句话观点、展开说明、可执行动作、待验证问题；段落之间留空行；总长度 600-1200 字；直接输出正文。",
      "",
      "用户原始灵感：",
      text.slice(0, 6000),
    ].join("\n");
    const response = await fetch(`${baseUrl}/responses`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model, input: prompt, max_output_tokens: 1600 }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      sendJson(res, 502, { error: "ai_expand_failed", detail: payload?.error?.message || `OpenAI 请求失败：${response.status}` });
      return true;
    }
    const expandedText = cleanText(outputText(payload));
    if (!expandedText) {
      sendJson(res, 502, { error: "ai_empty_output", detail: "模型没有返回可用内容，请稍后重试。" });
      return true;
    }
    sendJson(res, 200, { expandedText, model });
    return true;
  } catch (error) {
    sendJson(res, 502, { error: "ai_expand_failed", detail: error?.name === "AbortError" ? "AI 扩写超时，请稍后重试。" : error?.message || "AI 扩写失败，请稍后再试" });
    return true;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeImageDataUrl(value) {
  const raw = String(value || "").trim();
  const match = raw.match(/^data:(image\/(?:png|jpe?g|webp));base64,([a-z0-9+/=\s]+)$/i);
  if (!match) {
    const error = new Error("请上传 PNG、JPG 或 WebP 图片。");
    error.code = "invalid_image";
    throw error;
  }
  const mime = match[1].toLowerCase().replace("image/jpg", "image/jpeg");
  const base64 = match[2].replace(/\s/g, "");
  const bytes = Buffer.byteLength(base64, "base64");
  if (!bytes || bytes > 4_000_000) {
    const error = new Error("图片过大，请选择 4MB 以内的图片。");
    error.code = "image_too_large";
    throw error;
  }
  return `data:${mime};base64,${base64}`;
}

async function handleImageInsight(req, res) {
  if (!hasSession(req)) {
    sendJson(res, 401, { error: "unauthorized", detail: "需要登录后访问" });
    return true;
  }
  let body;
  try {
    body = await requestBody(req, 8_000_000);
  } catch (error) {
    sendJson(res, 413, { error: "payload_too_large", detail: "图片过大，请选择 4MB 以内的图片。" });
    return true;
  }
  let imageDataUrl;
  try {
    imageDataUrl = normalizeImageDataUrl(body.imageDataUrl || body.image || "");
  } catch (error) {
    sendJson(res, 422, { error: error.code || "invalid_image", detail: error.message });
    return true;
  }

  const apiKey = String(process.env.OPENAI_API_KEY || "").trim();
  const baseModel = String(process.env.OPENAI_MODEL || "gpt-5.5").trim() || "gpt-5.5";
  const model = String(process.env.OPENAI_VISION_MODEL || baseModel).trim() || baseModel;
  const baseUrl = String(process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").trim().replace(/\/+$/, "");
  if (!apiKey) {
    sendJson(res, 503, { error: "ai_not_configured", detail: "图片解析还没配置：请在 Vercel 环境变量里添加 OPENAI_API_KEY。" });
    return true;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 22_000);
  try {
    const prompt = [
      "你是一个中文知识整理助手。请读取用户上传的图片，把图片中有价值的信息整理成可保存到灵感笔记的文字。",
      "要求：如果图片里有文字，先尽量完整转写；看不清的地方用「可能是」标注，不要编造。",
      "输出结构固定为：图片识别、关键内容、我的灵感草稿、可继续追问。段落之间留空行，直接输出正文。",
    ].join("\n");
    const response = await fetch(`${baseUrl}/responses`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        input: [{
          role: "user",
          content: [
            { type: "input_text", text: prompt },
            { type: "input_image", image_url: imageDataUrl },
          ],
        }],
        max_output_tokens: 1400,
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      sendJson(res, 502, { error: "image_parse_failed", detail: payload?.error?.message || `OpenAI 请求失败：${response.status}` });
      return true;
    }
    const extractedText = cleanText(outputText(payload));
    if (!extractedText) {
      sendJson(res, 502, { error: "ai_empty_output", detail: "模型没有从图片中返回可用内容，请换一张更清晰的图片。" });
      return true;
    }
    sendJson(res, 200, { extractedText, model });
    return true;
  } catch (error) {
    sendJson(res, 502, { error: "image_parse_failed", detail: error?.name === "AbortError" ? "图片解析超时，请稍后重试。" : error?.message || "图片解析失败，请稍后再试" });
    return true;
  } finally {
    clearTimeout(timer);
  }
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
  const push = (value) => {
    const url = normalizeImageUrl(value);
    if (!url || seen.has(url)) return;
    seen.add(url);
    urls.push(url);
  };

  for (const match of String(html || "").matchAll(/<img\b[^>]*>/gi)) {
    const tag = match[0];
    const src = attr(tag, "data-src")
      || attr(tag, "data-original")
      || attr(tag, "data-backsrc")
      || attr(tag, "data-croporisrc")
      || attr(tag, "src");
    push(src);
    const srcset = attr(tag, "srcset") || attr(tag, "data-srcset");
    for (const candidate of srcset.split(",")) push(candidate.trim().split(/\s+/)[0]);
    if (urls.length >= 10) break;
  }

  for (const match of String(html || "").matchAll(/property=["'](?:og:image|twitter:image)["'][^>]*content=["']([^"']+)/gi)) {
    push(match[1]);
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
  const imageHintHtml = `<section id="smart_note_image_hints"><p>图片：</p>${imageUrls.map((url) => `<p>${url}</p>`).join("")}</section>`;
  const openTag = /<[^>]+id=["']js_content["'][^>]*>/i.exec(html);
  if (openTag) {
    const insertAt = openTag.index + openTag[0].length;
    return makeHtmlResponse(`${html.slice(0, insertAt)}${imageHintHtml}${html.slice(insertAt)}`, response);
  }
  const bodyTag = /<body[^>]*>/i.exec(html);
  if (bodyTag) {
    const insertAt = bodyTag.index + bodyTag[0].length;
    return makeHtmlResponse(`${html.slice(0, insertAt)}${imageHintHtml}${html.slice(insertAt)}`, response);
  }
  return makeHtmlResponse(`${imageHintHtml}${html}`, response);
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
  if (req.method === "POST" && url.pathname === "/api/expand") {
    if (await handleExpand(req, res)) return;
  }
  if (req.method === "POST" && url.pathname === "/api/image-insight") {
    if (await handleImageInsight(req, res)) return;
  }
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
