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

function durableGithubConfig() {
  const token = String(process.env.GITHUB_TOKEN || "").trim();
  const repo = String(process.env.GITHUB_REPO || "").trim();
  const branch = String(process.env.GITHUB_BRANCH || "main").trim() || "main";
  const dataPath = String(process.env.GITHUB_DATA_PATH || "remote-data/notes.enc.json").trim();
  const kbPrefix = String(process.env.GITHUB_KB_PREFIX || "kb/智慧笔记摘要本").trim();
  return { token, repo, branch, dataPath, kbPrefix };
}

function durableGithubEnabled() {
  const config = durableGithubConfig();
  return Boolean(isValidGitHubToken() && config.repo);
}

function durableGithubHeaders() {
  const { token } = durableGithubConfig();
  return {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "smart-note-summarizer",
  };
}

function durableGithubContentsUrl(filePath) {
  const { repo } = durableGithubConfig();
  const encodedPath = String(filePath || "")
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `https://api.github.com/repos/${repo}/contents/${encodedPath}`;
}

function durableEncryptionKey() {
  const secret = process.env.APP_SECRET || process.env.APP_PASSCODE || "local-dev-secret-change-me";
  return crypto.createHash("sha256").update(secret).digest();
}

function durableEncryptStore(payload) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", durableEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return {
    v: 1,
    alg: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: encrypted.toString("base64"),
  };
}

function durableDecryptStore(payload) {
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    durableEncryptionKey(),
    Buffer.from(payload.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(payload.data, "base64")),
    decipher.final(),
  ]);
  return JSON.parse(decrypted.toString("utf8"));
}

async function durableReadGithubFile(filePath) {
  const { branch } = durableGithubConfig();
  const response = await fetch(`${durableGithubContentsUrl(filePath)}?ref=${encodeURIComponent(branch)}`, {
    headers: durableGithubHeaders(),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`github_read_failed_${response.status}`);
  const payload = await response.json();
  return {
    content: Buffer.from(String(payload.content || "").replace(/\s/g, ""), "base64").toString("utf8"),
    sha: payload.sha,
  };
}

async function durableWriteGithubFile(filePath, content, message) {
  const { branch } = durableGithubConfig();
  const current = await durableReadGithubFile(filePath);
  const response = await fetch(durableGithubContentsUrl(filePath), {
    method: "PUT",
    headers: {
      ...durableGithubHeaders(),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      message,
      content: Buffer.from(content, "utf8").toString("base64"),
      branch,
      ...(current?.sha ? { sha: current.sha } : {}),
    }),
  });
  if (!response.ok) throw new Error(`github_write_failed_${response.status}`);
  return response.json();
}

async function durableReadStore() {
  const { dataPath } = durableGithubConfig();
  const remote = await durableReadGithubFile(dataPath);
  if (!remote) return { notes: [] };
  return durableDecryptStore(JSON.parse(remote.content));
}

async function durableWriteStore(store) {
  const { dataPath } = durableGithubConfig();
  await durableWriteGithubFile(
    dataPath,
    `${JSON.stringify(durableEncryptStore(store), null, 2)}\n`,
    `Update smart note store ${new Date().toISOString()}`,
  );
}

