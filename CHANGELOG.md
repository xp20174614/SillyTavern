# 更新日志 (CHANGELOG)

记录本项目将 SillyTavern 改造为多人同房聊天室的版本演进。格式参考 [Keep a Changelog](https://keepachangelog.com/)，迭代计划见 [ITERATION_PLAN.md](./ITERATION_PLAN.md)。

## [SillyRoom 0.8.0] — 2026-09-07

### 迭代 P3-2：安全加固（Origin 校验 + 限频参数化 + 部署指引）

**改动内容**
- `plugins/sillyroom/index.mjs`（唯一代码文件，核心文件零改动）：
  - **Origin 校验（CSWSH 防护）**：WebSocket 升级链路最前端新增 `isOriginAllowed()`——① 无 `Origin` 头（非浏览器客户端：curl/Node 脚本/集成测试）放行，既有工具链零影响；② 与请求 `Host` 同源放行（比较 `host:port`，协议默认端口归一化 http→80/https→443；`Host` 不带端口按「经 80/443 默认端口或 TLS 终结代理到达」处理，两种默认端口均接受）；③ 命中 `SILLYROOM_ALLOWED_ORIGINS` 白名单放行（精确来源如 `https://chat.example.com` 锁定端口；裸主机名如 `myhost` 匹配该主机任意端口；`*` 全放行并告警）；其余一律 403 拒绝并记录原因（`cross-origin`/`malformed-origin`/`unsupported-origin-scheme` 等稳定标识）。同源比较忽略 scheme——浏览器混合内容规则本就禁止 ws/wss 跨 scheme 混用
  - **限额全面环境变量化**：消息长度、昵称长度、每房人数、房间数、历史条数、限频窗口与上限、心跳间隔、单帧上限共 9 个 `SILLYROOM_*` 环境变量（`envLimit()` 统一实现：未设置用默认、非法值告警回退、越界钳位），启动日志打印全部生效值；`hello.limits` 自动跟随（前端兼容字段不变）
  - 启动日志新增 origin 策略行（`same-origin only` / `+ N allowlisted` / `allow-all (*)`）
- `plugins/sillyroom/SECURITY.md`（新增，部署安全指引）：明文存储限制、内置防护一览表、环境变量参考表（含「调低限频会影响离线补发」的耦合提示）、Origin 判定规则与反向代理注意点（nginx 默认保留 Host 无需白名单 / 改写 Host 必须配白名单 / Docker 端口映射直连同源）、公网上线检查清单、已知边界
- `ITERATION_PLAN.md` / `CHANGELOG.md`：状态与记录更新（`.gitignore` 含 `/plugins/`，SECURITY.md 按 index.mjs 先例 `git add -f` 纳入）

**改动原因**
P1-2 完成了「未登录不能连」，但浏览器侧仍存在跨站 WebSocket 劫持面：恶意网页可借访问者的浏览器向本端点发起 WS 握手（单用户模式下可匿名旁观/冒名发言，多用户模式下借 cookie 会话）。同时全部运行限额硬编码在源码里，部署方无法按机器规格调整。本迭代补上浏览器来源信任边界（Origin 同源校验 + 代理白名单出口），并把限额开放为环境变量、沉淀部署安全文档。

**测试结果**
- `node --check` 通过；服务端启动正常，日志明示 origin 策略与限额生效值
- **Node 集成测试 33/33 通过**（测试实例 :8001 / `--dataRoot data-test`，原始 socket 升级探针 + ws 客户端）：
  - Origin 矩阵 13/13：无 Origin/同源 http/同源跨 scheme 同端口/无端口 Host 配 80、443 默认 → 101；异主机/同端口异主机/子域仿冒/`null`/畸形/`ftp:` scheme/无端口 Host 配非默认端口/默认端口路径异主机 → 403 ✓
  - 白名单 6/6（`https://good.example.com,myhost`）：精确来源放行、**同主机异端口拒绝**（本测试抓出并修复一个真实 bug：带 scheme 的条目曾被误当裸主机名放行任意端口）、裸主机任意端口放行、裸主机不匹配子域、未列出来源拒绝、无 Origin 放行 ✓
  - 通配符 1/1：`SILLYROOM_ALLOWED_ORIGINS="*"` 任意 Origin 放行 ✓
  - 限额参数化 7/7（`RATE_LIMIT_MAX=3 MAX_MEMBERS=2 MAX_MESSAGE_CHARS=100`）：hello.limits 反映 env、第 3 人进满房被拒、窗口内第 4 条被限频、前 3 条正常广播、超长消息截断至 100 ✓
  - 默认回归 6/6：默认限额值（32 人/2000 字符）、进房/回显/双客户端广播互通（id 一致）✓
- **双浏览器标签页实测**（测试实例 :8001，真实浏览器 WS 握手必带 `Origin: http://localhost:8001`）：
  - 两窗口状态灯均 `ok`（同源放行路径端到端验证）；A 进 p32test 发消息 → B 历史回放可见 + 成员数实时为 2（含「（我）」标记）；B 回复 → A 实时收到 + 「加入了房间」系统行 ✓
  - 两窗口稳态 JS 错误钩子捕获 0 错误；服务端日志无 SillyRoom 拒绝/错误记录；截图确认窗口渲染正常 ✓
- 测试服务器已停止，`data-test/`、临时测试脚本、测试标签页均已清理；`docker/docker-compose.yml` 的工作区改动仍为本机部署配置，未纳入提交

**已知边界（记录为后续迭代项）**
- 无 `Origin` 头的客户端不做来源校验：多用户模式下仍受 P1-2 会话鉴权保护；单用户模式下维持 0.1.0 以来「本机部署假设」的行为（已在 SECURITY.md 明示，公网部署须开多用户模式）
- 白名单匹配忽略 scheme（`host:port` 粒度）：`http://` 与 `https://` 的同主机同端口条目等效——浏览器混合内容规则使跨 scheme 伪造握手不可行，实际风险可忽略
- `SILLYROOM_ALLOWED_ORIGINS` 在模块加载时读取一次，运行中修改需重启进程
- 前端离线补发上限固定 15 条并按默认限频校准；`SILLYROOM_RATE_LIMIT_MAX` 调低后补发可能被限频拒绝（消息保留缓存等待重连窗口，已写入 SECURITY.md）

## [SillyRoom 0.7.0] — 2026-09-07

### 迭代 P2-3：主题与 i18n 打磨

**改动内容**
- `public/scripts/extensions/sillyroom/locales.js`（新增）：扩展自带词典，`en` 与 `zh-tw` 两套，键为代码中的中文源串（SillyTavern i18n 惯例：源串即键，查不到翻译时回退键本身，故简体中文无需词典）；同时覆盖客户端文案与服务端 key/args 消息，共 51 键 × 2 语言
- `public/scripts/extensions/sillyroom/index.js`（前端，全面 i18n 化）：
  - **注册链路**：`init()` 开头调用 `registerLocales()`——按 `getCurrentLocale()` 精确匹配词典（区域变体如 `en-gb` 回退主码 `en`），经 `addLocaleData` 注入当前语言包，先于窗口构建（保证 `data-i18n` 在 DOM 插入时即可翻译）
  - **静态界面**：`buildWindow()` 的全部可见文本、按钮、tooltip（`title`）、占位符（`placeholder`）加 `data-i18n` 属性，由 ST 的 MutationObserver 在插入时自动翻译（扩展加载晚于 `initLocales()`，时序安全）
  - **动态文案**：状态灯文本、房间标签（含「待补发 N 条」「等待重连」后缀）、系统行、typing 提示、离线补发/未读 toastr、昵称 prompt、魔杖菜单项等 36 处 `t` 模板标签；占位符键形如 `房间：${0}` 与词典严格对应
  - **服务端消息本地化**：新增 `systemText()`/`errorText()`——按服务端新附的 `key`（`member_joined`/`member_left`/`member_renamed`、`err_rate_limited` 等 6 种）+ `args` 在客户端重组本地化文案，未知 key 回退服务端原始 `text`/`message`（兼容旧客户端与调试）
- `plugins/sillyroom/index.mjs`（服务端，+约 6 行）：3 类 system 广播与全部 6 处 error 响应附带 `key` + `args`（如 `{key:'err_room_full', args:{room, max}}`），原中文文本字段原样保留——协议向后兼容，历史落盘不受影响（system 消息本就不入历史）
- `public/scripts/extensions/sillyroom/style.css`（主题变量适配）：
  - 状态灯改语义令牌：ok=`--active`、connecting=`--golden`、error=`--warning`；未读角标 `--crimson`（未定义、一直走回退值）修正为 `--warning`
  - 气泡底色改用 ST 聊天气泡同源变量：他人=`--SmartThemeBotMesBlurTintColor`、我方=`--SmartThemeUserMesBlurTintColor`——修复默认主题下 `--SmartThemeChatTintColor` 与窗口底色（`--SmartThemeBlurTintColor`）同为不透明近黑色导致气泡不可辨的问题
  - 成员 chip、房签 hover、AI 徽标改 `color-mix(in srgb, var(--SmartThemeBodyColor) 12%, transparent)`，任意明暗主题下都有保证的对比度；窗口阴影改 `--SmartThemeShadowColor`
- `ITERATION_PLAN.md` / `CHANGELOG.md`：状态与记录更新

**改动原因**
0.6.0 为止的全部 UI 文案是硬编码简体中文，非中文用户无法使用；CSS 中状态灯等颜色是硬编码值（且 unread 角标引用了并不存在的 `--crimson` 变量），气泡底色在部分主题下与窗口同色。本迭代把文案全部接入 ST 原生翻译体系（`data-i18n` + `t`，与官方扩展同一机制），配色全部对齐 ST 主题令牌，使聊天室跟随任意明暗主题与界面语言。

**测试结果**
- `node --check` 通过（扩展 index.js / locales.js / 插件 index.mjs）；服务端启动正常
- **Node 集成测试 20/20 通过**（测试实例 :8001 / `--dataRoot data-test`）：
  - 词典完备性：en/zh-tw 键完全对齐（无单侧缺键）；代码中提取的 **14 个 `data-i18n` 键 + 36 个 `t` 模板键（插值规范化为 `${0}` 形式）在两套词典中全部命中**
  - 协议：join/leave/rename system 消息带 `key`+`args`+原 `text` 三者齐全且值正确；rate-limit/unknown-type/not-in-room 错误带 `key`+原 `message` ✓
  - 回归：聊天广播与发送者回显（id 一致）、历史回放 ✓
- **双浏览器标签页实测**（测试实例 :8001）：
  - 默认中文：窗口全部文案（标题/按钮/开关/tooltip/占位符/成员 chip「（我）」/「已加入房间」）渲染正确
  - `localStorage.language='en'` 刷新后：静态区（data-i18n）与动态区（t）全部切换为英文，魔杖菜单项与 tooltip 同步；**他人加入的系统消息显示为 "Guest-c50d joined the room"（服务端 key/args → 客户端英文重组）** ✓
  - 双窗互通：A 发消息 B 实时收到、B 发 A 收到；成员列表双向同步（2 人 + (me) 标记）；刷新后自动重连重入 ✓
  - 主题适配：默认暗色主题下两种气泡左右对齐、底色可辨；将 ST 主题变量内联覆盖为亮色值后，窗口背景/文字/气泡/边框/阴影全部随变量切换且对比度正常（截图验证）
  - 重载后稳态 JS 错误钩子捕获 0 错误；无 toastr 报错
- 测试服务器已停止（按端口定位 PID 单独终止），`data-test/`、临时测试脚本、测试标签页均已清理；`docker/docker-compose.yml` 的工作区改动仍为本机部署配置，未纳入提交

**已知边界（记录为后续迭代项）**
- 仅内置 en 与 zh-tw 词典；其他语言（ja/ko/de/fr 等 16 种 ST 支持语言）回退显示中文源串——词典结构已就绪，按需补条目即可
- 服务端 `handleJoin` 的兜底昵称 `访客-xxxx` 仍在服务端以中文生成（客户端始终发送昵称，仅在直连 WS 的极简客户端中出现）；房间建议 chip 的 `id (人数)` 为语言中性
- `data-i18n` 翻译发生在窗口构建插入时；窗口构建后动态改写的元素（状态/房间标签等）走 `t` 链路，二者不冲突，但用户在运行中切换语言仍需刷新页面（ST 全站行为一致）
- zh-tw 词典为逐条人工转换，未做大规模校对

## [SillyRoom 0.6.0] — 2026-09-07

### 迭代 P2-2：离线补发与未读

**改动内容**
- `public/scripts/extensions/sillyroom/index.js`（前端主体，+约 150 行）：
  - **离线消息缓存补发（outbox）**：断线期间输入框保持可用（存在待自动重入的房间时），发送的消息进入本地缓存（上限 15 条——与服务端 15 条/5 秒限频精确对齐，重连后一次补发恰好不触发限频），渲染为「⏳ 待发送」半透明行；房间标签显示「（等待重连）· 待补发 N 条」。重连成功回放历史后自动补发；服务端确认回显到达后，⏳ 行被正式消息替换（nonce 配对去重，不产生重复）；补发失败（socket 再次断开）保留缓存等待下次重连；主动离开房间即清空缓存
  - **断线补发分隔线**：断线时记录最后见到的消息 id 与时间戳；重连回放历史时，在「断线期间的新消息」前插入分隔线——优先按最后见过的消息 id 定位，该消息已滚出 50 条回放窗口时回退为「断线时间戳之后的首条」；意外断线重入才显示，手动切换房间不显示
  - **未读角标**：聊天室窗口最小化期间收到他人消息（含 AI 中继）时计数，魔杖菜单「💬 聊天室」入口显示红色角标（99+ 封顶），首条消息触发一次 toastr 提醒（不逐条轰炸）；打开窗口即清零；窗口开启状态下的消息不计入；自己的消息/回显不计入
- `plugins/sillyroom/index.mjs`（服务端，+约 14 行）：`chat` 消息支持可选 `nonce` 回执——客户端补发的消息携带不透明关联令牌，服务端清洗（白名单字符、64 字符截断）后原样随广播回显，用于配对「缓存中的消息 ↔ 服务器确认副本」；无 nonce 的消息行为完全不变（回归验证）；nonce 仅存在于实时链路，落盘历史经 P2-1 清洗后不含该字段
- `public/scripts/extensions/sillyroom/style.css`（+34 行）：⏳ 待发送行（半透明虚线边框）、断线分隔线、未读角标三个样式块，全部基于 ST 主题变量
- `ITERATION_PLAN.md` / `CHANGELOG.md`：状态与记录更新

**改动原因**
P2-1 之前，断线重连虽然能靠历史回放看到错过消息，但有三个体验缺口：① 断线期间用户打好的消息发送即丢失（输入框被禁用），只能等重连后手动重打；② 回放里「哪些是新消息」无从辨认；③ 窗口最小化时消息默默堆积，用户毫无感知。本迭代把这三个缺口全部补上：断线期间消息不丢（缓存补发）、新消息一眼可见（分隔线）、错过消息有提醒（角标）。

**测试结果**
- 服务端语法检查通过，测试实例启动正常（`--port 8001 --dataRoot data-test`）
- **Node 双客户端集成测试 12/12 通过**：
  - T1 nonce 回显：发送者回显与其他成员广播均携带原 nonce，消息内容/昵称不受影响 ✓
  - T2 无 nonce 消息广播不含 nonce 字段（回归）✓
  - T3 非法 nonce 清洗：特殊字符剥离、全非法省略字段、超长截断 64 ✓
  - T4 重连回放含断线期间消息（补发数据通路），且存在位于「最后见过」之后的新消息（分隔线落点）✓
  - T5 15 条补发恰好全部通过限频、第 16 条被拒（验证 MAX_OUTBOX=15 依据）✓
- **双浏览器窗口实测**（测试实例 :8001 / `--dataRoot data-test` / 独立 Node 旁观者客户端）：
  - 未读角标：窗口 A 最小化 → B 连发 2 条 → A 魔杖菜单入口显示红色角标「2」+ 单条 toastr → 截图确认样式 → 重新打开窗口角标清零、消息完整呈现 ✓
  - 离线补发：强杀服务器 → A 断线状态下输入框可用、两条消息进入 ⏳ 缓存（标签「等待重连 · 待补发 2 条」）→ 重启服务器 → 自动重连后补发，旁观者客户端实时收到两条 ✓
  - 断线分隔线（确定性时序）：利用 16s 重连倒计时窗口，让旁观者在服务器就绪后立即注入 3 条补发消息 → A 重连后回放呈现「标记点 → —— 断线期间的新消息 —— → 3 条补发消息」，B 端同样 ✓
  - nonce 去重（实测发现并修复一个 bug 后复验）：A 的缓存消息补发后 ⏳ 行被正式回显替换、无重复（修复前 ⏳ 行残留，详见下）✓
  - 回归：常规 A↔B 实时互发正常；AI 中继、注入聊天开关不受影响；A 控制台零错误零警告；B 仅一条 ST 核心 `console.warn`（`saveChat called without chat_name`，来自 P1-1 注入路径在「无任何聊天打开」的全新实例环境，属既有行为非红色报错）
- 测试服务器已停止，`data-test/`、临时测试脚本（集成测试 + 旁观者）均已清理

**已知边界（记录为后续迭代项）**
- 补发上限 15 条：缓存满后提示等待重连；更长的离线场景由服务端 50 条历史回放兜底（超过部分本就不在回放窗口内）
- 补发消息按原发言时间之外的新时间戳进入房间（服务端以收到时刻记 ts），与「补发」语义一致但不是原始时刻
- 未读角标挂在魔杖菜单入口上，菜单收起时不可见——发现性靠一次性 toastr 提醒；常驻悬浮提醒需要新的 UI 表面，暂不做
- 浏览器标签页完全关闭再打开属于「新会话」，走历史回放而非补发链路（无 onclose 时机记录断点）
- flushOutbox 发送成功但回显丢失（如补发瞬间再次断线）时，消息已入房但本地无确认行——下次重连的历史回放会补见，不再重发（防重复）

## [SillyRoom 0.5.0] — 2026-09-07

### 迭代 P2-1：房间历史持久化

**改动内容**
- `plugins/sillyroom/index.mjs`（唯一代码文件，+约 150 行，核心文件零改动）：
  - **落盘位置**：`<DATA_ROOT>/sillyroom/rooms/<roomId>.json`（默认 `data/sillyroom/rooms/`）。房间是账号无关的共享实体，故历史存共享目录而非每用户目录（与计划草稿 `data/default-user/sillyroom/` 的微小偏差，已在计划中注明）；roomId 命名沿用既有 `^[a-zA-Z0-9_-]{1,32}$` 白名单后直接作文件名，无路径穿越面
  - **写入策略（三层）**：① 每条新消息后 1.5s 防抖合并写入（同一次爆发只写一次磁盘）；② 房间清空移出内存时立即写入（不再依赖防抖到期）；③ 优雅关停时在 exit 钩子同步写全部含消息房间，保住最后一个防抖窗口内的消息。写入为原子替换（tmp 文件 + rename）
  - **加载策略**：加入内存中不存在的房间时同步预载磁盘历史（限最近 50 条，与内存上限一致），复用现有 `joined.history` 回放链路，**前端零改动**
  - **健壮性**：读取时按与实时消息相同的规则清洗每条记录（id/text/from/kind/ts 校验，损坏记录丢弃）；整个文件损坏（非法 JSON）静默降级为空历史，绝不影响加入流程；零消息房间不产生文件
  - 启动日志明示持久化目录
- `ITERATION_PLAN.md` / `CHANGELOG.md`：状态与记录更新

**改动原因**
P0/P1 的房间历史只存内存：服务器重启后聊天记录全部丢失，重启前加入过的成员断线重连后拿不到任何历史。落盘后重启可完整回溯最近 50 条，顺带修复了「房间清空即历史永久消失」的问题。

**测试结果**
- Node 双客户端集成测试 **15/15 通过**（测试实例 :8001 / `--dataRoot data-test` / IPC shim 触发真实 `exitProcess` → 插件 exit 钩子链路）：
  - T1 消息后 1.5s 防抖落盘，顺序、昵称/颜色/时间戳字段、`kind:'ai'` 标记均保留 ✓
  - T2 房间清空立即落盘；新客户端加入同一房间从磁盘回放 3 条 ✓
  - T3 60 条消息（按 15 条/5 秒限频分四批发送）落盘上限 50、最旧 10 条丢弃 ✓
  - T4 SIGKILL 硬杀重启后加入同一房间，回放完整 50 条 ✓
  - T5 优雅关停时防抖未到期的消息被 exit 钩子同步刷新落盘 ✓
  - T6 损坏历史文件（非法 JSON）加入不崩溃、空历史 ✓
  - T7 零消息房间不产生文件 ✓
  - T8 双客户端实时广播回归 ✓
- **双浏览器窗口实测**（测试实例 :8001）：
  - 窗口 A 加入 room1 发消息 → 窗口 B 打开后自动重入 room1（localStorage）并回放该消息；B 回复实时到达 A ✓
  - 磁盘 `room1.json` 内容与界面一致（昵称、颜色、时间戳）✓
  - **服务器硬杀重启** → 两窗口自动重连 + 自动重入 room1，均从磁盘回放重启前两条消息，成员数实时同步为 2；重启后 A 再发消息 B 实时收到，链路完整 ✓
  - 全程无错误状态、无 toastr 报错
- 测试服务器已停止，`data-test/`、临时测试脚本与 IPC shim 均已清理

**已知边界（记录为后续迭代项）**
- 落盘是「最近 50 条」滚动窗口（与内存回放一致），完整归档不是本迭代目标
- Windows 下硬杀（SIGKILL/崩溃）仍会丢最后一个 1.5s 防抖窗口内的消息——属崩溃场景，代价可接受
- 多实例共写同一 DATA_ROOT 会互相覆盖历史文件（与官方单进程假设一致，未做文件锁）
- 历史文件含昵称/颜色，无敏感凭据；官方多用户数据本身明文存储，加密加固统一归入 P3-2



## [SillyRoom 0.4.0] — 2026-09-07

### 迭代 P1-2：与官方多用户账号联动

**改动内容**
- `plugins/sillyroom/index.mjs`（服务端，唯一核心逻辑文件）：
  - **WS 握手会话校验**：`enableUserAccounts: true` 时，插件用与主应用完全相同的 `cookie-session` 中间件（同名 cookie `getCookieSessionName()` + 同密钥 `getCookieSecret(DATA_ROOT)`，均复用 `src/users.js` 导出，零核心文件改动）对 HTTP 升级请求做纯读校验，再镜像 `setUserDataMiddleware` 的检查链：`session.handle` → 账号存在（node-persist `storage.getItem(toKey(handle))`）→ 账号未禁用；任一环节失败即回 `HTTP 403` 并断开，服务端日志记录拒绝原因。校验为 stub 响应对象（`on-headers` 仅包装 `writeHead`、commit 永不触发），附 5 秒安全超时防止存储读取卡死时升级挂起
  - **昵称建议**：`hello` 消息新增 `identity` 字段——`{ authenticated, handle, suggestedName }`；`suggestedName` 优先取该账号默认 Persona 名（`data/<handle>/settings.json` → `power_user.personas[default_persona]`），无默认 Persona 时回退账号显示名（user 记录的 `name`），经 `sanitizeText`（24 字符上限）清洗
  - 单用户模式（`enableUserAccounts: false`）行为完全不变，启动日志明示当前模式（`session authentication enforced` / `no authentication (single-user mode)`）
- `public/scripts/extensions/sillyroom/index.js`（前端）：
  - **昵称自动采用**：`hello.identity.suggestedName` 存为 `serverSuggestedName`；本地未自定义过昵称（localStorage `sillyroom:name` 为空）时显示并使用它，用户手动改过昵称则始终以本地为准；建议名先于自动重入房间生效，join 即带正确身份
  - **登录状态探测**：`connect()` 改为先探测 REST `/status`（与 WS 同受登录保护）再开 WS——403 置 `loginRequired`，状态栏显示「需要登录 SillyTavern 后才能使用聊天室」并停止重连循环（避免会话过期时的无限重连风暴）；每次重连都重新探测，登录恢复（页面刷新）后自动恢复连接
- `ITERATION_PLAN.md` / `CHANGELOG.md`：状态与记录更新

**改动原因**
P0/P1 打通了聊天室功能，但任何人都能连上 WS 端点——在官方多用户模式（`enableUserAccounts: true`）下这是明显的越权入口：未登录的访客可以旁观甚至冒名发言。本迭代让聊天室遵循 SillyTavern 自身的登录边界：会话 cookie 无法伪造（HMAC 签名校验），昵称与账号 Persona 打通后多人房间里的名字即真实身份。

**测试结果**
- 服务端启动无报错，插件日志明示鉴权模式
- **多用户 ON（集成测试 14/14 通过，测试实例 :8001 / `--dataRoot data-test`）**：
  - T1 无 cookie：REST `/status` 403、WS 升级 403 拒绝、无 hello ✓（服务端日志：`rejected WebSocket upgrade (not-logged-in)`）
  - T2 有效会话（经 `/login` 自动登录获取 cookie）：REST 200、WS 通过，`identity` = `{authenticated: true, handle: 'default-user', suggestedName: '测试君'}`（Persona 名解析 ✓）；双人加入房间、聊天广播互通（多用户模式下功能回归）✓
  - T3 防伪造：cookie 名不匹配（签名校验失败）403 ✓；**用真实密钥合法签名但 handle 不存在**的 cookie 403 ✓（校验不止依赖签名，还验证账号存在性）
- **多用户 ON（双浏览器标签页实测）**：昵称自动显示「测试君」（localStorage 无自定义名时采用 Persona 建议）；两标签页自动重入同一房间、成员列表实时同步（含「（我）」标记）、消息双向实时互通、历史回放正常；房间建议 chip、三开关、状态灯渲染正常，无 toastr 错误；无凭证探测返回 403（`loginRequired` 分支触发信号实证）
- **多用户 OFF 回归（5/5 通过）**：无 cookie 直连通过、`identity.authenticated: false`、无 suggestedName 泄漏、加入房间与聊天广播与 0.1.0 行为一致
- 测试服务器已停止，`data-test/`、临时测试脚本、config.yaml 临时改动均已还原清理

**已知边界（记录为后续迭代项）**
- 多用户模式下浏览器始终自动登录（单一无密码账号），「需要登录」提示仅在实际会话过期时出现（如配置了 `sessionTimeout` 的长开标签页）；该分支逻辑已由协议层 403 实证
- 昵称建议只在 localStorage 无自定义昵称时生效；改过昵称的设备永不更新建议（预期行为——本地选择优先）
- `session.version` 校验未镜像（密码重置后旧会话 cookie 在下一次 HTTP 请求即失效，聊天室存在一个极短的宽限窗口）；账号存在性 + 启用状态已校验，安全影响可忽略
- WS 鉴权只保护聊天室端点本身；房间内发言仍以昵称为准，无账号级身份绑定展示（可在 P3-1 房主权限中做「成员已验证」徽标）



## [SillyRoom 0.3.0] — 2026-09-07

### 迭代 P1-3：注入后自动回应（可选开关）

**改动内容**
- `public/scripts/extensions/sillyroom/index.js`（+105 行，唯一代码文件）：
  - **「自动回应」开关**（默认关，`sillyroom:autoRespond` localStorage 持久化）：自动生成会消耗 API 配额且改变对话节奏，故与注入/广播不同，采用显式 opt-in
  - **触发链路**：`injectRoomMessage` 注入成功后调用 `scheduleAutoRespond()`——3 秒空闲防抖（`AUTO_RESPOND_IDLE_MS`）把连续发言合并为一次生成；到期后 `autoRespondNow()` 以 `Generate('normal')` 触发一次正常生成，AI 即时回应房间消息
  - **防请求风暴（四层守卫）**：① 15 秒全局冷却（`AUTO_RESPOND_COOLDOWN_MS`），冷却期内触发只按剩余时间重排定时器，绝不发请求；② `isGenerating()` 生成中不中断，最多重试 2 次（`AUTO_RESPOND_BUSY_RETRIES`）后放弃；③ 发送框有草稿时让位（用户自己发送会触发 AI，且避免 `processCommands` 误执行草稿中的斜杠命令）；④ 群聊 / 未选角色 / 空聊天直接跳过
  - **循环安全**：复用 P1-1 的防循环——`kind:'ai'` 中继消息不注入（不调用 `injectRoomMessage`），因此永远不会触发对方的自动回应；历史回放同样不注入
  - **状态清理**：离开房间或关闭开关即撤销挂起的定时器（`cancelAutoRespond`）
- `ITERATION_PLAN.md` / `CHANGELOG.md`：状态与记录更新

**改动原因**
P1-1 打通了「真人消息 → AI 上下文」，但注入后 AI 不会自动开口，需要用户手动点发送才能得到回应。本迭代实现"AI 真正实时回应"：房内发言注入后自动触发一次生成。计划中给了两种防风暴方案（仅房主/轮值响应 vs 带冷却的全局节流），选择后者——无需引入房主概念、改动范围最小；多成员同时开启时每人各自受 15 秒冷却约束，严格限速场景建议只在一台设备上开启（已在开关 tooltip 注明）。

**测试结果**（双浏览器标签页实测，测试实例 :8001 / `--dataRoot data-test` / 本地 mock OpenAI 兼容端点 :8085 带请求计数）
- 服务器启动无报错：`SillyRoom: WebSocket endpoint ready`
- **T1 基础链路 ✓**：A 在房间发言 → B 聊天注入 `is_user:true, name:用户A` 消息 → 3 秒防抖后自动生成 → mock 返回引用该消息的回复 → B 的回复以 `kind:'ai'` 中继到房间，A 端带 AI 徽标可见
- **T2 爆发合并 ✓**：A 连发 3 条消息（间隔 0.5s）→ 仅 1 次生成请求（3 条全部进入同一上下文），mock 计数 +1
- **T3 冷却节流 ✓**：在上次生成开始后 ~1 秒内再发消息 → 3 秒防抖到期后不发请求，被重排至冷却结束（实测第 15.8 秒）才生成，期间 mock 计数无变化
- **T4 开关关闭 ✓**：B 关闭「自动回应」→ A 发言零请求；开关状态持久化
- **T5 注入联动 ✓**：B 开自动回应但关「注入聊天」→ 消息不注入、不触发生成（依赖关系自然成立）
- **守卫验证 ✓**：B 未选角色时注入正常但自动回应静默跳过（mock 计数不变）
- UI 渲染 ✓：三开关排布正常、AI 徽标中继消息带虚线边框、无 toastr 错误、双主题变量样式无异常；SillyTavern 原有单聊生成链路（Seraphina + mock API）工作正常
- 测试服务器与 mock 进程已停止，`data-test/` 已清理

**已知边界（记录为后续迭代项）**
- 多成员同时开启「自动回应」时，每个成员的 AI 都会各自回应一次（各自受冷却约束）；需要"唯一发言人"体验可考虑后续 P3-1 的房主权限来做轮值守门
- 冷却从生成**开始**时刻起算；若生成耗时长于冷却期，紧随其后的消息可能在生成结束后立即触发下一次生成（符合预期但值得知晓）
- 同一浏览器多标签页共享 localStorage 昵称与开关种子值（成员身份靠每连接 clientId 区分，与 P0-2 已知限制一致）



## [SillyRoom 0.2.0] — 2026-09-07

### 迭代 P1-1：真人消息进入 ST 聊天流

**改动内容**
- `plugins/sillyroom/index.mjs`（+6 行）：`handleChat` 支持可选 `kind: 'ai'` 字段——成员可把本地 AI 的回复以 `kind:'ai'` 中继广播；非 `ai` 的 kind 值一律丢弃（防伪造），消息照常入历史与限频
- `public/scripts/extensions/sillyroom/index.js`（+95 行）：
  - **注入**：新开关注入聊天（默认开，localStorage 持久化）。开启时，房间内**其他成员**的实时发言经 `sendMessageAsUser(text, null, null, true, senderName)` 写入当前 ST 聊天（用户侧消息、紧凑布局）；昵称写入 `mes.name`，文本补全（`formatMessageHistoryItem`）与 chat completion（`openai.js` 的 `name` 字段）都会把「昵称:」带入 prompt，AI 可区分说话人。多条并发注入经 Promise 队列串行化，避免并发存盘竞争
  - **AI 广播**：新增「AI 回复广播」开关（默认开）。监听 `MESSAGE_RECEIVED`，仅 `type === 'normal'`（普通生成）时把本地 AI 回复截断至 2000 字符广播到房间；swipe/continue/impersonate/quiet 一律不广播。`kind:'ai'` 消息只进房间窗口（带 🤖 AI 徽标样式），**绝不回注**到任何人的 ST 聊天（防循环）
  - 历史回放（加入房间时）不注入，只进房间窗口
- `public/scripts/extensions/sillyroom/style.css`（+30 行）：开关行与 AI 徽标样式，全部基于 ST 主题 CSS 变量

**改动原因**
P0 完成了「真人互聊」但聊天室与 SillyTavern 本体是两个孤立世界。本迭代打通双向链路：真人发言成为 AI 上下文（AI 能看到谁说了什么），本地 AI 回复中继到房间（其他成员能看到你的 AI 怎么回）。注入复用 `sendMessageAsUser` 而非自拼消息对象，完整保留正则脚本、时间戳、token 计数、存盘与事件链路。

**测试结果**
- 服务端 Node 双客户端集成测试 6/6 通过：普通消息不带 kind（回归）、`kind:'ai'` 广播与发送者回显、非法 kind 值被清洗、迟到者历史回放含两类消息、AI 中继共享限频
- 双浏览器窗口实测（Chromium，测试实例 :8001 / `--dataRoot data-test`）：
  - 窗口 A 房间发言 → 窗口 B 的 ST 主聊天新增 `is_user:true`、`name=<A 昵称>` 的用户消息，文本一致（注入 ✓）
  - B 端以 `swipe` / `normal` 两种 type 触发 `MESSAGE_RECEIVED`：仅 `normal` 广播到房间，A 端房间窗口出现带 AI 徽标的消息；`swipe` 不广播 ✓
  - 循环防护：AI 中继消息在任何窗口的 ST 聊天中注入数为 0（接收方与发送方回显均不注入）✓
  - 关闭 B 端「注入聊天」→ A 的发言只进房间窗口，B 聊天长度不变；开关状态 localStorage 持久化，刷新后保持 ✓
  - 服务器日志无报错；测试服务器与测试数据目录已清理
- 已知边界（记录为后续迭代项）：注入不会自动触发 AI 生成（用户手动点发送后 AI 才回应）；同浏览器多窗口共享昵称（localStorage 同源）

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
