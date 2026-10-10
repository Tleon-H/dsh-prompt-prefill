# 同类插件与参考

[← 返回 README](../README.md)

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