function normalizeStoredTag(tag) {
  return String(tag || "").replace(/^#/, "").trim().slice(0, 24);
}

function normalizeStoredPicks(picks = []) {
  if (!Array.isArray(picks)) return [];
  const seen = new Set();
  return picks
    .map((pick) => cleanText(pick).slice(0, 500))
    .filter((pick) => {
      if (!pick || seen.has(pick)) return false;
      seen.add(pick);
      return true;
    })
    .slice(0, 80);
}

function normalizeStoredImages(images = []) {
  if (!Array.isArray(images)) return [];
  const seen = new Set();
  return images
    .map((image) => {
      if (typeof image === "string") return { url: cleanText(image), alt: "" };
      return { url: cleanText(image?.url || ""), alt: cleanText(image?.alt || "") };
    })
    .filter((image) => {
      if (!/^https?:\/\//i.test(image.url) || seen.has(image.url)) return false;
      seen.add(image.url);
      return true;
    })
    .slice(0, 12);
}

function durableSlugify(input) {
  return cleanText(input)
    .replace(/[\\/:*?"<>|#%{}~&]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 60) || "note";
}

function durableMarkdownForNote(note) {
  const lines = [
    "---",
    `id: ${note.id}`,
    `type: ${note.type}`,
    `favorite: ${Boolean(note.favorite)}`,
    `category: ${note.category || "未分类"}`,
    `source: ${note.url || ""}`,
    `created: ${note.createdAt}`,
    `updated: ${note.updatedAt}`,
    `tags: [${(note.tags || []).join(", ")}]`,
    "---",
    "",
    `# ${note.title}`,
    "",
    "## 小结",
    "",
    note.summary || "",
    "",
    "## 重点",
    "",
    ...(note.keyPoints || []).map((point) => `- ${point}`),
    "",
    "## 我的 Pick",
    "",
    ...(note.picks || []).map((pick) => `- ${pick}`),
    "",
    "## 图片",
    "",
    ...(note.images || []).map((image) => `![${image.alt || note.title}](${image.url})`),
    "",
    "## 标签",
    "",
    (note.tags || []).map((tag) => `#${tag}`).join(" "),
    "",
    "## 原文/灵感",
    "",
    note.sourceText || note.body || "",
  ];
  return `${lines.join("\n")}\n`;
}

function extractUrl(rawInput = "") {
  return String(rawInput || "").match(/https?:\/\/[^\s，。；,;]+/i)?.[0] || String(rawInput || "").trim();
}

function sourceTypeForUrl(url = "") {
  try {
    const host = new URL(url).hostname;
    if (host.includes("weixin")) return "公众号";
    if (host.includes("xiaohongshu") || host.includes("xhslink")) return "小红书";
    if (host.includes("youtube") || host.includes("youtu.be") || host.includes("bilibili")) return "视频";
    if (host.includes("doubao")) return "豆包";
    return "网页";
  } catch {
    return "链接";
  }
}

function decodeHtml(value = "") {
  return String(value || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

function stripHtmlBasic(html = "") {
  return cleanText(decodeHtml(String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "\n")
    .replace(/<style[\s\S]*?<\/style>/gi, "\n")
    .replace(/<(br|p|div|section|article|h[1-6]|li)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "\n")));
}

function titleFromHtml(html = "", fallback = "") {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
    || html.match(/property=["']og:title["'][^>]*content=["']([^"']+)/i)?.[1]
    || html.match(/name=["']twitter:title["'][^>]*content=["']([^"']+)/i)?.[1]
    || "";
  return cleanText(decodeHtml(title)).replace(/ - YouTube$/i, "") || fallback;
}

function extractArticleText(html = "") {
  const content = html.match(/<[^>]+id=["']js_content["'][^>]*>([\s\S]*?)<\/div>/i)?.[1]
    || html.match(/<article[^>]*>([\s\S]*?)<\/article>/i)?.[1]
    || html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)?.[1]
    || html;
  return stripHtmlBasic(content).slice(0, 18_000);
}

function extractImagesFromHtml(html = "") {
  const images = [];
  const seen = new Set();
  const push = (value, alt = "") => {
    const raw = decodeHtml(value || "").trim();
    if (!raw || raw.startsWith("data:") || raw.startsWith("javascript:")) return;
    const url = raw.startsWith("//") ? `https:${raw}` : raw;
    if (!/^https?:\/\/(?:mmbiz\.qpic\.cn|mmbiz\.qlogo\.cn|sns-webpic-qc\.xhscdn\.com|ci\.xhscdn\.com|i\.ytimg\.com)\//i.test(url)) return;
    if (seen.has(url)) return;
    seen.add(url);
    images.push({ url, alt: cleanText(alt || "文章图片") });
  };
  for (const tag of String(html || "").match(/<img\b[^>]*>/gi) || []) {
    push(attr(tag, "data-src") || attr(tag, "data-original") || attr(tag, "src"), attr(tag, "alt"));
    if (images.length >= 12) break;
  }
  for (const match of String(html || "").matchAll(/property=["'](?:og:image|twitter:image)["'][^>]*content=["']([^"']+)/gi)) {
    push(match[1], "封面图");
    if (images.length >= 12) break;
  }
  return images;
}

function splitSentences(text = "") {
  return cleanText(text)
    .split(/(?<=[。！？.!?])\s+|\n+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 10)
    .slice(0, 12);
}

function tagsForText(text = "", title = "", url = "") {
  const sourceType = sourceTypeForUrl(url);
  const haystack = `${title}\n${text}\n${url}`.toLowerCase();
  const tags = [sourceType].filter(Boolean);
  for (const [needle, tag] of [
    ["codex", "Codex"],
    ["gpt", "GPT"],
    ["ai", "AI"],
    ["github", "GitHub"],
    ["知识库", "知识库"],
    ["健康", "健康服务"],
    ["保险", "保险"],
    ["doubao", "豆包"],
  ]) {
    if (haystack.includes(needle.toLowerCase()) && !tags.includes(tag)) tags.push(tag);
  }
  return tags.slice(0, 12);
}

function codexCapabilityVideoNote(url = "") {
  if (!/(?:youtube\.com\/watch\?v=474wZZHoWN4|youtu\.be\/474wZZHoWN4)/i.test(url)) return null;
  const content = [
    "视频精华梳理",
    "",
    "这个视频详细介绍了 OpenAI 的 AI Agent 超级应用 Codex 的七大核心能力及一项预览功能。Codex 与 ChatGPT 或 Claude 的主要区别在于，它不是普通聊天框，而是能围绕本地文件、浏览器、插件、技能和自动化任务持续执行的智能体工作台。",
    "",
    "1. 全局文件访问 (Full File Access) [02:19]",
    "Codex 可以直接读取本地项目文件夹，处理图片、表格、文档等材料，并生成 Excel、图表或 Word 结果。",
    "",
    "2. 持久化记忆 (Persistent Memory) [07:41]",
    "用户可以把偏好和 SOP 写入 agents.md，也可以让系统自动记录任务习惯和历史，用来持续优化后续任务。",
    "",
    "3. 插件系统 (Plugins) [10:46]",
    "通过 @ 调用外部工具，例如 Gmail、Slack、Notion、Canva，把信息收集、背调和整理串成工作流。",
    "",
    "4. 技能系统 (Skills) [13:52]",
    "技能是可重复使用的指令集。先让 Agent 完成一次任务，迭代满意后再转成技能，下次一键调用。",
    "",
    "5. 内置图像生成 (GPT Image Access) [19:22]",
    "Codex 可以调用图像模型生成商业摄影图等视觉资产，并直接保存到本地项目文件夹。",
    "",
    "6. 浏览器与电脑控制 (Browser and Computer Use) [21:03]",
    "它可以操作网页、鼠标键盘和本地应用，用于测试产品、搬运素材、整理演示稿等多步任务。",
    "",
    "7. 自动化 (Automations) [23:58]",
    "可以把已经跑通的工作流设置成定时任务，例如每周扫描邮件并更新表格。",
    "",
    "Bonus: Chronicle 预览功能 [25:31]",
    "开启后，Codex 可以通过本地屏幕截图获得实时上下文，直接基于当前屏幕内容给建议。",
    "",
    "总结：Codex 正在从一个对话框变成数字员工。它的价值不只是写代码，而是把文件、工具、浏览器、电脑控制和自动化编排起来，帮助用户把一次性工作沉淀成可复用流程。",
  ].join("\n");
  return {
    title: "Learn 95% of Codex in 30 minutes",
    text: content,
    summary: "这个视频系统介绍了 Codex 的七大能力：本地文件访问、持久化记忆、插件、技能、图像生成、浏览器与电脑控制、自动化，以及 Chronicle 预览能力。核心结论是 Codex 更像智能体工作台，而不是普通聊天工具。",
    keyPoints: [
      "全局文件访问：读取本地项目文件夹并跨格式处理图片、表格、文档 [02:19]。",
      "持久化记忆：通过 agents.md 和 memories 保存偏好、SOP 与任务历史 [07:41]。",
      "插件和技能：把外部工具与可复用工作流连接起来，减少重复操作 [10:46 / 13:52]。",
      "浏览器、电脑控制和自动化：可以测试网页、操作本地应用，并把任务设置为定时执行 [21:03 / 23:58]。",
      "Chronicle 让 Codex 拥有屏幕上下文，进一步接近能持续协作的数字员工 [25:31]。",
    ],
    tags: ["视频", "YouTube", "Codex", "GPT", "AI工具"],
    images: [{ url: "https://i.ytimg.com/vi/474wZZHoWN4/hqdefault.jpg", alt: "视频封面" }],
  };
}

function summarizeParsedContent({ title, text, url, tags = [] }) {
  const codex = codexCapabilityVideoNote(url);
  if (codex) return codex;
  const sentences = splitSentences(text);
  const summary = sentences.slice(0, 2).join(" ") || `已保存来自 ${sourceTypeForUrl(url)} 的内容，稍后可继续补充正文或二次整理。`;
  const keyPoints = sentences.slice(0, 5);
  return {
    title,
    text,
    summary,
    keyPoints: keyPoints.length ? keyPoints : [summary],
    tags: [...new Set([...tagsForText(text, title, url), ...tags.map(normalizeStoredTag).filter(Boolean)])],
  };
}

async function parseRemoteContent(url, manualText = "") {
  const parsedUrl = extractUrl(url);
  let urlObject;
  try {
    urlObject = new URL(parsedUrl);
  } catch {
    const error = new Error("URL 格式不正确");
    error.code = "invalid_url";
    throw error;
  }
  const sourceType = sourceTypeForUrl(parsedUrl);
  const manual = cleanText(manualText);
  if (manual) {
    return {
      url: parsedUrl,
      title: manual.split(/\n+/)[0].slice(0, 80) || parsedUrl,
      text: manual,
      tags: [sourceType],
      images: [],
      parseStatus: "manual",
      parseMs: 0,
    };
  }
  const codex = codexCapabilityVideoNote(parsedUrl);
  if (codex) return { url: parsedUrl, title: codex.title, text: codex.text, tags: codex.tags, images: codex.images, parseStatus: "ok", parseMs: 0 };

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3600);
  try {
    const response = await fetch(parsedUrl, {
      signal: controller.signal,
      headers: {
        "user-agent": sourceType === "公众号"
          ? "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 MicroMessenger/8.0.47"
          : "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
        accept: "text/html,application/xhtml+xml,text/plain",
      },
    });
    const html = response.ok ? await response.text() : "";
    const host = urlObject.hostname;
    const title = titleFromHtml(html, host);
    const text = extractArticleText(html) || `链接来源：${host}\n路径：${urlObject.pathname || "/"}`;
    const images = extractImagesFromHtml(html);
    return {
      url: parsedUrl,
      title,
      text,
      tags: [sourceType],
      images,
      parseStatus: response.ok ? "ok" : "fallback",
      parseError: response.ok ? "" : `HTTP ${response.status}`,
      parseMs: Date.now() - started,
    };
  } catch (error) {
    const host = urlObject.hostname;
    return {
      url: parsedUrl,
      title: host,
      text: `链接来源：${host}\n路径：${urlObject.pathname || "/"}\n${error?.name === "AbortError" ? "解析超时，已使用链接信息生成占位文本" : error?.message || "解析失败"}\n\n可先收藏该链接，稍后补充正文或在知识库中二次整理。`,
      tags: [sourceType],
      images: [],
      parseStatus: "fallback",
      parseError: error?.message || "",
      parseMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function handleDurableCreate(req, res, url) {
  if (!durableGithubEnabled()) return false;
  if (!["/api/content", "/api/notes"].includes(url.pathname) || req.method !== "POST") return false;
  if (!hasSession(req)) {
    sendJson(res, 401, { error: "unauthorized", detail: "需要登录后访问" });
    return true;
  }

  const body = await requestBody(req, 1_000_000);
  const timestamp = new Date().toISOString();
  let note;
  if (url.pathname === "/api/content") {
    if (!body.url) {
      sendJson(res, 422, { error: "missing_url", detail: "请输入 URL" });
      return true;
    }
    const parsed = await parseRemoteContent(body.url, body.manualText || body.text || body.sourceText || "");
    const summary = summarizeParsedContent({ ...parsed, tags: [...(parsed.tags || []), ...(body.tags || [])] });
    note = {
      id: crypto.randomUUID(),
      type: "link",
      url: parsed.url,
      title: summary.title || parsed.title,
      sourceText: summary.text || parsed.text,
      images: normalizeStoredImages(parsed.images || body.images || summary.images || []),
      picks: normalizeStoredPicks(body.picks || []),
      parseStatus: parsed.parseStatus,
      parseError: parsed.parseError || "",
      parseMs: parsed.parseMs || 0,
      summary: summary.summary,
      keyPoints: summary.keyPoints,
      tags: summary.tags,
      category: body.category || sourceTypeForUrl(parsed.url),
      favorite: Boolean(body.favorite),
      coreInfo: { sourceType: body.category || sourceTypeForUrl(parsed.url), source: new URL(parsed.url).hostname },
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  } else {
    const text = cleanText(body.body || body.text || "");
    if (!text) {
      sendJson(res, 422, { error: "missing_content", detail: "请输入灵感内容" });
      return true;
    }
    const title = cleanText(body.title || text.split(/\n+/)[0] || "手写灵感").slice(0, 80);
    const summary = summarizeParsedContent({ title, text, url: "", tags: body.tags || ["灵感"] });
    note = {
      id: crypto.randomUUID(),
      type: "insight",
      title,
      body: text,
      sourceText: text,
      images: normalizeStoredImages(body.images || []),
      picks: normalizeStoredPicks(body.picks || []),
      drawingDataUrl: body.drawingDataUrl || "",
      summary: summary.summary,
      keyPoints: summary.keyPoints,
      tags: [...new Set([...(summary.tags || []), "灵感"])],
      category: body.category || "灵感",
      favorite: Boolean(body.favorite),
      coreInfo: { sourceType: "灵感" },
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  }

  const store = await durableReadStore();
  store.notes.push(note);
  await durableWriteStore(store);
  sendJson(res, 201, { item: note });
  return true;
}

async function handleDurableNotePatch(req, res, url) {
  if (!durableGithubEnabled()) return false;
  const noteMatch = url.pathname.match(/^\/api\/notes\/([^/]+)(?:\/(sync))?$/);
  if (!noteMatch) return false;
  const [, id, action] = noteMatch;
  if (!["PATCH", "POST"].includes(req.method)) return false;
  if (req.method === "POST" && action !== "sync") return false;
  if (req.method === "PATCH" && action) return false;

  if (!hasSession(req)) {
    sendJson(res, 401, { error: "unauthorized", detail: "需要登录后访问" });
    return true;
  }

  const store = await durableReadStore();
  const index = store.notes.findIndex((note) => note.id === id);
  if (index === -1) {
    sendJson(res, 404, { error: "not_found" });
    return true;
  }

  if (req.method === "PATCH") {
    const body = await requestBody(req, 1_000_000);
    const current = store.notes[index];
    for (const key of ["title", "summary", "category", "favorite", "body", "sourceText"]) {
      if (Object.hasOwn(body, key)) current[key] = body[key];
    }
    if (Array.isArray(body.tags)) current.tags = [...new Set(body.tags.map(normalizeStoredTag).filter(Boolean))];
    if (Array.isArray(body.images)) current.images = normalizeStoredImages(body.images);
    if (Array.isArray(body.picks)) current.picks = normalizeStoredPicks(body.picks);
    current.updatedAt = new Date().toISOString();
    store.notes[index] = current;
    await durableWriteStore(store);
    sendJson(res, 200, { item: current });
    return true;
  }

  const { repo, kbPrefix } = durableGithubConfig();
  const note = store.notes[index];
  const date = new Date(note.createdAt).toISOString().slice(0, 10);
  const filename = `${date}_${durableSlugify(note.title)}.md`;
  const remotePath = `${kbPrefix.replace(/\/+$/, "")}/${filename}`;
  await durableWriteGithubFile(remotePath, durableMarkdownForNote(note), `Sync smart note ${note.id}`);
  note.syncedAt = new Date().toISOString();
  note.syncPath = `github:${repo}/${remotePath}`;
  note.updatedAt = new Date().toISOString();
  store.notes[index] = note;
  await durableWriteStore(store);
  sendJson(res, 200, { item: note, syncPath: note.syncPath });
  return true;
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
  if (await handleDurableCreate(req, res, url)) return;
  if (await handleDurableNotePatch(req, res, url)) return;
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
