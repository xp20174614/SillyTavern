# SillyTavern 多人同房聊天室改造 — 迭代计划

> **目标**：在保留 SillyTavern 全部原有功能（单用户聊天、AI 群聊等）的前提下，将其改造为支持多真实用户在同一房间实时聊天的聊天室。
>
> **技术约束**：
> - 增量修改，不重写核心文件；每次迭代改动 ≤5 个文件
> - 服务端逻辑放 `plugins/`（SillyTavern 服务端插件），UI 逻辑放 `public/scripts/extensions/`（前端扩展）
> - WebSocket 实时消息广播（`ws` 已为官方依赖，与主服务同端口复用）
> - 用户身份：浏览器生成 clientId（localStorage 持久化 baseId）+ 昵称
> - 安全提示：SillyTavern 官方多用户模式的数据以明文存储，不适合直接暴露公网（P3 需加固）

## P0 核心架构（必须最先完成）

| 状态 | 任务 | 说明 |
|------|------|------|
| [已完成] | **P0-1 服务端 WebSocket 基座** | ① 最小核心改动：`server-startup.js` 收集已创建的 http/https server，`plugin-loader.js` 新增 `initPluginSockets(servers)` 钩子，`server-main.js` 启动后调用——插件获得处理同端口 WebSocket 升级的能力；② 新增服务端插件 `plugins/sillyroom/`：房间管理（join/leave/成员列表/系统消息）、聊天广播、typing 提示、心跳保活、消息限频与长度限制、REST 状态接口 `/api/plugins/sillyroom/status`；③ `config.yaml` 开启 `enableServerPlugins` |
| [已完成] | **P0-2 聊天室客户端扩展基座** | 新增前端扩展 `public/scripts/extensions/sillyroom/`（内置扩展，自动加载）：WebSocket 客户端（自动重连退避）、clientId/昵称身份（localStorage）、浮动聊天室窗口（成员列表/消息流/输入框/typing 指示）、房间码加入、魔杖菜单入口 |

## P1 核心功能（聊天室与 SillyTavern 融合）

| 状态 | 任务 | 说明 |
|------|------|------|
| [已完成] | **P1-1 真人消息进入 ST 聊天流** | 房间内真人发言注入当前 ST 聊天（复用 `sendMessageAsUser`，昵称写入 `mes.name`，双 API 家族 prompt 均带说话人名）；本地 AI 回复以 `kind:'ai'` 中继广播到房间（带徽标展示）；`swipe`/`continue`/`quiet` 不广播、AI 中继不回注（防循环）；两个开关均可持久化关闭 |
| [已完成] | **P1-2 与官方多用户账号联动** | WS 握手校验 ST 会话 Cookie（多用户模式下），昵称默认取账号 Persona 名，未登录拒绝升级 |
| [已完成] | **P1-3 注入后自动回应（可选开关）** | 新增「自动回应」开关（默认关，localStorage 持久化）：注入真人消息后经 3 秒空闲防抖合并消息爆发，触发一次 `Generate('normal')`；防请求风暴采用「带冷却的全局节流」方案——15 秒全局冷却（冷却期内新消息只重排不请求）、生成中最多重试 2 次不中断、用户草稿让位、群聊/未选角色/空聊天跳过；`kind:'ai'` 中继不注入故不会引发循环；离开房间/关闭开关即撤销挂起定时器 |

## P2 体验优化

| 状态 | 任务 | 说明 |
|------|------|------|
| [已完成] | **P2-1 房间历史持久化** | 房间消息落盘到 `data/sillyroom/rooms/<roomId>.json`（共享目录——房间为账号无关实体，非每用户目录），1.5s 防抖合并写入 + 房间清空立即写入 + 优雅关停同步刷新（原子写 tmp+rename）；加入内存中不存在的房间时预载磁盘最近 50 条，复用现有回放链路，前端零改动；损坏文件静默降级 |
| [已完成] | **P2-2 离线补发与未读** | 断线期间消息缓存补发；窗口最小化时未读角标 |
| [已完成] | **P2-3 主题与 i18n 打磨** | 前端全部 UI 文案接入 ST 翻译体系：静态界面用 `data-i18n`（含 `[title]`/`[placeholder]` 属性键），动态文案用 `t` 模板标签；扩展自带词典 `locales.js`（en / zh-tw，键为中文源串，经 `addLocaleData` 注册，未覆盖语言回退中文原文）；服务端 system/error 消息附稳定 `key` + `args`（保留原中文 `text`/`message` 作为回退），客户端按 key 本地化渲染。CSS 配色全部走 ST 主题变量：状态灯 `--active/--golden/--warning`、气泡 `--SmartThemeBotMes/UserMesBlurTintColor`（修复默认主题下「我方」气泡与窗口同色不可辨）、阴影 `--SmartThemeShadowColor`、chip 徽标改 `color-mix(BodyColor)` 保证任意主题对比度 |

