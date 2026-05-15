import { Readable, Writable } from "node:stream";
import { rm, unlink } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";

const base = process.env.TEST_BASE_URL || "";

async function inProcessRequest(path, options = {}) {
  if (!globalThis.__smartNoteHandleApi) {
    process.env.APP_PASSCODE ||= "demo";
    process.env.APP_SECRET ||= "test-secret";
    process.env.DATA_DIR ||= fileURLToPath(new URL("../tmp-test-data", import.meta.url));
    process.env.KB_DIR ||= fileURLToPath(new URL("../tmp-test-kb", import.meta.url));
    await rm(process.env.DATA_DIR, { recursive: true, force: true });
    await rm(process.env.KB_DIR, { recursive: true, force: true });
    globalThis.__smartNoteHandleApi = (await import("../server.js")).handleApi;
  }

  const req = Readable.from(options.body ? [options.body] : []);
  req.method = options.method || "GET";
  req.url = path;
  req.headers = {
    "content-type": "application/json",
    ...(options.headers || {}),
  };

  const chunks = [];
  let status = 200;
  const res = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  res.writeHead = (nextStatus) => {
    status = nextStatus;
    return res;
  };

  await globalThis.__smartNoteHandleApi(req, res, new URL(path, "http://localhost"));
  const text = Buffer.concat(chunks).toString("utf8");
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => (text ? JSON.parse(text) : {}),
  };
}

async function httpRequest(path, options = {}) {
  return fetch(`${base}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });
}

async function request(path, options = {}) {
  const response = base ? await httpRequest(path, options) : await inProcessRequest(path, options);
  const payload = await response.json();
  if (!response.ok) throw new Error(`${path}: ${payload.error || response.status}`);
  return payload;
}

const session = await request("/api/session", {
  method: "POST",
  body: JSON.stringify({ passcode: process.env.APP_PASSCODE || "demo" }),
});
const auth = { authorization: `Bearer ${session.token}` };

const health = await request("/api/health");
if (!health.storage && !health.store) throw new Error("storage health missing");

const created = await request("/api/notes", {
  method: "POST",
  headers: auth,
  body: JSON.stringify({
    title: "测试灵感",
    body: "这是一个关于知识库同步、收藏管理和摘要生成的测试灵感。",
    tags: ["测试"],
    favorite: true,
  }),
});
if (!created.item.id || !created.item.summary) throw new Error("note creation failed");

const list = await request("/api/notes?limit=5", { headers: auth });
if (!list.items.some((item) => item.id === created.item.id)) throw new Error("created note missing from list");

const link = await request("/api/content", {
  method: "POST",
  headers: auth,
  body: JSON.stringify({
    url: "https://mp.weixin.qq.com/s/demo",
    manualText: "这是一篇手动粘贴的公众号正文，用来验证链接和正文一起生成摘要、重点和标签。",
    tags: ["公众号"],
  }),
});
if (link.item.parseStatus !== "manual" || !link.item.summary) throw new Error("manual link creation failed");
if (link.item.favorite) throw new Error("link should not be favorite by default");

const favorited = await request(`/api/notes/${link.item.id}`, {
  method: "PATCH",
  headers: auth,
  body: JSON.stringify({ favorite: true }),
});
if (!favorited.item.favorite) throw new Error("favorite toggle failed");

const synced = await request(`/api/notes/${created.item.id}/sync`, {
  method: "POST",
  headers: auth,
  body: "{}",
});
if (!synced.syncPath) throw new Error("sync path missing");

await request(`/api/notes/${created.item.id}`, {
  method: "DELETE",
  headers: auth,
});
await request(`/api/notes/${link.item.id}`, {
  method: "DELETE",
  headers: auth,
});
if (!base) await unlink(synced.syncPath).catch(() => {});

console.log("api smoke passed");
