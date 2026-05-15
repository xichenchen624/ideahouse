# 智慧笔记摘要本

一个轻量 Web 原型：支持链接添加、自动解析和小结生成、收藏/标签管理、灵感输入、手写画布、本地加密存储、知识库 Markdown 同步。

## 启动

```bash
npm start
```

打开 `http://localhost:4173`，默认访问口令是 `demo`。如果本机已有旧服务占用端口，服务会自动顺延到后续端口，终端会显示实际地址。

## 本地配置

- `APP_PASSCODE`：访问口令，默认 `demo`
- `APP_SECRET`：服务端数据加密密钥，默认使用访问口令
- `KB_DIR`：知识库目录，默认写入本项目的 `kb/智慧笔记摘要本`
- `PORT`：服务端端口，默认 `4173`
- `HOST`：本地监听地址，默认 `127.0.0.1`

## 线上部署

项目已经支持 Vercel 部署：

- `public/index.html`：手机端页面
- `api/[...path].js`：线上 REST API 入口
- `server.js`：本地开发服务和 API 共享逻辑
- `vercel.json`：Vercel 函数和前端路由配置

线上版不要使用本地文件存储。部署到 Vercel 时需要配置这些环境变量：

- `APP_PASSCODE`：访问口令，不要用默认值
- `APP_SECRET`：至少 32 位随机字符串，用于 token 签名和数据加密
- `GITHUB_TOKEN`：GitHub fine-grained token，只授予目标仓库 Contents read/write
- `GITHUB_REPO`：例如 `owner/repo`
- `GITHUB_BRANCH`：通常是 `main`
- `GITHUB_DATA_PATH`：默认 `remote-data/notes.enc.json`
- `GITHUB_KB_PREFIX`：默认 `kb/智慧笔记摘要本`

部署流程：

1. 把本项目推送到 GitHub。
2. 在 Vercel 中选择 `Import Git Repository`。
3. Framework 选择 `Other` 或保留默认静态项目识别。
4. 添加上面的环境变量。
5. Deploy。

部署后，手机直接打开 Vercel 生成的 HTTPS 地址即可。

## REST API

- `POST /api/session`：登录获取会话令牌
- `GET /api/notes`：分页、搜索、筛选笔记
- `POST /api/content`：提交 URL，解析正文并生成小结
- `POST /api/notes`：创建文本/手写灵感
- `PATCH /api/notes/:id`：更新收藏、标签、分类、正文
- `POST /api/notes/:id/sync`：同步单条内容到知识库 Markdown
- `GET /api/stats`：统计内容、收藏、灵感和标签

## 原型边界

- 链接解析使用 2.2 秒超时；已针对公众号、小红书分享链接、YouTube 视频做专门解析。平台触发验证时，需要在添加窗口粘贴正文或摘录后生成。
- YouTube 可读取公开标题、作者、简介、章节和可公开访问的字幕；若字幕接口被登录/反爬限制，会先基于简介和章节生成小结。
- 摘要逻辑是本地启发式版本，后续可接入 Codex/LLM 服务替换 `summarizeText`。
- 前端使用 IndexedDB 做加密缓存；服务端使用 AES-256-GCM 加密落盘。