## P3 增强功能

| 状态 | 任务 | 说明 |
|------|------|------|
| [已完成] | **P3-1a 房主与踢人/禁言** | 首位进房者为房主（👑 徽标），房主离开/断开时转移给最早加入的剩余成员；房主点击成员 chip 弹出菜单：移出房间（被移出者收到 kicked 通知、清除自动重进）、禁言/解除禁言（被禁言者发言被拒 `err_muted`，typing 不受限）；成员 chip 显示 🔇 禁言标记；协议：joined/members 附 owner+muted、kick/mute 指令、kicked 事件、member_kicked/member_muted/member_unmuted 系统消息与 err_not_owner/err_bad_target/err_muted 错误（均带 en/zh-tw 词典）；房主与禁言为内存态（不落盘，重启后首位进房者重新成为房主） |
| [已完成] | **P3-1b 房间密码** | 服务端 `setpass` 指令（仅房主，空密码=取消锁定）+ join 密码校验（在人数校验后、离开原房间前执行，失败尝试消耗限频令牌防爆破）；`joined`/`members`/hello/REST 房间列表附 `hasPassword`（布尔，不泄露密码值）；客户端密码错误自动弹 prompt 重试（区分「需要密码」/「密码不正确」），成功加入后密码持久化 localStorage 供断线自动重连，主动离开/被踢/取消加入即清除；房主成员栏 🔒/🔓 锁按钮（设置/更换/清除），房间标签与房间建议 chip 显示 🔒；与房主/禁言一致为**内存态**（房间清空或重启即失效）；system `room_password_set/cleared` 与 error `err_password_required/err_wrong_password` 均带 key/args + en/zh-tw 词典 |
| [ ] | **P3-1c 房间列表 UI 增强** | 基础活跃房间建议 chips 已随 P0-2 落地（hello/REST 驱动）；增强项：手动刷新、按人数排序等 |
| [ ] | **P3-3 Route B 侧栏轮询 CSRF 修复**（建议人工审核后再执行） | 8fa782b52 并入的 Shared Rooms 侧栏原型（group-chats.js + tools/room-service）以 2s/4s 轮询 room-service POST 端点，请求缺少 CSRF token 全部被 403 拒绝（服务端刷 ForbiddenError 日志、面板实际不可用）——修复方向：轮询请求补 `getRequestHeaders()` CSRF 头或确认 room-service 路由的 CSRF 豁免策略；属 Route B 原型代码 + 核心文件 group-chats.js，需人工确认方案 |
| [已完成] | **P3-2 安全加固** | WS 握手鉴权（P1-2 已完成：多用户模式下校验 ST 会话 Cookie，未登录 403）；Origin 校验（P3-2）：升级链路前置 `isOriginAllowed()`——无 Origin（非浏览器客户端）放行、与 Host 同源（默认端口归一化，无端口 Host 兼容 TLS 终结代理）放行、`SILLYROOM_ALLOWED_ORIGINS` 白名单（精确来源锁端口 / 裸主机名任意端口 / `*` 全放行告警）放行，其余 403，防跨站 WebSocket 劫持；限频参数化（P3-2）：9 个 `SILLYROOM_*` 环境变量（限频/消息与昵称长度/人数/房间数/历史/心跳/帧上限），未设置用默认、非法回退、越界钳位，启动日志打印生效值；部署指引（P3-2）：`plugins/sillyroom/SECURITY.md`——防护一览、环境变量参考、Origin 规则与反向代理注意点、公网上线检查清单（nginx/caddy 完整配置示例留 P4-2） |

## P4 部署运维

| 状态 | 任务 | 说明 |
|------|------|------|
| [ ] | **P4-1 Docker 支持** | 确认容器内同端口 WS 升级可用，健康检查覆盖 sillyroom status 接口，补端口/卷挂载文档 |
| [ ] | **P4-2 反向代理文档** | nginx/caddy 的 WebSocket 升级配置示例（wss） |

---

> 版本演进详情见 [CHANGELOG.md](./CHANGELOG.md)。
> 注意：直接修改核心文件（server-main.js / server-startup.js / plugin-loader.js）的改动均为**增量最小改动**（合计 <25 行），目的是让服务端插件获得 WebSocket 能力，不影响原有请求链路。
