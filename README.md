# CMCC New Message Webhook

中国移动新消息的 Gotify/Webhook 网关，带管理 UI、上游 API Key 验证、多上游绑定与 SQLite 发送记录。

## 启动

```bash
npm install
cp .env.example .env
npm run build
npm start
```

PowerShell 使用 `Copy-Item .env.example .env`。启动前必须在 `.env` 配置 `ADMIN_USERNAME`、`ADMIN_PASSWORD`、`CONFIG_ENCRYPTION_KEY`。后者用于 AES-256-GCM 加密 SQLite 中的上游 API Key 和接口密钥，丢失后无法恢复已保存密钥。

访问 `http://localhost:3000/` 登录管理台。

## 管理台

1. 在“上游通道”输入名称和中国移动 `ak_...` API Key。服务先执行 WebSocket `auth` 验证；通过后才保存。
2. 在“接口鉴权”创建 Gotify Token 或 Webhook Bearer Secret，勾选一个或多个上游通道保存。新密钥只在创建时完整显示一次。
3. “手动推送”可发送文本、远程媒体 URL，或上传不超过 200MB 的图片、音频、视频和文件。
4. “发送记录”按每次上游提交保存成功/失败状态、消息摘要、上游通道和错误信息。

文本按 OpenClaw 通道约定转换为纯文本并以 2000 字符分片。CMCC 通道不提供 Markdown/HTML 格式化文本；富媒体使用插件支持的 `IMAGE`、`TEXT`、`AUDIO`、`VIDEO`、`FILE` 类型。富媒体带说明文字时，服务先提交独立文本消息，再提交媒体消息，避免终端忽略媒体报文中的 `content`。

管理员登录失败在 15 分钟内达到 5 次时，来源 IP 会被锁定 30 分钟。会话为 8 小时 HttpOnly、SameSite=Strict Cookie。HTTPS 部署设置 `ADMIN_COOKIE_SECURE=true`。

## 接口

Gotify：

```bash
curl -X POST 'http://localhost:3000/message?token=<gotify-token>' \
  -H 'Content-Type: application/json' \
  -d '{"title":"Alert","message":"Service unavailable","priority":5}'
```

普通 Webhook：

```bash
curl -X POST http://localhost:3000/webhook \
  -H 'Authorization: Bearer <webhook-secret>' \
  -H 'Content-Type: application/json' \
  -d '{"type":"send","content":"Hello"}'
```

远程富媒体：

```bash
curl -X POST http://localhost:3000/webhook \
  -H 'Authorization: Bearer <webhook-secret>' \
  -H 'Content-Type: application/json' \
  -d '{"type":"send","content":"Screenshot","mediaType":"IMAGE","mediaUrl":"https://cdn.example.com/screenshot.png"}'
```

一个接口凭据绑定多个上游时，通知会并行发送到每一个绑定上游。Webhook 请求中提供的 `apiKey` 会被忽略；服务只使用绑定上游的已验证 API Key。

## CMCC 协议兼容

服务与插件一样在 WebSocket 握手中传递 `X-API-Key`，连接后发送 `{"type":"auth","apiKey":"...","version":"2.0"}`。`version` 由 `CMCC_WS_VERSION` 配置，表示 CMCC 通道协议版本，不是 OpenClaw 应用版本。

本地文件先通过 `CMCC_UPLOAD_URL/upload` 上传；multipart 字段为 `file` 和 `apiKey`。上传超时由 `CMCC_UPLOAD_TIMEOUT_MS` 控制。Web 后台对每个选中的上游 API Key 独立上传，再发送返回的媒体 URL。
