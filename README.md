# dsh-prompt-prefill

DeepSeek Harness 桌面端插件：**Agent 回答结束后，在输入框里以灰色文字预填充一条提示词，按 `Tab` 或 `→` 即可把它写进草稿。**

提示词不是写死的模板，而是根据**当前会话的最近对话**动态生成的一条「你接下来最可能想发」的消息。

实现评估、修复范围和仍需真机验证的限制见 [IMPLEMENTATION_REVIEW.md](./IMPLEMENTATION_REVIEW.md)。

---

## 效果

```
┌─ 输入框（草稿为空） ─────────────────────────────────────┐
│ 请把时间复杂度降到 O(n log n)，并补一组边界测试          │  ← 浅灰色，不是草稿
└──────────────────────────────────────────────────────────┘
                          ↑ 按 → 之后
┌─ 输入框（已写入草稿） ───────────────────────────────────┐
│ 请把时间复杂度降到 O(n log n)，并补一组边界测试|         │  ← 正常文字，可编辑
└──────────────────────────────────────────────────────────┘
```

| 场景 | 行为 |
| --- | --- |
| Agent 回答结束、草稿为空 | 自动请求一次，并在输入框内显示灰色提示词 |
| 只打开或翻看会话 | **不请求**（与 Claude Code 一致，避免白白调用模型） |
| 回答结束时草稿不为空 | 先不请求，草稿清空后补一次 |
| 草稿为空且输入框聚焦时按 `Tab` 或 `→` | 提示词经宿主 `setDraft` 写入草稿，**不发送**；撤销行为取决于编辑器实现 |
| 输入框里已有任何文字 | 灰色提示词立即隐藏，`Tab` / `→` 交还给原生行为 |
| 按 `Escape` | 关闭灰色提示词 |
| 带 `Shift/⌘/Ctrl/Alt` 的 `→` / `Tab` | 不拦截，保留选区操作与 `Shift+Tab` 反向切换焦点 |
| 输入法组合输入中（`isComposing`） | 不拦截 |
| Agent 正在回答 | 不请求、不显示 |
| 输入处于 `submitting` / `adjudicating` | 不生成、不显示、不采纳已有候选 |
| 上一轮出错或被中断 | 不请求模型、不显示 |
| 模型不可用 / 超时 / 新会话无历史 | 默认不显示；打开 `useFallback` 才显示兜底提示词 |
| 同一轮生成失败 | 不重试，等下一轮回答结束 |

**不会自动发送消息，不调用工具，不绕过任何权限审批。**

---

## 文件结构

```
dsh-prompt-prefill/
├── package.json          插件清单：入口、exports、dsh 字段（bundle patch 与 client 平台）
├── cordis.patch.yml      profile 补丁：插件行与全部可配置项（含中文注释）
├── LICENSE               MIT
├── README.md             本文件
├── lib/
│   ├── core.js           宿主半共享的纯逻辑（配置归一化、脱敏、上下文提取、候选清洗、兜底轮换）
│   ├── index.js          宿主半：注册 RPC 路由、读会话历史、调用 ctx.llm 生成提示词
│   └── client.js         浏览器半：幽灵文本浮层、按 → 采纳、显隐时机、样式注入
└── test/
    ├── core.test.mjs     纯逻辑单测：脱敏、上下文截断、候选清洗
    ├── host.test.mjs     宿主半单测：路由校验、模型调用、超时与降级路径
    └── client.test.mjs   浏览器半单测：模拟 DOM/hooks、取消和组件生命周期
```

### 各文件职责

| 文件 | 用途 |
| --- | --- |
| `lib/core.js` | 与 Harness 无关的纯函数。独立出来是为了让最易出错的边界（脱敏、截断、`NONE` 处理、兜底轮换）能被直接测到。 |
| `lib/index.js` | 宿主半。暴露 `name` / `apply`，经 `ctx.get('webServer')` 注册 `/dsh-prompt-prefill/rpc`；首选会话的 `deriveMessages()` 取最近对话，兼容 `snapshotEvents()`；用 `ctx.get('llm').stream(...)` 生成候选。 |
| `lib/client.js` | 浏览器半。经 `window.__ModuleLoader__.load` 注册，用 `ctx.slots.inject('conversation.input.overlay', ...)` 把浮层挂进 composer 卡片内部。 |
| `test/client.test.mjs` | 自带微型 React（真的执行 hooks）与微型 DOM，因此能断言「按 → 确实调用了 `inputActions.setDraft`」。 |

