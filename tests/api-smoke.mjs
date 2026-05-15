import { spawn } from "node:child_process";
import { unlink } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";

const PORT = 43173;
const base = process.env.TEST_BASE_URL || `http://127.0.0.1:${PORT}`;
const child = process.env.TEST_BASE_URL ? null : spawn(process.execPath, ["server.js"], {
  cwd: new URL("..", import.meta.url),
  env: {
    ...process.env,
    PORT: String(PORT),
    APP_PASSCODE: "demo",
    APP_SECRET: "test-secret",
    DATA_DIR: fileURLToPath(new URL("../tmp-test-data", import.meta.url)),
    KB_DIR: fileURLToPath(new URL("../tmp-test-kb", import.meta.url)),
  },
  stdio: ["ignore", "pipe", "pipe"],
});

async function waitForServer() {
  const started = Date.now();
  while (Date.now() - started < 5000) {
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("server did not start");
}

async function request(path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`${path}: ${payload.error || response.status}`);
  return payload;
}

try {
  await waitForServer();
  const session = await request("/api/session", {
    method: "POST",
    body: JSON.stringify({ passcode: "demo" }),
  });
  const auth = { authorization: `Bearer ${session.token}` };
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
  await unlink(synced.syncPath).catch(() => {});
  console.log("api smoke passed");
} finally {
  child?.kill("SIGTERM");
}
