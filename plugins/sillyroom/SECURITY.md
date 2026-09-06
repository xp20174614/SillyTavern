# SillyRoom 安全与部署加固指南

> 面向将 SillyRoom（`plugins/sillyroom/`）暴露到非本机网络（局域网 / 公网）的部署者。
> 计划来源：`ITERATION_PLAN.md` P3-2（本文件）；P4-1（Docker 健康检查）、P4-2（nginx/caddy 完整示例）为后续迭代。

## 1. 必读：明文存储的既有限制

SillyTavern 官方多用户模式的所有数据（账号、聊天记录、设置）以**明文**存储在 `data/` 目录，这是官方既有限制，SillyRoom 的房间历史（`data/sillyroom/rooms/*.json`，含昵称与聊天文本）同理。**不要将 `data/` 目录暴露给不受信任的一方**（含备份、镜像、网络共享）。

## 2. 内置防护一览

| 防护 | 机制 | 引入版本 |
|------|------|----------|
| 会话鉴权 | `enableUserAccounts: true` 时，WS 握手用与主应用相同的 cookie-session 校验登录会话（handle → 账号存在 → 未禁用），未登录 HTTP 403 拒绝升级 | 0.4.0（P1-2） |
| Origin 校验（CSWSH 防护） | 浏览器 WS 握手必带 `Origin`，与请求 `Host` 同源才放行；非浏览器客户端（无 Origin）不受影响；`SILLYROOM_ALLOWED_ORIGINS` 可加白名单；其余 403 | 0.8.0（P3-2） |
| 消息限频 | 每连接滑动窗口限频（默认 15 条 / 5 秒），超限返回 `err_rate_limited` | 0.1.0（P0-1） |
| 容量限额 | 消息 2000 字符、昵称 24 字符、每房 32 人、100 房间、历史 50 条、单帧 64KB | 0.1.0（P0-1），0.8.0 起可调 |
| 死连接清理 | 心跳 ping/pong，无响应连接被断开 | 0.1.0（P0-1） |
| 输入清洗 | 控制字符剥离、clientId/roomId/nonce 白名单校验、落盘历史逐条重新清洗；前端全部动态文本经 `textContent` 渲染（无 innerHTML 注入面） | 0.1.0 / 0.6.0 |

## 3. 运行参数（环境变量，0.8.0 起）

所有限额均可通过环境变量调整：未设置用默认值；非法值告警并回退默认；超出上下界则钳位。启动日志会打印全部生效值。

| 环境变量 | 默认 | 说明 |
|----------|------|------|
| `SILLYROOM_RATE_LIMIT_MAX` | 15 | 每连接限频窗口内最大消息数。⚠️ 前端离线补发缓存固定 15 条并按默认限频校准，调低后断线补发可能触发限频（消息保留在缓存，重连窗口后重试） |
| `SILLYROOM_RATE_LIMIT_WINDOW_MS` | 5000 | 限频滑动窗口长度（毫秒） |
| `SILLYROOM_MAX_MESSAGE_CHARS` | 2000 | 单条消息最大字符数 |
| `SILLYROOM_MAX_NAME_CHARS` | 24 | 昵称最大字符数 |
| `SILLYROOM_MAX_MEMBERS` | 32 | 每房间成员上限 |
| `SILLYROOM_MAX_ROOMS` | 100 | 同时存在的房间数上限 |
| `SILLYROOM_HISTORY_LIMIT` | 50 | 内存与落盘保留的历史条数 |
| `SILLYROOM_HEARTBEAT_INTERVAL_MS` | 30000 | 心跳间隔（毫秒） |
| `SILLYROOM_MAX_FRAME_BYTES` | 65536 | 单个 WebSocket 帧上限（字节） |
| `SILLYROOM_ALLOWED_ORIGINS` | （空） | Origin 白名单，逗号分隔，见第 4 节 |

设置示例（Linux / docker `-e` 同理）：

```bash
SILLYROOM_RATE_LIMIT_MAX=30 SILLYROOM_MAX_MEMBERS=64 node server.js
```

## 4. Origin 校验规则

浏览器发起 WebSocket 握手时必定携带 `Origin` 头，SillyRoom 据此阻断**跨站 WebSocket 劫持**（恶意网页借访问者的浏览器与登录态连接本端点）。放行条件（任一满足）：

1. 请求**无 `Origin` 头**——非浏览器客户端（curl、Node 脚本、桌面工具）不受影响；
2. Origin 的 `host:port` 与请求 `Host` 头**同源**（协议默认端口归一化：http→80、https→443；`Host` 不带端口时按「经由 80/443 默认端口或 TLS 终结代理到达」处理，两种默认端口均接受）；
3. Origin 命中 `SILLYROOM_ALLOWED_ORIGINS` 白名单——条目形如 `https://chat.example.com`、`10.0.0.5:8000`；不带端口的裸主机名（如 `chat.example.com`）匹配该主机任意端口；设为 `*` 放行所有 Origin（**不建议**，启动日志会明示 allow-all）。

其余一律 HTTP 403 拒绝，服务端日志记录原因（`cross-origin` / `malformed-origin` / `unsupported-origin-scheme` 等）。

### 反向代理部署的 Origin 注意点

- nginx 默认 `proxy_set_header Host $host;` 会保留外部主机名 → 同源判定天然成立，**无需**白名单；
- 若代理把 Host 改写为上游地址（如 `proxy_set_header Host 127.0.0.1:8000;`），浏览器 Origin（外部域名）与 Host 必然不同 → **必须**设置 `SILLYROOM_ALLOWED_ORIGINS=https://你的外部域名`；
- Docker 端口映射直连（`-p 8000:8000` 后访问 `http://宿主机IP:8000`）属于带端口同源，无需额外配置。

## 5. 上线检查清单（公网必读）

1. **启用官方多用户模式**（`enableUserAccounts: true`）——单用户模式下任何能连上端口的人都以「访客」身份进出任意房间（无 Origin 校验豁免之外的鉴权）；
2. **全程 HTTPS / wss**：以 `--ssl` 启动 SillyTavern 或在反向代理终结 TLS；聊天内容与会话 cookie 均不应明文过网；
3. **保护数据目录**：`data/`（账号、聊天、SillyRoom 房间历史 JSON）只应服务端可读，见第 1 节；
4. 按需收紧第 3 节的环境变量（限频、人数、房间数、历史条数）；
5. wss 经反向代理时需透传 HTTP `Upgrade` / `Connection` 头（nginx/caddy 完整配置示例见计划 P4-2）；
6. 端点：`/api/plugins/sillyroom/ws`（WebSocket）、`/api/plugins/sillyroom/status`（REST，仅房间/连接计数，不含聊天内容）。

## 6. 已知边界

- 无 `Origin` 头的客户端不做来源校验：多用户模式下仍受会话鉴权保护；单用户模式下与 0.1.0 以来行为一致（本机部署假设）；
- `session.version` 未镜像校验（P1-2 已知边界）：密码重置后旧会话 cookie 存在极短宽限窗口；
- 房间内发言以昵称为准，账号与昵称之间无强制绑定展示（后续可在 P3-1 房主权限中做「成员已验证」徽标）。