---

## 关键实现点

### 1. 为什么是自己画浮层，而不是用原生内联建议

本版 Harness（`0.2.0-rc.2`）**没有**可用的内联 ghost text / suggestion API。我在发行版 `D:\DeepSeek Harness\resources\app.asar` 中检索过 `ghostText`、`inlineSuggestion`、`setSuggestion`、`acceptSuggestion`、`ghost-text` 等关键字，均无命中（唯一命中的 `variant: "ghost"` 是 Button 的样式变体，与输入建议无关）。

参考项目 [dsh-prompt-for-me](https://github.com/ChuanTianML/prompt-for-me) 的 README 也印证了这一点：

> 新版 Harness 使用输入框内联 ghost text；较旧客户端使用一张不修改草稿的轻量预览卡片。

所以本插件走的是后者思路，但把预览做得**与输入框逐像素对齐**，视觉上等价于内联幽灵文本。

### 2. 幽灵文本如何做到像素对齐

浮层只在**草稿为空**时出现，此时插入点必然在内容区左上角。于是只需：

1. 用 `[data-composer-card]` → `querySelector('[data-composer-input]')` 找到同卡片内的输入容器；
2. 把该输入容器计算样式里影响排版的属性（字体、行高、内边距、边框宽度、`box-sizing` 等）逐一复制到浮层；
3. 用 `getBoundingClientRect()` 以 `position: fixed` 定位、同宽同高。

用 `position: fixed` 而不是 `absolute` 是刻意的：输入框位于一个 `overflow-y: auto` 的滚动容器内，若用 `absolute`，浮层会随容器一起滚动、并可能被裁剪；`fixed` + 每次 `getBoundingClientRect()` 重新对齐则天然避开这两点。

并监听 `resize` 与 `scroll`（捕获阶段，覆盖任意滚动容器），以及 `ResizeObserver`，保证布局变化后重新对齐。

浮层由槽位机制渲染进 composer 卡片内的 `.overlayAnchor`（`height: 0; position: absolute; inset: 0 0 auto`），而输入框本身在一个 `overflow-y: auto` 的滚动容器里。这就是必须用 `fixed` + 实时测量、而不能用纯 CSS 贴合的根因。

**同时要抑制 Harness 自带的输入提示**：草稿为空时，Harness 自己会在同一位置渲染 `<div data-composer-placeholder>` 以及一段 `p:last-child:after { content: var(--dsh-composer-hint) }`。若不处理，两者会**叠字**。做法是幽灵文本可见时给输入框加 `data-dsh-prompt-prefill="on"`，由样式表隐藏这两处提示；收起时立即摘掉该属性，把原生提示还给用户。

### 3. 右方向键的采纳逻辑与冲突处理

这是需求里最需要小心的一点。`→` 在文本框里**原生就有意义**（光标右移 / 取消选区），所以插件只在**完全不可能有冲突**时才拦截：

```js
if (event.key !== 'ArrowRight') return
if (event.defaultPrevented || event.isComposing || event.repeat) return
if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return  // 带修饰键 → 是别的操作
const input = findComposerInput(anchorRef.current)
if (input === null) return
const focused = document.activeElement
if (focused !== input && !input.contains(focused)) return      // 必须聚焦在这个输入框（含子节点）
if (!domIsEmpty(input) || draft !== '') return                 // 必须完全为空
if (running || removed || inputLocked(inputSnapshot)) return // 会话和输入必须可编辑
event.preventDefault(); event.stopPropagation()
actions.setDraft(candidate)
```

> **⚠️ 一个真实存在的坑（本插件已处理）**：DSH 的 composer 输入框**不是 `<textarea>`**，而是 Lexical 驱动的 `contentEditable` 容器：
>
> ```html
> <div data-composer-input contenteditable="true" role="textbox" aria-multiline="true">…</div>
> ```
>
> 它的 `.value` 恒为 `undefined`，文本在 `.textContent` 里。如果按 textarea 的习惯写 `if (input.value !== '' ) return`，就会得到 `undefined !== ''` → **永远判定为「非空」→ 右方向键永远不生效**。同理，Lexical 常常把焦点放在输入容器的**子节点**上，只用 `document.activeElement === input` 判断聚焦也会漏判。
>
> 因此代码里用 `domTextOf()`（`<textarea>` 读 `.value`，contentEditable 读 `.textContent`）判空，并用 `input.contains(focused)` 兜住子节点焦点。`test/client.test.mjs` 专门有「contentEditable 输入框（真实 DSH 形态）」一节做回归覆盖。

**冲突点与处理建议**（对应需求里的「边界情况」）：

- **有文字时的 `→`**：光标移动是用户高频操作，抢占它会让输入变得不可预测。本插件选择**完全不拦截**——只有在输入框为空时 `→` 才无原生意义，此时拦截零冲突。
- **`Shift+→` 选字**：同样不拦截。需要「有文字时也能一键追加提示词」的话，建议改用 `Tab`，而不是扩宽 `→` 的拦截范围。
- **捕获阶段 vs 冒泡阶段**：监听器挂在 `window` 的**捕获阶段**（第三个参数 `true`），确保先于输入框的默认行为执行，从而能可靠地 `preventDefault()`。
- **DSH 自身的输入触发器**：`ctx.inputTriggers`（`/`、`@` 菜单）走的是自己的仲裁链，不会在空输入框上占用 `→`，因此不构成冲突。

### 3.1 只使用槽位**文档化**的标准 props

`conversation.input.overlay` 通过 `Slots.listSubTree` 公布的标准属性是：

```
useInput: SnapshotSelectorHook<InputState>
inputActions: InputActions
useSession: SessionSnapshotSelector
sessionId: SessionId
```

两个容易写错的地方，本插件都已规避：

| 陷阱 | 事实 | 本插件的做法 |
| --- | --- | --- |
| 以为有裸的 `props.session` | 标准属性里只有 **`useSession` 选择器**与 `sessionId`，没有裸对象 | 用 `props.useSession((s) => s)` 取会话快照；同时兼容测试/旧版的 `props.session` |
| 以为会话快照有 `turnEnds` | `SessionSnapshot` 字段为 `sessionId / running / removed / blank / awaitingFirstTurn / …`，**没有 `turnEnds`** | 不依赖轮次序号；用 `running` 的跳变（`true → false`）判定「一轮结束」并重置尝试标记 |

`InputState` 提供 `draft`（草稿文本）与 `phase`（`idle` / `adjudicating` / `submitting`）；`submitting` 与 `adjudicating` 期间不生成、不展示。

### 3.2 宿主半：**不要读 `session.events`**（这是一个真实踩过的坑）

本插件第一版读的是 `session.events`。**DSH 的 `Session` 类根本没有 `events` 属性** —— 官方声明只有：

```ts
eventAt(seq)                          // @deprecated
snapshotEvents(fromSeq?, toSeqExclusive?)  // @deprecated
ownEvents()                           // @deprecated
deriveMessages(): Message[]           // ← 未废弃，且已应用消息投影
```

后果是**静默失效**：`session.events` → `undefined` → 历史恒为空 → 每次都走兜底提示词，
`llm.stream` **永不执行**。插件不报错、幽灵文本照常显示，所以「看起来能用，其实永远是那几句固定话术」。

更糟的是测试把它掩盖了：当时的 fake 返回 `{ events }`，于是测试全绿而线上功能为零。
**测试通过 ≠ API 正确**——fake 必须复刻真实形状。

现在的做法：

- 首选 `session.deriveMessages()`。它是唯一未被标记 `@deprecated` 的历史读取器
  （官方 Agent Note *2026-09-09-deprecate-synchronous-session-event-reads* 明确
  「new production calls are prohibited」），且从 surface 派生、已应用 compaction/fork 投影，
  语义上正是我们要的「模型实际看到的对话」。
- 退路：若某版本只提供 `snapshotEvents()`，仍可工作（`extractRecentTurns` 同时接受
  `Message` 与 `SessionEvent` 两种形状）。
- `host.test.mjs` 的 fake 现在**只暴露 `deriveMessages()`，刻意不提供 `events`**，
  任何「再回去读 `session.events`」的回归都会立刻被测出来（已用变异测试确认：
  把实现改回去会触发 8 项失败）。

### 4. 提示词从哪来（配置方式）

三级优先：

1. **显式配置**：`cordis.patch.yml` 里同时填 `provider` 与 `model`；
2. **当前会话已选模型**：`session.requestHeader()?.config`；
3. **Harness 默认模型**：`ctx.get('agentDefaultModel').currentSelection()`。

默认（两者留空）复用的就是你在 DSH 里已经配好的模型和 API Key —— **插件自己不需要任何凭据，浏览器也拿不到 Key**（生成发生在宿主半）。

发给模型的上下文只包含：当前草稿（通常为空）+ 最近 `maxRecentTurns` **条**真人/助手消息文本。该配置沿用旧名称，按消息数量计数，不按完整问答对计数。长的新消息会截断保留，不会被短的旧消息替换。

送出前做模式脱敏，覆盖 `sk-…`、JSON/YAML/环境变量中的 `api_key`、`token`、`password`、`secret`，以及 `Bearer …`。模式脱敏不保证识别任意格式的敏感信息。

出站请求用 `RequestUserInput` 形状（`{ role:'user', content:[…] }`，不带 `id`、不带 `source`）。
早先写的是 `source: { kind:'plugin' }`，但 `MessageSourceMap` 里**没有 `plugin` 这个 kind**
（那是已废弃的 V3 遗留形状，只在读取旧日志时被迁移），类型上不合格。

### 4.1 RPC 端点的信任边界

`/dsh-prompt-prefill/rpc` 接受本机的请求，校验包括：

1. 实际 TCP 对端必须是回环地址，避免远端调用者伪造 `Host`；
2. `Host` 必须是**回环地址**（`127.0.0.0/8`、`localhost`、`::1`）；
3. 附带的 `Origin` 必须与实际 HTTP/HTTPS 连接协议及 Host **精确同源**（含端口）；
4. `Sec-Fetch-Site: cross-site` 一律拒绝。

之所以在「无 Origin」时放行：桌面端 Electron 会把 `dsh-app://app/…` 的请求转发到回环 webServer，
并在转发前**删掉** `origin` / `host` / `sec-fetch-site`（见 `forwardWebRequest`），
所以端点通常看不到 Origin。测试覆盖的是这一请求头和回环连接的模拟形态；真实 Electron 转发仍需在 Harness 内验证。本机反向代理的上游连接也属于本机请求，本插件未实现用户级鉴权。

### 5. 空提示词 / 未配置时的表现

与 Claude Code 一致，默认**宁可不显示，也不给一句千篇一律的泛泛建议**。下表「失败」一列指默认（`useFallback: false`）的表现；打开 `useFallback` 后这些情况改为显示兜底提示词：

| 情况 | 表现 |
| --- | --- |
| `enabled: false` | 不调用模型、不显示；客户端每轮回答结束最多仍会发一次 RPC，取得关闭态 |
| 上一轮出错或被中断（最后一条不是助手消息，或 `turn/end` 不是 `completed`） | 返回 `SKIPPED`，**不调用模型、也不用兜底句** |
| 新会话还没有任何对话 | 不显示，**不浪费一次模型调用** |
| 模型返回 `NONE` 或空 | 不显示 |
| 模型不可用 / 没有模型路由 | 不显示 |
| 超时（默认 20s） | 不显示 |
| RPC 请求失败 / 网络异常 | 界面保持无候选，不影响草稿编辑 |

打开 `useFallback` 时，兜底提示词按游标**轮换**（而不是随机）；`fallbackPrompts` 为空数组时回退到内置三条默认值。

---

## 安装与启用

> 目标 profile 是桌面端：`desktop`。插件源码位于 `E:\SynologyDrive\AIWorkplace\dsh-prompt-prefill`。

### 方式一：本地目录安装（推荐，便于随时改）

```powershell
dsh plugin --profile desktop add "E:\SynologyDrive\AIWorkplace\dsh-prompt-prefill"
```

### 方式二：手工放入 profile 的 local-plugins

把整个 `dsh-prompt-prefill` 目录复制到：

```
C:\Users\<你>\.dsh\profiles\desktop\local-plugins\dsh-prompt-prefill
```

（该目录下已有一个同结构的 `dsh-optimize` 可作参照。）

### 方式三：从 Git 安装

```powershell
dsh plugin --profile desktop add github:<你的账号>/dsh-prompt-prefill
```

### 启用与生效

1. 确认插件已在 profile 中启用（`cordis.patch.yml` 会插入 `prompt-prefill` 这一行）：

   ```powershell
   dsh plugin --profile desktop list
   ```

2. **重启桌面端**（`dsh plugin add` 之后需要重启才加载新的宿主半）。
3. 打开任意一个**已有若干轮对话**的会话：输入框为空时会先短暂无内容，随后出现灰色提示词。
4. 想看宿主半日志，搜索 `dsh-prompt-prefill:` 前缀。

### 排查：输入框里完全没有灰字

1. 按 `Ctrl+Shift+I` 打开开发者工具，切到 **Console**，搜索 `dsh-prompt-prefill`：
   - 看到「RPC 路由不存在（404）」：宿主半没注册上，确认插件已启用并**完全退出后重启**桌面端；
   - 看到其他「没有拿到提示词：…」：按提示的原因处理；
   - 什么都没有：浏览器半没有加载，检查 `dsh plugin --profile desktop list` 里插件是否启用。
2. 宿主半日志搜索 `dsh-prompt-prefill:`，正常应有一条「已注册 /dsh-prompt-prefill/rpc」。

> 0.1.1 修复：旧版宿主半在 `apply` 时直接 `ctx.get('webServer')`，若该服务尚未就绪就放弃注册，
> 导致浏览器半请求一律 404、界面上完全没有灰字。现改为 `ctx.inject(['webServer'], …)` 等服务就绪后再注册。
> 同时：若 Harness 提供原生内联建议（`inputActions.offerSuggestion`），优先交给原生显示与采纳（Tab / →），
> 不再自绘浮层；没有时才退回自绘浮层。

### 卸载

```powershell
dsh plugin --profile desktop remove dsh-prompt-prefill
```

---

## 配置项

全部写在 `cordis.patch.yml`（profile patch 层同样可覆盖）：

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关。 |
| `maxOutputTokens` | `512` | 单次生成的最大输出 token 数。 |
| `timeoutMs` | `20000` | 超时（毫秒）。 |
| `maxRecentTurns` | `3` | 最近消息条数；沿用旧名称，用户和助手各计一条。 |
| `maxContextChars` | `4000` | 最近对话文本总字符预算。 |
| `maxCandidateChars` | `1200` | 单条提示词字符上限，超出截断。 |
| `provider` / `model` | `''` | 同时填写才生效；留空表示跟随会话/默认模型。 |
| `useFallback` | `false` | 生成失败时是否显示兜底提示词。默认关闭，失败就不显示。 |
| `fallbackPrompts` | 三条中文默认 | `useFallback` 打开时使用的兜底提示词，按游标轮换。 |

---

## 验证方法

### 自动化测试

```powershell
cd E:\SynologyDrive\AIWorkplace\dsh-prompt-prefill
npm test
```

三个套件的断言覆盖正常功能及回归边界，其中包括：

- `→` 触发 `inputActions.setDraft`，且写入内容正是候选提示词（`client.test.mjs`「按 → 采纳（核心验收项）」）；
- 在**真实的 contentEditable 输入框形态**下 `→` 同样生效，且焦点落在输入框子节点时也能识别（`client.test.mjs`「contentEditable 输入框（真实 DSH 形态）」）；
- 通过**槽位真实标准 prop（`useInput`/`useSession`）**的路径同样生效（`client.test.mjs`「槽位标准 props（useInput / useSession，生产路径）」）；
- 输入框有文字 / 未聚焦 / 带修饰键 / 输入法组合中，**均不拦截** `→`；
- 草稿非空或会话运行中**不发请求**；
- **通过 `deriveMessages()` 拿到历史并真正调用模型**，而不是静默降级成兜底
  （`host.test.mjs`「通过 deriveMessages() 能拿到历史并真正调用模型」）；
- 只在**回答结束时**生成：只打开会话不请求、同一轮失败不重试（`client.test.mjs`「只在回答结束时生成」）；
- `Tab` 与 `→` 都能采纳，`Shift+Tab` 和未聚焦时的 `Tab` 不拦截（`client.test.mjs`「按 Tab 采纳」）；
- 上一轮出错时跳过且不调用模型（`host.test.mjs`「上一轮没有正常结束时跳过」）；
- 默认不用兜底句；打开 `useFallback` 时，模型抛错、输出 `NONE`、无模型路由、无历史**全部降级为兜底**。
- JSON 凭据脱敏、长的新消息保留、取消后迟到响应不回写、锁定时不采纳；
- effect 重放、同会话多个实例共享更新、ref 摘除后的 placeholder 清理；
- 适配器不响应取消时 RPC 仍能超时返回、取消后不采纳半截文本、远端不能伪造回环 Host。

浏览器套件模拟 hooks 和 DOM，不代替真实 React/Harness 集成测试。

### 手工验证清单

1. 打开一个已有对话的会话：**不应**出现提示词（只打开不生成）。
2. 发一条消息，等 Agent 回答完：输入框内出现**浅灰色**提示词，且发送按钮**仍不可用**。
3. 按 `Tab` 或 `→`：文字变为正常颜色并成为草稿，发送按钮可用；**不应自动发送**。
4. 再清空草稿：提示词应重新出现（无需重新请求模型）。
5. 输入任意字符：提示词立即消失；此时按 `→` 光标正常右移。
6. 按 `Escape`：提示词消失。
7. 切换会话：不应看到上一个会话的提示词残留。
8. 在 Agent 回答过程中：不应出现提示词。
9. 让一轮回答出错或中途停止：不应出现提示词。

---

## 已知限制

- **浮层定位是像素级对齐，不是真正的内联文本**。若未来 Harness 提供内联建议 API，建议改为调用它（参考项目已在新版客户端这么做）。
- 输入框**内部**滚动时浮层跟随依赖 `scroll`（捕获）事件重对齐；候选通常不超过一行，且 `maxCandidateChars` 会截断过长内容，因此实际影响可忽略。
- 只在本插件**亲眼看到**回答结束（running: true → false）时生成；回答进行中切走会话、回答结束后再切回来，这一轮不会出现提示词。
- 生成发生在宿主半，需要当前会话存在可用对话文本。
- 浮层按空输入框高度裁剪长候选，按 `→` 会写入完整候选；真机上需检查预览可读性，并按需调小 `maxCandidateChars`。
- 幽灵文本使用 `aria-hidden`，目前没有单独的读屏提示。
- 未提供设置界面（GUI 开关）。全部配置经 `cordis.patch.yml` 完成；如果你希望增加「设置 → 插件」里的开关与提示词编辑卡片，可以在此基础上按 `settings.plugin.item` 槽位扩展。

---

## 与参考项目的关系

[ChuanTianML/prompt-for-me](https://github.com/ChuanTianML/prompt-for-me)（`dsh-prompt-for-me`，Prompt for Me / Prompt 嘴替）本身就是一个 DSH 插件，它会在 Agent 回答结束后用模型准备「下一句」，并支持 Tab / `→` 采纳。

本插件借鉴了它的这些做法：

- 客户端 `window.__ModuleLoader__.load({id, factory})` 的包装形态；
- 宿主半用 `ctx.get('webServer').register(...)` 注册同源 POST 的 RPC 路由；
- 用 `ctx.get('sessions').get(id)` 读会话、`ctx.get('llm').stream(...)` 调模型、`ctx.get('agentDefaultModel')` 兜底路由；
- 「草稿之外的建议不算草稿」「`→` 采纳、`Enter` 绝不采纳」的交互语义；
- 失败一律降级、绝不破坏输入区的防御式写法。

差异：它按**轮次完成事件**驱动并支持跨会话偏好记忆与手动快捷键；本插件按**输入框为空**驱动，只做「一条来自当前会话场景的预填充」，实现面更窄、更易审计。

---

## License

MIT
