# dsh-prompt-prefill

DeepSeek Harness（DSH）桌面端插件，给输入框加两个小功能：

- **→ / Tab：采纳建议的下一句。** Agent 回答完后，输入框里出现一条浅灰色的提示词——根据当前会话最近的对话，猜你接下来最可能想说的话。按 `Tab` 或 `→` 把它填进草稿。
- **↑：填入上一次发送的内容。** 输入框为空时按 `↑`，填入这个会话里你上一次发出的消息，改一改再发。

两者都**只填进输入框，不会自动发送**，也不调用工具、不绕过任何权限审批。

```
┌─ 输入框（草稿为空） ─────────────────────────────────────┐
│ 请把方案拆成三步，并标出每步的负责人                    │  ← 浅灰色，还不是草稿
└──────────────────────────────────────────────────────────┘
                          ↓ 按 Tab 或 → 之后
┌─ 输入框（已写入草稿） ───────────────────────────────────┐
│ 请把方案拆成三步，并标出每步的负责人|                   │  ← 正常文字，可以编辑
└──────────────────────────────────────────────────────────┘
```

适用版本：DSH 桌面端 **0.2.0-rc.2**（在这个版本上实测通过）。

---

## 安装与更新

### 安装

推荐从本地目录安装，改代码后不用重新安装（DSH 链接到这个目录，直接运行这里的代码）：

```powershell
dsh plugin --profile desktop add "E:\SynologyDrive\AIWorkplace\dsh-prompt-prefill"
```

也可以从 GitHub 安装。仓库是私有的，需要这台电脑的 Git 已登录 GitHub：

```powershell
dsh plugin --profile desktop add github:Tleon-H/dsh-prompt-prefill
```

装完后**完全退出 DSH（包括托盘图标）再重新打开**。

> 安装前先完全退出 DSH：桌面端开着时，安装命令要排队等它释放 profile 的文件锁，最多等 2 分钟。

### 更新

