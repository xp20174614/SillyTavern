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
| [ ] | **P2-3 主题与 i18n 打磨** | 适配 ST 全部明暗主题变量，接入 ST 翻译体系（data-i18n） |

## P3 增强功能

| 状态 | 任务 | 说明 |
|------|------|------|
| [ ] | **P3-1 房间管理增强** | 房主权限（踢人/禁言）、房间密码、房间列表 UI |
| [ ] | **P3-2 安全加固** | WS 握手鉴权、Origin 校验、限频参数化、HTTPS/wss 部署指引（公网必读） |

## P4 部署运维

| 状态 | 任务 | 说明 |
|------|------|------|
| [ ] | **P4-1 Docker 支持** | 确认容器内同端口 WS 升级可用，健康检查覆盖 sillyroom status 接口，补端口/卷挂载文档 |
| [ ] | **P4-2 反向代理文档** | nginx/caddy 的 WebSocket 升级配置示例（wss） |

---

> 版本演进详情见 [CHANGELOG.md](./CHANGELOG.md)。
> 注意：直接修改核心文件（server-main.js / server-startup.js / plugin-loader.js）的改动均为**增量最小改动**（合计 <25 行），目的是让服务端插件获得 WebSocket 能力，不影响原有请求链路。
