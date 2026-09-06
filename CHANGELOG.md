# 更新日志 (CHANGELOG)

记录本项目将 SillyTavern 改造为多人同房聊天室的版本演进。格式参考 [Keep a Changelog](https://keepachangelog.com/)，迭代计划见 [ITERATION_PLAN.md](./ITERATION_PLAN.md)。

## [SillyRoom 0.1.0] — 2026-09-06

### 迭代 P0-1：服务端 WebSocket 基座（commit `246908884`）

**改动内容**
- `src/server-startup.js`：`ServerStartup` 类新增 `servers` 字段，`#createHttpServer` / `#createHttpsServer` 创建的服务器实例统一收集，供插件使用（+8 行，纯追加）
- `src/plugin-loader.js`：新增导出 `initPluginSockets(servers)`——服务器开始监听后，为导出了可选 `initSocket(servers)` 函数的插件建立 WebSocket 能力（+26 行，纯追加）
- `src/server-main.js`：启动链尾捕获 `ServerStartup` 实例，`postSetupTasks(result, startup)` 开头调用 `initPluginSockets`（+9 行）
- `plugins/sillyroom/index.mjs`（新增）：SillyRoom 服务端插件
  - WebSocket 端点 `ws(s)://<host>:<port>/api/plugins/sillyroom/ws`（与主服务同端口，无需开放额外端口）
  - 房间模型：加入/离开/切换房间、成员列表广播、系统通知（进房/离房/改名）、typing 转发、最近 50 条历史回放、空房自动回收
  - REST 状态接口 `GET /api/plugins/sillyroom/status`
  - 防护：消息长度截断（2000 字符）、昵称清洗（24 字符 + 控制字符过滤）、clientId/房间码格式校验、滑动窗口限频（5 秒 15 条）、每房 32 人上限、每连接 64KB 帧上限、30 秒心跳剔除死连接
  - `exit()` 钩子：关停时移除 upgrade 监听、关闭全部连接
- `config.yaml`：`enableServerPlugins: false → true`

**改动原因**
SillyTavern 插件加载器仅在监听前传入 express router，插件拿不到 `httpServer`，无法处理 WebSocket 协议升级。上述核心改动是让插件获得同端口 WebSocket 能力的最小增量方案（合计约 43 行，不改任何既有逻辑）。

**测试结果**
- 服务器正常启动：`1 server plugin(s) are currently loaded`，`SillyRoom: WebSocket endpoint ready`
- REST 状态接口返回正常
- Node 双客户端集成测试 11 项全部通过：双人加入同一房间、聊天广播与发送者回显（消息 id 一致）、typing 转发、迟到者历史回放、断开时成员通知、超长消息截断、未入房发言报错、非本插件 upgrade 路径拒绝

### 迭代 P0-2：聊天室前端扩展（commit `5c0dc9f7b`）

**改动内容**
- `public/scripts/extensions/sillyroom/`（新增，内置扩展自动加载）
  - `manifest.json`：扩展清单，`activate` 钩子调用 `init()`
  - `index.js`：WebSocket 客户端
    - 身份：`localStorage` 持久化 baseId + 昵称；每次连接生成唯一 clientId（baseId + 随机后缀，同一浏览器多窗口互为独立成员）
    - 连接：指数退避自动重连（1s→30s 封顶）、断线自动重入上次房间、`https` 自动切换 `wss`
    - UI：右下角浮动聊天窗口（状态灯、房间码加入/离开、昵称点击改名、活跃房间建议、成员 chips、消息流、typing 提示、Enter/按钮发送）；魔杖菜单入口「💬 聊天室」；窗口开关状态持久化
    - 安全：所有动态文本经 `textContent`/`jQuery.text` 渲染，无 innerHTML 注入面
  - `style.css`：窗口样式，全部基于 ST 主题 CSS 变量（明暗主题自适应）

**改动原因**
为 P0-1 的服务端房间协议提供用户可见入口，实现多真实用户同房实时聊天（最小可用版本）。

**测试结果（双浏览器窗口实测）**
- 窗口A（用户A）与窗口B（用户B）同时加入房间 `room1`：双方成员列表实时同步（含「（我）」标记）
- A 发送消息 → B 实时收到；B 发送消息 → A 实时收到；发送后输入框自动清空
- B 刷新重连 → 自动以存储的身份重入房间，A 端收到「离开了房间 / 加入了房间」系统消息
- 新成员加入可回放房间历史消息
- 浏览器控制台无报错，无 toastr 错误通知
- 已知工具限制（非产品缺陷）：自动化合成键盘（Playwright/CDP）在该环境无法派发 trusted keydown，Enter 发送路径已通过页面内事件派发验证（事件被处理、输入清空、消息发出）；真实键盘输入走同一监听路径

### 其他

- `docker/docker-compose.yml` 的工作区改动为本机部署配置（卷挂载路径调整），不属于本次迭代，未纳入提交
- 测试用数据目录 `data-test/` 与测试实例（端口 8001）不进入版本库，测试后清理
