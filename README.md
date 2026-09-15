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
3. “发送记录”按每次上游投递保存成功/失败状态、消息摘要、上游通道和错误信息。

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

一个接口凭据绑定多个上游时，通知会并行发送到每一个绑定上游。Webhook 请求中提供的 `apiKey` 会被忽略；服务只使用绑定上游的已验证 API Key。
