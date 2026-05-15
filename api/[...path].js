function trimConfigEnv() {
  for (const key of ["GITHUB_TOKEN", "GITHUB_REPO", "GITHUB_BRANCH", "GITHUB_DATA_PATH", "GITHUB_KB_PREFIX"]) {
    if (process.env[key]) process.env[key] = String(process.env[key]).trim();
  }
}

export default async function handler(req, res) {
  trimConfigEnv();
  const { handleApi } = await import("../server.js");
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
