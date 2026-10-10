# 开发者文档

[← 返回 README](../README.md)

## 工作原理

插件分两半：**后台（宿主半，[lib/index.js](../lib/index.js)）** 在 DSH 的 Node 进程里读会话、调模型；**界面（浏览器半，[lib/client.js](../lib/client.js)）** 在输入框里画灰字、处理按键。两者通过本机接口 `/dsh-prompt-prefill/rpc` 通信。

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

发布新版本：先在 [CHANGELOG.md](../CHANGELOG.md) 里补一行，再运行

```bash
npm version patch   # 或 minor / major，会同时改版本号并打 v* 标签
git push --follow-tags
```

推送标签后 GitHub Actions 会跑测试并发布到 npm，见 [publish.yml](../.github/workflows/publish.yml)。它用 npm 的 Trusted Publishing，首次使用前要在 npmjs.com 的包设置里把本仓库登记为可信发布者。

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
