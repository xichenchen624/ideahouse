import http from "node:http";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || "127.0.0.1";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const STORE_FILE = path.join(DATA_DIR, "notes.enc.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const DEFAULT_KB_DIR = path.join(__dirname, "kb");
const KB_DIR = process.env.KB_DIR || DEFAULT_KB_DIR;
const APP_PASSCODE = process.env.APP_PASSCODE || "demo";
const APP_SECRET = process.env.APP_SECRET || APP_PASSCODE || "local-dev-secret-change-me";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const GITHUB_REPO = process.env.GITHUB_REPO || "";
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";
const GITHUB_DATA_PATH = process.env.GITHUB_DATA_PATH || "remote-data/notes.enc.json";
const GITHUB_KB_PREFIX = process.env.GITHUB_KB_PREFIX || "kb/智慧笔记摘要本";
const sessions = new Map();

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function fail(res, status, error, detail) {
  json(res, status, { error, detail });
}

function notFound(res) {
  json(res, 404, { error: "not_found" });
}

function requestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 2_000_000) {
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

function useGitHubStore() {
  return Boolean(GITHUB_TOKEN && GITHUB_REPO);
}

function githubHeaders() {
  return {
    authorization: `Bearer ${GITHUB_TOKEN}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "smart-note-summarizer",
  };
}

function githubContentsUrl(filePath) {
  const encodedPath = String(filePath).split("/").map(encodeURIComponent).join("/");
  return `https://api.github.com/repos/${GITHUB_REPO}/contents/${encodedPath}`;
}

async function readGitHubFile(filePath) {
  const response = await fetch(`${githubContentsUrl(filePath)}?ref=${encodeURIComponent(GITHUB_BRANCH)}`, {
    headers: githubHeaders(),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`github_read_failed_${response.status}`);
  const payload = await response.json();
  const content = Buffer.from(String(payload.content || "").replace(/\s/g, ""), "base64").toString("utf8");
  return { content, sha: payload.sha };
}

async function writeGitHubFile(filePath, content, message) {
  const current = await readGitHubFile(filePath);
  const response = await fetch(githubContentsUrl(filePath), {
    method: "PUT",
    headers: { ...githubHeaders(), "content-type": "application/json" },
    body: JSON.stringify({
      message,
      content: Buffer.from(content, "utf8").toString("base64"),
      branch: GITHUB_BRANCH,
      ...(current?.sha ? { sha: current.sha } : {}),
    }),
  });
  if (!response.ok) throw new Error(`github_write_failed_${response.status}`);
  return response.json();
}

function encryptionKey() {
  return crypto.createHash("sha256").update(APP_SECRET).digest();
}

function encryptStore(payload) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return {
    v: 1,
    alg: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: encrypted.toString("base64"),
  };
}

function decryptStore(payload) {
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(payload.iv, "base64"));
  decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(payload.data, "base64")), decipher.final()]);
  return JSON.parse(decrypted.toString("utf8"));
}

async function readStore() {
  if (useGitHubStore()) {
    const remote = await readGitHubFile(GITHUB_DATA_PATH);
    if (!remote) return { notes: [] };
    return decryptStore(JSON.parse(remote.content));
  }
  await mkdir(DATA_DIR, { recursive: true });
  if (!existsSync(STORE_FILE)) return { notes: [] };
  return decryptStore(JSON.parse(await readFile(STORE_FILE, "utf8")));
}

async function writeStore(store) {
  if (useGitHubStore()) {
    await writeGitHubFile(
      GITHUB_DATA_PATH,
      `${JSON.stringify(encryptStore(store), null, 2)}\n`,
      `Update smart note store ${new Date().toISOString()}`,
    );
    return;
  }
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(STORE_FILE, `${JSON.stringify(encryptStore(store), null, 2)}\n`, "utf8");
}

function signPayload(payload) {
  return crypto.createHmac("sha256", APP_SECRET).update(payload).digest("base64url");
}

function makeSessionToken() {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + 12 * 60 * 60 * 1000 })).toString("base64url");
  return `${payload}.${signPayload(payload)}`;
}

function verifySessionToken(token) {
  const [payload, signature] = String(token || "").split(".");
  if (!payload || !signature) return false;
  const expected = signPayload(payload);
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try {
    return Number(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")).exp || 0) > Date.now();
  } catch {
    return false;
  }
}

function requireSession(req) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return false;
  if (verifySessionToken(token)) return true;
  const session = sessions.get(token);
  if (!session || session.expiresAt < Date.now()) return false;
  session.expiresAt = Date.now() + 12 * 60 * 60 * 1000;
  return true;
}

