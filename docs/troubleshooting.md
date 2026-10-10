# 排查与诊断

[← 返回 README](../README.md)

## 一点反应都没有（↑ 也不管用）

1. 确认已经**完全退出并重开** DSH，且重开时代码已经同步完成。
2. 按 `Ctrl+Shift+I` 打开开发者工具，切到 **Console**，搜索 `dsh-prompt-prefill`：
   - 「RPC 路由不存在（404）」：插件的后台部分没加载，确认插件已启用（`dsh plugin --profile desktop list`）并重启；
   - 什么都搜不到：插件的界面部分没加载，同样检查插件是否启用。

## ↑ 能用，但回答完不出灰字

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

## 诊断记录

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