- **本地目录安装**：代码改完后，**等 Synology Drive 同步完成，再完全退出并重开 DSH**。顺序不能反——先重启、后同步，DSH 跑的仍是旧代码。可以用[诊断](#诊断记录)结果里的 `version` 确认新代码是否生效。
- **GitHub 安装**：先 `dsh plugin --profile desktop remove dsh-prompt-prefill`，再重新 `add`。

### 卸载

```powershell
dsh plugin --profile desktop remove dsh-prompt-prefill
```

---

## 用法

### → / Tab：建议的下一句

| 情况 | 插件的反应 |
| --- | --- |
| Agent 回答结束、输入框为空 | 请求一次，几秒内出现灰色提示词 |
| 只是打开或翻看会话 | **不请求**，不花钱 |
| 回答结束时你已经在打字 | 先不请求，清空输入框后补一次 |
| 输入框为空且有焦点时按 `Tab` 或 `→` | 把提示词填进草稿，不发送 |
| 开始打字 | 灰字立即隐藏，`Tab` / `→` 恢复原本的作用；删空后灰字重新出现，不再请求模型 |
| 按 `Escape` | 关闭这一轮的灰字 |
| 切到别的会话再切回来 | 之前的灰字还在，不重新请求 |
| Agent 正在回答 | 不显示 |
| 上一轮出错、被中止或输出达到上限 | 跳过，不调用模型 |
| 模型回答不出合适的建议（返回 `NONE`）、超时或出错 | 默认什么都不显示（可打开 `useFallback` 改为显示兜底句） |

同一回合只生成一次，失败了也不重试，等下一轮回答结束。

### ↑：上一次发送的内容

| 情况 | 插件的反应 |
| --- | --- |
| 输入框为空且有焦点时按 `↑` | 填入这个会话里你上一次发的消息，不发送；Agent 回答中也能用 |
| 输入框里有字时按 `↑` | 不拦截，光标照常上移 |
| 会话还没发过消息 | 什么都不做 |

只恢复文字，图片附件不恢复。不调用模型。

### 这些情况不会抢你的按键

带 `Shift` / `Ctrl` / `Alt` / `⌘` 的组合键、输入法正在组字、长按重复、输入框没有焦点、DSH 正在提交或处理斜杠命令（输入状态为 `submitting` / `adjudicating` / `claimed`）时，插件都不拦截按键。DSH 自己只在 `/`、`@` 菜单弹出时使用方向键，而那时输入框里必然有字，不会和插件冲突。

---

## 配置

写在 [cordis.patch.yml](cordis.patch.yml) 里（profile 的补丁层同样可以覆盖）：

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关。关闭后 → 和 ↑ 都不生效。 |
| `provider` / `model` | `''` | 生成提示词固定用的模型，**两项都填才生效**；留空则跟随当前会话。 |
| `maxOutputTokens` | `512` | 单次生成的最大输出 token 数。 |
| `timeoutMs` | `20000` | 单次生成的超时（毫秒）。 |
| `maxRecentTurns` | `3` | 发给模型的最近消息条数（你和助手各算一条）。 |
| `maxContextChars` | `4000` | 发给模型的对话文字总字数上限。 |
| `maxCandidateChars` | `1200` | 单条提示词的字数上限，超出截断。 |
| `useFallback` | `false` | 生成失败时是否改为显示兜底句。默认关闭：宁可不显示，也不给千篇一律的话。 |
| `fallbackPrompts` | 三条中文 | `useFallback` 打开时轮换使用的兜底句。 |

### 用哪个模型生成提示词

默认依次尝试：

1. 配置里填的 `provider` + `model`；
2. 这个会话最近一次实际使用的模型；
3. DSH 的默认模型。

复用的是你在 DSH 里配置好的模型和密钥，插件自己不需要任何凭据，浏览器也接触不到密钥。

调用时会请求「关闭思考」（`reasoningEffort: 'off'`），让提示词又快又便宜。模型不支持这个参数时（例如实测的 `workbuddy/glm-5.3-flash`），会自动去掉它重试一次。

**建议固定一个模型的情况：**

- 装了会自动切换主对话模型的插件（例如 [dsh-router-laya](https://github.com/HapyRain/dsh-router-laya)）：不固定的话，提示词会跟着上一轮被切换到的模型走，速度和成功率不稳定。
- 当前聊天模型是关不掉思考的推理模型：思考过程可能用光 `maxOutputTokens`，正文为空。

选一个响应快、不带思考的模型即可，例如：

```yaml
        provider: 'workbuddy'
        model: 'glm-5.3-flash'
```

发给模型的内容只有最近几条对话的文字，发送前会把 `sk-…` 形式的密钥、`api_key` / `token` / `password` / `secret` 字段和 `Bearer …` 替换成「[已隐藏]」。这种按格式识别的脱敏不能保证认出所有敏感信息。

---

## 排查

### 一点反应都没有（↑ 也不管用）

1. 确认已经**完全退出并重开** DSH，且重开时代码已经同步完成。
2. 按 `Ctrl+Shift+I` 打开开发者工具，切到 **Console**，搜索 `dsh-prompt-prefill`：
   - 「RPC 路由不存在（404）」：插件的后台部分没加载，确认插件已启用（`dsh plugin --profile desktop list`）并重启；
   - 什么都搜不到：插件的界面部分没加载，同样检查插件是否启用。

### ↑ 能用，但回答完不出灰字

查看[诊断记录](#诊断记录)，按 `result` 一列判断：

| `result` | 含义 | 怎么办 |
| --- | --- | --- |
| `model` | 正常生成了 | 若仍看不到灰字，检查输入框是否有焦点、是否已有文字 |
| `NO_CANDIDATE` · 生成失败 | 模型调用出错；`detail` 里有 DSH 给出的错误码与原因 | 按错误原因处理，常见是模型或网关配置问题；可在配置里固定一个模型 |
| `NO_CANDIDATE` · 模型没有给出可用的提示词 | 模型回了 `NONE` 或空；`detail` 里有正文开头与结束原因 | 对话没有明显下一步时属正常；若 `detail` 显示「结束原因 max-tokens、正文 0 字」，是思考用光了额度，换不带思考的模型或调大 `maxOutputTokens` |
| `NO_CANDIDATE` · 生成超时 | 超过 `timeoutMs` | 调大 `timeoutMs` 或换更快的模型 |
| `NO_CANDIDATE` · 请求已取消 | 生成途中又开始了新回合或切换了会话 | 正常现象 |
| `SKIPPED` | 上一轮没有正常结束；`detail` 写明 DSH 记录的结束原因 | `error` / `aborted` / `max-tokens` 属正常跳过 |
| `NO_TURN` | 来要建议时，8 秒内没等到这一轮的回合结束事件 | 偶发可忽略；频繁出现请保存诊断结果反馈 |
| 记录里没有这一次 | 界面部分没察觉到回答结束，没有发出请求 | 在 Console 里看有没有「回答结束，开始请求提示词」这一行 |

### 诊断记录

插件会记下最近 20 次生成的结果（只在内存里，重启清空），每次也写一行后台日志（前缀 `dsh-prompt-prefill: 生成`）。在 DSH 的开发者工具 Console 里运行：

```js
fetch('/dsh-prompt-prefill/rpc',{method:'POST',headers:{'content-type':'application/json'},body:'{"method":"diagnostics"}'}).then(r=>r.json()).then(d=>{console.log(d.version,d.trigger,'收到事件',d.eventsReceived);console.table(d.recent)})
```

也可以让本机的其他工具向 `/dsh-prompt-prefill/rpc` 发送 POST 请求 `{"method":"diagnostics"}`。返回内容：

| 字段 | 含义 |
| --- | --- |
| `version` | 后台**实际运行**的版本（启动时读取）。和磁盘上的 package.json 不一致，说明需要重启 |
| `trigger` | 「宿主监听回合结束」为正常；「浏览器半察觉回答结束」表示这个 DSH 不支持回合事件，已自动退回旧做法 |
| `eventsReceived` | 后台收到的会话事件总数；为 0 说明事件没有送到插件 |
| `trackedSessions` | 正在跟踪回合的会话数 |
| `config` | 当前生效的关键配置 |
| `recent` | 最近的生成记录：时间、会话、回合号、耗时、`result`、原因 `message` 与详情 `detail`（模型、正文字数、结束原因、错误、是否重试过、正文开头） |

---

## 工作原理

插件分两半：**后台（宿主半，[lib/index.js](lib/index.js)）** 在 DSH 的 Node 进程里读会话、调模型；**界面（浏览器半，[lib/client.js](lib/client.js)）** 在输入框里画灰字、处理按键。两者通过本机接口 `/dsh-prompt-prefill/rpc` 通信。

**→ / Tab 的流程**

1. 后台订阅 DSH 的 `session/event`，为每个会话记下最近一次 `turn/end` 的回合号与结束原因（`completed` / `error` / `aborted` / `max-tokens` / …）；`turn/start` 时作废上一轮的建议。这里只更新内存，不写任何会话记录。
2. 界面察觉回答结束（会话从「正在回答」变回空闲）时，带上「已经看过第几回合」来要建议（`method: 'suggestion'`）。后台若还没收到这一轮的 `turn/end`，最多等 8 秒。
3. 后台以 `turn/end` 判断这一轮是否正常完成：是才生成，且**同一回合只生成一次**并缓存。生成是按需的——回合结束只记账，界面来要时才调模型，DSH 里看不见的会话（如后台子任务）不会白白花钱。
4. 生成：用 `session.deriveMessages()` 取最近的对话，按上面的模型选择规则调用 `ctx.llm.stream()`，取第一行作为提示词。
5. 界面拿到后在输入框上方画一层与输入框像素对齐的灰字；按 `Tab` / `→` 时调用 `inputActions.setDraft()` 写入草稿。

退路：DSH 没有 `ctx.on`，或后台一次都没收到某个会话的事件时，改由界面决定时机，后台按最后几条消息推断上一轮是否正常结束。若将来 DSH 提供原生内联建议（`inputActions.offerSuggestion`），界面会自动改用原生显示。

**↑ 的流程**：界面拦截空输入框上的 `↑`，向后台要这个会话最后一条真人消息（`method: 'lastSent'`），拿到后 `setDraft()`。等待期间你开始打字或切换会话，结果就丢弃。

**接口的安全边界**：只接受 POST；TCP 对端和 `Host` 都必须是本机回环地址；带 `Origin` 时必须与连接精确同源；`Sec-Fetch-Site: cross-site` 一律拒绝。桌面端转发请求时会去掉 `Origin`，所以没有 `Origin` 时放行。插件没有做用户级鉴权。

---

## 维护者备忘：踩过的坑

改代码前值得先看一遍，每一条都曾让插件「看起来能用、实际不工作」：

1. **DSH 不会为模型调用失败抛错。** `LlmRuntime.stream()` 把任何失败（包括调用前就被拒绝的 `UNSUPPORTED_REASONING_EFFORT`）包装成 `{ type: 'finish', reason: { kind: 'error' | 'aborted', failure: { message, code } } }`。只靠 `try/catch` 会把失败当成「正文 0 字」的正常结束，重试也永远不会触发（0.4.2 修复）。
2. **webServer 服务可能比插件晚就绪。** 必须用 `ctx.inject(['webServer'], …)` 等它就绪再注册路由；直接 `ctx.get('webServer')` 拿到 `undefined` 就会一个路由都没注册，界面请求全部 404（0.1.1 修复）。
3. **`Session` 没有 `events` 属性。** 读历史用未废弃的 `deriveMessages()`；`snapshotEvents()` / `eventAt()` / `ownEvents()` 已标记 `@deprecated`，禁止新的生产调用。测试里的假会话必须复刻真实形状，否则测试全绿、线上全错。
4. **输入框是 Lexical 的 `contenteditable`，不是 `<textarea>`。** `.value` 恒为 `undefined`，要读 `.textContent`；焦点常落在输入框的子节点上，要用 `input.contains(document.activeElement)`。
5. **回答结束后 DSH 会以用户角色插入消息**（切换模型、压缩上下文、goal、schedule、子任务完成等 `MessageSourceMap` 中的来源）。按「最后一条是不是用户消息」判断上一轮是否完成会误判；现在以 `turn/end` 为准，退路里也只把真人输入、工具结果、对提问的回答、对工具调用的批准当作「没收尾」（0.3.1 / 0.4.0）。
6. **`session/event` 按范围过滤派发。** 事件不一定送得到插件，所以收不到时必须有退路，不能干等（0.4.1）。
7. **槽位 `conversation.input.overlay` 的标准 props** 是 `useInput` / `inputActions` / `useSession` / `sessionId`；`SessionSnapshot` 没有 `turnEnds`。
8. **灰字与 DSH 自带的输入提示重叠。** 显示灰字时给输入框加 `data-dsh-prompt-prefill="on"`，用样式隐藏 `[data-composer-placeholder]` 和 `p:last-child:after`，收起时摘掉。
9. **发给模型的消息用 `RequestUserInput` 形状**（`{ role: 'user', content: [...] }`，不带 `id` 和 `source`）；`MessageSourceMap` 里没有 `plugin` 这个来源。

---

## 文件结构与测试

```
dsh-prompt-prefill/
├── package.json        插件清单：入口、exports、dsh 字段（bundle 补丁与浏览器半）
├── cordis.patch.yml    profile 补丁：插件行与全部配置项（含中文注释）
├── lib/
│   ├── core.js         纯逻辑：配置归一化、脱敏、取最近对话、判断上一轮是否完成、清洗模型输出
│   ├── index.js        后台：回合跟踪、RPC（suggestion / lastSent / diagnostics）、调用模型、诊断记录
│   └── client.js       界面：灰字浮层、Tab / → / ↑ / Escape、会话状态、样式注入
└── test/
    ├── core.test.mjs   纯逻辑
    ├── host.test.mjs   后台：路由与安全校验、回合事件、模型失败与重试、诊断
    └── client.test.mjs 界面：自带微型 React 与 DOM，覆盖按键、时机、会话切换与生命周期
```

运行测试（需要 Node.js 20 或更高版本）：

```bash
npm test
```

界面测试用的是模拟的 React 和 DOM，不能代替在真实 DSH 里验证。改动后建议按下面的清单手动过一遍：

1. 打开一个已有对话的会话：**不应**出现灰字。
2. 发一条消息、等回答完：出现灰字，发送按钮仍不可用。
3. 按 `Tab` 或 `→`：灰字变成草稿，不自动发送。
4. 清空草稿：灰字重新出现，不重新请求模型。
5. 输入任意字符：灰字消失，`→` 正常移动光标。
6. 按 `Escape`：灰字消失。
7. 切到别的会话再切回：之前的灰字还在。
8. 回答进行中：不出现灰字。
9. 回答出错或中途停止：不出现灰字。
10. 输入框为空时按 `↑`：填入上一次发送的内容；有字时按 `↑`，光标正常上移。

---

## 已知限制

- **灰字是一层对齐的浮层，不是真正写进输入框的文字。** DSH 0.2.0-rc.2 的 `InputActions` 没有内联建议接口；输入框内部滚动时靠监听滚动重新对齐，候选很长时浮层会按输入框高度截断（按 `Tab` / `→` 仍写入完整内容）。
- **是否去要建议，取决于界面察觉到回答结束。** 回答进行中切走、结束后切回会补要一次；但如果切走**之前**回答还没开始（例如在另一个窗口发起），切回时显示的仍是之前的灰字。
- **对话没有明显下一步时**（打招呼、一问一答已经结束），模型常回 `NONE`，不出灰字。
- **↑ 只能填入上一条**，不能连续往前翻；只恢复文字，不恢复图片附件。
- **没有设置界面**，配置只能改 `cordis.patch.yml`。
- 灰字带 `aria-hidden`，没有单独的读屏提示。
- 不要和其他同样拦截 `Tab` / `→` / `↑` 的插件同时安装（见下方同类插件）。

---

## 版本历史

| 版本 | 主要变化 |
| --- | --- |
| 0.4.2 | 正确处理 DSH 以 `finish` 片段返回的模型失败：不支持关闭思考时去掉该参数重试，其他错误写进诊断。修复部分模型永远不出灰字 |
| 0.4.1 | 后台收不到某个会话的事件时，立刻退回旧做法，不再干等 |
| 0.4.0 | 改由后台监听 `turn/end` 判断是否生成；同一回合只生成一次并缓存 |
| 0.3.1 | 修复回答后插入的系统类消息导致误判「上一轮没收尾」；新增诊断记录 |
| 0.3.0 | 新增 ↑ 填入上一次发送的内容；斜杠命令处理中（`claimed`）也视为锁定 |
| 0.2.1 | 切换会话后保留已生成的灰字；修复会话数超过上限时界面反复刷新 |
| 0.2.0 | 只在回答结束时生成；默认不显示兜底句；支持 Tab 采纳；上一轮出错时跳过 |
| 0.1.1 | 修复后台路由在 webServer 就绪前注册失败、导致完全没有灰字；首次上传到 GitHub |

---

## 同类插件与参考

本插件最初参考了 [ChuanTianML/prompt-for-me](https://github.com/ChuanTianML/prompt-for-me)（`dsh-prompt-for-me`）：浏览器半的模块包装方式、RPC 路由注册、读会话与调模型的服务用法，以及「建议不算草稿、Enter 绝不采纳」的交互约定都来自它。

功能相近的插件（2026-10 调研）：

| 插件 | 做法 |
| --- | --- |
| [ChuanTianML/prompt-for-me](https://github.com/ChuanTianML/prompt-for-me) | 下一句建议，可手动换一条，会记住偏好 |
| [studyzy/dsh-suggest-prompt](https://github.com/studyzy/dsh-suggest-prompt) | 后台在 `turn/end` 时生成，建议写入会话记录，过滤套话，带设置页 |
| [nzl153/dsh-prompt-suggestions](https://github.com/nzl153/dsh-prompt-suggestions) | 与本插件的 → 功能思路几乎相同，默认用 flash 模型、关闭思考 |
| [converk/dsh-tweaks · prompt-history](https://github.com/converk/dsh-tweaks/tree/main/plugins/prompt-history) | 空输入框 ↑ / ↓ 连续翻历史，显示位置角标 |
| [PerryLink/dsh-composer-history](https://github.com/PerryLink/dsh-composer-history) | 终端风格的输入历史，支持 Ctrl+R 搜索 |

它们同样会拦截 `Tab` / `→` / `↑`，**不要与本插件同时安装**。本插件的特点是把「下一句建议」和「上一条回填」放在一个小插件里，并带诊断记录，方便排查。

---

## License

MIT