function publicRoute(req, pathname) {
  return req.method === "POST" && pathname === "/api/session"
    || req.method === "GET" && pathname === "/api/health"
    || !pathname.startsWith("/api/");
}

function makeId() {
  return crypto.randomUUID();
}

function now() {
  return new Date().toISOString();
}

function normalizeTag(tag) {
  return String(tag || "").replace(/^#/, "").trim().slice(0, 24);
}

function cleanText(input) {
  return String(input || "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeHtml(input) {
  return String(input || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function stripHtml(html) {
  const withoutNoise = String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
  return cleanText(decodeHtml(withoutNoise
    .replace(/<\/(p|h[1-6]|li|section|article|blockquote|div)>/gi, "\n")
    .replace(/<[^>]*>/g, " ")));
}

function extractElementById(html, id) {
  const startRe = new RegExp(`<([a-zA-Z0-9-]+)([^>]*\\s(?:id=["']${id}["']|id=${id})(?:\\s|>)[^>]*)>`, "i");
  const startMatch = startRe.exec(html);
  if (!startMatch) return "";
  const tag = startMatch[1].toLowerCase();
  const start = startMatch.index;
  const tagRe = new RegExp(`</?${tag}\\b[^>]*>`, "gi");
  tagRe.lastIndex = start + startMatch[0].length;
  let depth = 1;
  for (let match; (match = tagRe.exec(html));) {
    if (match[0][1] === "/") depth -= 1;
    else depth += 1;
    if (depth === 0) return html.slice(start, tagRe.lastIndex);
  }
  return "";
}

function scriptStateAfter(html, marker) {
  const start = html.indexOf(marker);
  if (start === -1) return "";
  const valueStart = start + marker.length;
  const valueEnd = html.indexOf("</script>", valueStart);
  return valueEnd === -1 ? "" : html.slice(valueStart, valueEnd).trim();
}

function extractTitle(html, url) {
  const ogTitle = html.match(/property=["']og:title["'][^>]*content=["']([^"']+)/i)?.[1];
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const raw = cleanText(decodeHtml(ogTitle || title || ""));
  if (raw) return raw.slice(0, 120);
  try { return new URL(url).hostname; } catch { return "未命名内容"; }
}

function extractWeChatArticle(html, url) {
  const contentHtml = extractElementById(html, "js_content");
  const titleHtml = extractElementById(html, "activity-name");
  const text = stripHtml(contentHtml);
  if (text.length < 80) return null;
  return { title: stripHtml(titleHtml) || extractTitle(html, url), text, tags: ["公众号"] };
}

function findXhsNote(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 10) return null;
  if (value.title && value.desc && value.noteId) return value;
  for (const child of Object.values(value)) {
    const found = findXhsNote(child, depth + 1);
    if (found) return found;
  }
  return null;
}

function extractXhsArticle(html) {
  const rawState = scriptStateAfter(html, "window.__INITIAL_STATE__=");
  if (!rawState) return null;
  try {
    const state = JSON.parse(rawState.replace(/:undefined/g, ":null"));
    const note = findXhsNote(state);
    if (!note?.desc || !note?.title) return null;
    const tags = Array.isArray(note.tagList) ? note.tagList.map((tag) => normalizeTag(tag.name)).filter(Boolean) : [];
    return { title: cleanText(note.title), text: cleanText(note.desc), tags: ["小红书", ...tags] };
  } catch {
    return null;
  }
}

function extractJsonObjectAt(html, marker) {
  const markerIndex = html.indexOf(marker);
  if (markerIndex === -1) return null;
  const equalsIndex = html.indexOf("=", markerIndex);
  const searchFrom = equalsIndex !== -1 && equalsIndex - markerIndex < 120 ? equalsIndex : markerIndex;
  const start = html.indexOf("{", searchFrom);
  if (start === -1) return null;
  let inString = false, quote = "", escaped = false, depth = 0;
  for (let index = start; index < html.length; index += 1) {
    const char = html[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) inString = false;
      continue;
    }
    if (char === "\"" || char === "'") { inString = true; quote = char; }
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        try { return JSON.parse(html.slice(start, index + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

function textFromRuns(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (value.simpleText) return value.simpleText;
  if (Array.isArray(value.runs)) return value.runs.map((run) => run.text || "").join("");
  return "";
}

function findNestedObject(value, predicate, depth = 0) {
  if (!value || typeof value !== "object" || depth > 16) return null;
  if (predicate(value)) return value;
  for (const child of Object.values(value)) {
    const found = findNestedObject(child, predicate, depth + 1);
    if (found) return found;
  }
  return null;
}

function extractYouTubeVideoId(rawUrl = "") {
  const urlText = String(rawUrl || "");
  const embedded = urlText.match(/https?:\/\/[^\s，。；,;]+/i)?.[0] || urlText;
  try {
    const parsed = new URL(embedded);
    if (parsed.hostname.includes("youtu.be")) return parsed.pathname.split("/").filter(Boolean)[0] || "";
    if (parsed.searchParams.get("v")) return parsed.searchParams.get("v") || "";
    const parts = parsed.pathname.split("/").filter(Boolean);
    const markerIndex = parts.findIndex((part) => ["shorts", "embed", "live"].includes(part));
    if (markerIndex >= 0) return parts[markerIndex + 1] || "";
  } catch {}
  return urlText.match(/[?&]v=([a-zA-Z0-9_-]{6,})/)?.[1] || urlText.match(/youtu\.be\/([a-zA-Z0-9_-]{6,})/)?.[1] || "";
}

async function fetchWithTimeout(resource, options = {}, timeoutMs = 2400) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(resource, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

function extractYouTubeDescription(initialData) {
  const secondary = findNestedObject(initialData, (item) => item.videoSecondaryInfoRenderer)?.videoSecondaryInfoRenderer;
  if (secondary?.attributedDescription?.content) return cleanText(secondary.attributedDescription.content);
  const expanded = findNestedObject(initialData, (item) => item.expandableVideoDescriptionBodyRenderer)?.expandableVideoDescriptionBodyRenderer;
  return cleanText(expanded?.attributedDescriptionBodyText?.content || expanded?.colorSampledDescriptionBodyText?.content || "");
}

function extractYouTubeChapters(initialData) {
  const markerList = findNestedObject(initialData, (item) => item.macroMarkersListRenderer)?.macroMarkersListRenderer;
  return (markerList?.contents || [])
    .map((item) => item.macroMarkersListItemRenderer)
    .filter(Boolean)
    .map((item) => {
      const time = textFromRuns(item.timeDescription);
      const title = textFromRuns(item.title);
      return time && title ? `${time} ${title}` : title;
    })
    .filter(Boolean);
}

async function extractYouTubeArticle(html, url) {
  const videoId = extractYouTubeVideoId(url);
  const initialData = extractJsonObjectAt(html, "var ytInitialData") || {};
  const playerResponse = extractJsonObjectAt(html, "var ytInitialPlayerResponse") || {};
  const primary = findNestedObject(initialData, (item) => item.videoPrimaryInfoRenderer)?.videoPrimaryInfoRenderer;
  const header = findNestedObject(initialData, (item) => item.videoDescriptionHeaderRenderer)?.videoDescriptionHeaderRenderer;
  let title = cleanText(playerResponse.videoDetails?.title || textFromRuns(primary?.title) || textFromRuns(header?.title));
  let author = cleanText(playerResponse.videoDetails?.author || textFromRuns(header?.channel));
  const description = cleanText(playerResponse.videoDetails?.shortDescription || extractYouTubeDescription(initialData));
  const chapters = extractYouTubeChapters(initialData);
  if ((!title || !author) && videoId) {
    try {
      const oembed = await fetchWithTimeout(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`, { headers: { "user-agent": "Mozilla/5.0" } }, 1800).then((r) => r.ok ? r.json() : null);
      title ||= cleanText(oembed?.title || "");
      author ||= cleanText(oembed?.author_name || "");
    } catch {}
  }
  const text = cleanText([
    author ? `作者：${author}` : "",
    description ? `视频简介：\n${description}` : "",
    chapters.length ? `章节：\n${chapters.join("\n")}` : "",
  ].filter(Boolean).join("\n\n"));
  if (!title && !text) return null;
  return { title: title || "YouTube 视频", text: text || "未读取到字幕或视频简介。", tags: ["YouTube", "视频"] };
}

function detectSourceType(url = "") {
  try {
    const host = new URL(url).hostname;
    if (host.includes("weixin")) return "公众号";
    if (host.includes("xiaohongshu") || host.includes("xhslink")) return "小红书";
    if (host.includes("bilibili") || host.includes("douyin") || host.includes("youtube") || host.includes("youtu.be")) return "视频";
    return "网页";
  } catch {
    return "灵感";
  }
}

function sentenceSplit(text) {
  return cleanText(text).split(/(?<=[。！？.!?])\s+|\n+/).map((item) => item.trim()).filter((item) => item.length >= 12).slice(0, 80);
}

function extractTimedChapters(text) {
  const seen = new Set();
  return cleanText(text).split(/\n+/).map((line) => {
    const match = line.trim().match(/^((?:\d{1,2}:)?\d{1,2}:\d{2})\s+(.{3,120})$/);
    if (!match) return null;
    const title = match[2].replace(/^Capability\s+\d+\s*-\s*/i, "").replace(/^Bonus Feature\s*-\s*/i, "Bonus: ").trim();
    const key = title.toLowerCase();
    if (!title || seen.has(key)) return null;
    seen.add(key);
    return { time: match[1], title };
  }).filter(Boolean);
}

function pickTags(text, title, url, hints = []) {
  const tagMap = [["ai", "AI"], ["codex", "Codex"], ["gpt", "GPT"], ["知识库", "知识库"], ["保险", "保险"], ["健康", "健康服务"], ["医疗", "医疗"], ["产品", "产品"], ["用户", "用户经营"], ["小红书", "小红书"], ["公众号", "公众号"], ["视频", "视频"]];
  const haystack = `${title}\n${text}`.toLowerCase();
  const tags = [];
  for (const [needle, tag] of tagMap) if (haystack.includes(needle.toLowerCase()) && !tags.includes(tag)) tags.push(tag);
  for (const hint of hints) {
    const clean = normalizeTag(hint);
    if (clean && haystack.includes(clean.toLowerCase()) && !tags.includes(clean)) tags.push(clean);
  }
  try {
    const host = new URL(url).hostname;
    if (host.includes("xiaohongshu")) tags.push("小红书");
    if (host.includes("weixin")) tags.push("公众号");
  } catch {}
  return [...new Set(tags)].slice(0, 6);
}

function summarizeText({ text, title, url, hints = [] }) {
  const source = cleanText(text);
  const sourceType = detectSourceType(url);
  const tags = pickTags(source, title, url, hints);
  if (sourceType === "视频") {
    const chapters = extractTimedChapters(source);
    if (chapters.length >= 3) {
      const topicTitles = chapters.map((chapter) => chapter.title).filter((chapterTitle) => !/^(intro|summary)$/i.test(chapterTitle));
      const mainTopics = topicTitles.slice(0, 6);
      const topicText = mainTopics.join("、");
      return {
        summary: `视频「${title}」按章节讲解 ${topicText}${topicTitles.length > mainTopics.length ? "等" : ""}，适合先收藏后按能力点回看。`,
        keyPoints: [
          `主线：${topicText}${topicTitles.length > mainTopics.length ? "等" : ""}。`,
          `章节定位：${chapters.slice(0, 8).map((chapter) => `${chapter.time} ${chapter.title}`).join("；")}。`,
        ],
        tags,
        coreInfo: { sourceType, wordCount: source.length, knowledgeHints: hints.filter((hint) => source.includes(hint)).slice(0, 5) },
      };
    }
  }
  const sentences = sentenceSplit(source);
  const keywords = ["核心", "关键", "增长", "用户", "风险", "机会", "策略", "效率", "数据", "成本", "转化", "闭环", "知识库"];
  const picked = sentences.map((sentence, index) => {
    const keywordScore = keywords.reduce((score, keyword) => score + (sentence.includes(keyword) ? 2 : 0), 0);
    const numberScore = /\d|%|≥|<=|>=/.test(sentence) ? 2 : 0;
    const lengthScore = sentence.length > 30 && sentence.length < 140 ? 2 : 0;
    return { sentence, score: keywordScore + numberScore + lengthScore - index * 0.04 };
  }).sort((a, b) => b.score - a.score).slice(0, 4).map((item) => item.sentence.replace(/^[\-•\s]+/, "").replace(/^\d+[.、]\s+/, ""));
  const fallback = source.slice(0, 220) || "当前内容较短，建议补充正文后再生成更完整的小结。";
  const keyPoints = (picked.length ? picked : [fallback]).map((item) => item.slice(0, 180));
  return { summary: keyPoints.slice(0, 2).join("\n"), keyPoints, tags, coreInfo: { sourceType, wordCount: source.length, knowledgeHints: hints.filter((hint) => source.includes(hint)).slice(0, 5) } };
}

async function readKnowledgeHints(kbDir = KB_DIR) {
  try {
    const entries = await readdir(kbDir, { recursive: true });
    return entries.filter((entry) => entry.endsWith(".md") || entry.endsWith(".json")).slice(0, 80).map((entry) => path.basename(entry, path.extname(entry)).replace(/^概念_|^MOC_/, "")).filter(Boolean);
  } catch {
    return ["内容管理", "知识库", "收藏", "摘要", "灵感", "标签"];
  }
}

async function parseUrl(url) {
  const started = Date.now();
  const parsed = new URL(url);
  const sourceType = detectSourceType(url);
  let html = "", fetchError = "";
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2200);
    const response = await fetch(parsed, {
      signal: controller.signal,
      headers: {
        "user-agent": sourceType === "公众号"
          ? "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 MicroMessenger/8.0.47"
          : sourceType === "视频" && (parsed.hostname.includes("youtube") || parsed.hostname.includes("youtu.be"))
            ? "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36"
            : "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
        accept: "text/html,application/xhtml+xml,text/plain",
      },
    });
    clearTimeout(timer);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    html = await response.text();
  } catch (error) {
    fetchError = error?.name === "AbortError" ? "解析超时，已使用链接信息生成占位文本" : String(error.message || error);
  }
  if (html) {
    const structured = sourceType === "公众号" ? extractWeChatArticle(html, url)
      : sourceType === "小红书" ? extractXhsArticle(html)
        : sourceType === "视频" && (parsed.hostname.includes("youtube") || parsed.hostname.includes("youtu.be")) ? await extractYouTubeArticle(html, url)
          : null;
    const title = structured?.title || extractTitle(html, url);
    const text = (structured?.text || stripHtml(html)).slice(0, 18_000);
    return { url, title, text: text || `${title}\n来源：${parsed.hostname}`, tags: structured?.tags || [], parseStatus: "ok", parseMs: Date.now() - started };
  }
  return { url, title: parsed.hostname, text: `链接来源：${parsed.hostname}\n路径：${parsed.pathname || "/"}\n${fetchError}\n\n可先收藏该链接，稍后补充正文或在知识库中二次整理。`, parseStatus: "fallback", parseError: fetchError, parseMs: Date.now() - started };
}

function looksLikeBlockedPage(text, url = "") {
  const source = cleanText(text);
  const sourceType = detectSourceType(url);
  const blockedSignals = ["当前环境异常", "完成验证后即可继续访问", "请在微信客户端打开链接", "访问环境异常", "安全验证", "扫码验证", "操作频繁", "请稍后再试"];
  return ["公众号", "小红书"].includes(sourceType) && blockedSignals.some((signal) => source.includes(signal));
}

function titleFromManualText(text, url) {
  const firstLine = cleanText(text).split(/\n|。|！|？/)[0]?.trim();
  if (firstLine && firstLine.length >= 6 && firstLine.length <= 80 && !/^https?:\/\//i.test(firstLine)) return firstLine;
  try { return new URL(url).hostname; } catch { return "手动粘贴内容"; }
}

function slugify(input) {
  return cleanText(input).replace(/[\\/:*?"<>|#%{}~&]/g, "").replace(/\s+/g, "-").slice(0, 60) || "note";
}

function markdownForNote(note) {
  const lines = ["---", `id: ${note.id}`, `type: ${note.type}`, `favorite: ${Boolean(note.favorite)}`, `category: ${note.category || "未分类"}`, `source: ${note.url || ""}`, `created: ${note.createdAt}`, `updated: ${note.updatedAt}`, `tags: [${(note.tags || []).join(", ")}]`, "---", "", `# ${note.title}`, "", "## 小结", "", note.summary || "", "", "## 重点", "", ...(note.keyPoints || []).map((point) => `- ${point}`), "", "## 标签", "", (note.tags || []).map((tag) => `#${tag}`).join(" "), "", "## 原文/灵感", "", note.sourceText || note.body || ""];
  return `${lines.join("\n")}\n`;
}

async function syncToKnowledgeBase(note) {
  const date = new Date(note.createdAt).toISOString().slice(0, 10);
  const filename = `${date}_${slugify(note.title)}.md`;
  if (useGitHubStore()) {
    const remotePath = path.posix.join(GITHUB_KB_PREFIX, filename);
    await writeGitHubFile(remotePath, markdownForNote(note), `Sync smart note ${note.id}`);
    return `github:${GITHUB_REPO}/${remotePath}`;
  }
  const dir = path.join(KB_DIR, "智慧笔记摘要本");
  await mkdir(dir, { recursive: true });
  const filepath = path.join(dir, filename);
  await writeFile(filepath, markdownForNote(note), "utf8");
  return filepath;
}

function filterNotes(notes, query) {
  let result = [...notes];
  const q = (query.get("query") || "").trim().toLowerCase();
  const favorite = query.get("favorite");
  const type = query.get("type");
  const tag = normalizeTag(query.get("tag") || "");
  if (q) result = result.filter((note) => [note.title, note.summary, note.sourceText, note.body, note.url, ...(note.tags || [])].join("\n").toLowerCase().includes(q));
  if (favorite === "true") result = result.filter((note) => note.favorite);
  if (type) result = result.filter((note) => note.type === type);
  if (tag) result = result.filter((note) => (note.tags || []).includes(tag));
  return result.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

export async function handleApi(req, res, url) {
  if (!publicRoute(req, url.pathname) && !requireSession(req)) {
    fail(res, 401, "unauthorized", "需要登录后访问");
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/health") {
    json(res, 200, { ok: true, name: "智慧笔记摘要本", kbDir: KB_DIR, store: useGitHubStore() ? "github" : "local" });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/session") {
    const body = await requestBody(req);
    if (String(body.passcode || "") !== APP_PASSCODE) return fail(res, 401, "invalid_passcode", "访问口令不正确");
    const token = makeSessionToken();
    sessions.set(token, { createdAt: Date.now(), expiresAt: Date.now() + 12 * 60 * 60 * 1000 });
    json(res, 200, { token, expiresIn: 43_200 });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/notes") {
    const store = await readStore();
    const limit = Math.min(Number(url.searchParams.get("limit") || 20), 50);
    const cursor = Number(url.searchParams.get("cursor") || 0);
    const filtered = filterNotes(store.notes, url.searchParams);
    json(res, 200, { items: filtered.slice(cursor, cursor + limit), nextCursor: cursor + limit < filtered.length ? cursor + limit : null, total: filtered.length });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/stats") {
    const store = await readStore();
    const tags = new Map();
    for (const note of store.notes) for (const tag of note.tags || []) tags.set(tag, (tags.get(tag) || 0) + 1);
    json(res, 200, { total: store.notes.length, favorites: store.notes.filter((note) => note.favorite).length, insights: store.notes.filter((note) => note.type === "insight").length, synced: store.notes.filter((note) => note.syncedAt).length, tags: [...tags.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12) });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/content") {
    const body = await requestBody(req);
    if (!body.url) return fail(res, 422, "missing_url", "请输入 URL");
    const manualText = cleanText(body.manualText || body.text || body.sourceText || "");
    let parsed;
    try {
      parsed = manualText ? { url: body.url, title: cleanText(body.title || "") || titleFromManualText(manualText, body.url), text: manualText.slice(0, 18_000), parseStatus: "manual", parseMs: 0 } : await parseUrl(body.url);
    } catch {
      return fail(res, 422, "invalid_url", "URL 格式不正确");
    }
    if (!manualText && looksLikeBlockedPage(parsed.text, parsed.url)) return fail(res, 422, "manual_text_required", "这个平台限制直接抓取，请粘贴正文或重点摘录后生成小结");
    const hints = await readKnowledgeHints(body.knowledgeBaseDir || KB_DIR);
    const summary = summarizeText({ ...parsed, hints });
    const timestamp = now();
    const note = { id: makeId(), type: "link", url: parsed.url, title: parsed.title, sourceText: parsed.text, parseStatus: parsed.parseStatus, parseError: parsed.parseError || "", parseMs: parsed.parseMs, summary: summary.summary, keyPoints: summary.keyPoints, tags: [...new Set([...(summary.tags || []), ...(parsed.tags || []), ...(body.tags || []).map(normalizeTag).filter(Boolean)])], category: body.category || summary.coreInfo.sourceType, favorite: Boolean(body.favorite), coreInfo: summary.coreInfo, createdAt: timestamp, updatedAt: timestamp };
    const store = await readStore();
    store.notes.push(note);
    await writeStore(store);
    json(res, 201, { item: note });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/notes") {
    const body = await requestBody(req);
    const text = cleanText(body.body || body.text || "");
    if (!text && !body.drawingDataUrl) return fail(res, 422, "missing_content", "请输入灵感内容或手写笔迹");
    const hints = await readKnowledgeHints(body.knowledgeBaseDir || KB_DIR);
    const title = cleanText(body.title || text.split(/\n/)[0] || "手写灵感").slice(0, 80);
    const summary = summarizeText({ text, title, hints });
    const timestamp = now();
    const note = { id: makeId(), type: "insight", title, body: text, sourceText: text, drawingDataUrl: body.drawingDataUrl || "", summary: summary.summary, keyPoints: summary.keyPoints, tags: [...new Set([...(summary.tags || []), ...(body.tags || []).map(normalizeTag).filter(Boolean)])], category: body.category || "灵感", favorite: Boolean(body.favorite), coreInfo: summary.coreInfo, createdAt: timestamp, updatedAt: timestamp };
    const store = await readStore();
    store.notes.push(note);
    await writeStore(store);
    json(res, 201, { item: note });
    return;
  }
  const noteMatch = url.pathname.match(/^\/api\/notes\/([^/]+)(?:\/(sync))?$/);
  if (noteMatch) {
    const [, id, action] = noteMatch;
    const store = await readStore();
    const index = store.notes.findIndex((note) => note.id === id);
    if (index === -1) return notFound(res);
    if (req.method === "GET" && !action) return json(res, 200, { item: store.notes[index] });
    if (req.method === "PATCH" && !action) {
      const body = await requestBody(req);
      const current = store.notes[index];
      for (const key of ["title", "summary", "category", "favorite", "body", "sourceText"]) if (Object.hasOwn(body, key)) current[key] = body[key];
      if (Array.isArray(body.tags)) current.tags = [...new Set(body.tags.map(normalizeTag).filter(Boolean))];
      current.updatedAt = now();
      store.notes[index] = current;
      await writeStore(store);
      return json(res, 200, { item: current });
    }
    if (req.method === "DELETE" && !action) {
      const [removed] = store.notes.splice(index, 1);
      await writeStore(store);
      return json(res, 200, { item: removed });
    }
    if (req.method === "POST" && action === "sync") {
      const syncPath = await syncToKnowledgeBase(store.notes[index]);
      store.notes[index].syncedAt = now();
      store.notes[index].syncPath = syncPath;
      store.notes[index].updatedAt = now();
      await writeStore(store);
      return json(res, 200, { item: store.notes[index], syncPath });
    }
  }
  notFound(res);
}

async function serveStatic(req, res, url) {
  const target = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const filepath = path.normalize(path.join(PUBLIC_DIR, target));
  if (!filepath.startsWith(PUBLIC_DIR)) return fail(res, 403, "forbidden");
  try {
    const content = await readFile(filepath);
    res.writeHead(200, { "content-type": MIME_TYPES[path.extname(filepath)] || "application/octet-stream" });
    res.end(content);
  } catch {
    notFound(res);
  }
}

function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    try {
      if (url.pathname.startsWith("/api/")) await handleApi(req, res, url);
      else await serveStatic(req, res, url);
    } catch (error) {
      fail(res, 500, "server_error", error?.message || String(error));
    }
  });
}

function listen(server, port, fallbackPorts = []) {
  server.removeAllListeners("error");
  server.once("error", (error) => {
    if (fallbackPorts.length && (error.code === "EADDRINUSE" || error.code === "EPERM")) return listen(server, fallbackPorts[0], fallbackPorts.slice(1));
    throw error;
  });
  server.listen(port, HOST, () => {
    const displayHost = HOST === "0.0.0.0" ? "localhost" : HOST;
    console.log(`智慧笔记摘要本已启动：http://${displayHost}:${port}`);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await mkdir(DEFAULT_KB_DIR, { recursive: true });
  listen(createServer(), PORT, process.env.PORT ? [] : [4174, 4175, 4176, 4177, 4178, 4179, 4180, 4181, 4182, 4183, 4184, 4185, 4186, 4187, 4188, 4189, 4190]);
}
