# dsh-prompt-prefill

**简体中文** | [English](README.en.md)

[![npm](https://img.shields.io/npm/v/dsh-prompt-prefill)](https://www.npmjs.com/package/dsh-prompt-prefill)
[![test](https://github.com/Tleon-H/dsh-prompt-prefill/actions/workflows/test.yml/badge.svg)](https://github.com/Tleon-H/dsh-prompt-prefill/actions/workflows/test.yml)

DeepSeek Harness（DSH）桌面端插件，给输入框加两个小功能：

- **→ / Tab：采纳建议的下一句。** Agent 回答完后，输入框里出现一条浅灰色的提示词，是根据最近的对话猜你接下来想说的话。按 `Tab` 或 `→` 填进草稿。
- **↑：填入上一次发送的内容。** 输入框为空时按 `↑`，填入这个会话里你上一次发出的消息。

两者都**只填进输入框，不会自动发送**。

适用版本：DSH 桌面端 **0.2.0-rc.2**（其他版本未验证）。

## 安装

```powershell
dsh plugin --profile desktop add dsh-prompt-prefill
```

装完后**完全退出 DSH（包括托盘图标）再重新打开**。安装前最好也先退出 DSH，否则命令会等待它释放文件锁。

- 想用仓库最新代码：`dsh plugin --profile desktop add github:Tleon-H/dsh-prompt-prefill`
- 用网页版 DSH：把 `--profile desktop` 换成你自己的 profile（通常是 `--profile web`）
- 更新：先 `remove` 再重新 `add`，然后重启 DSH
- 卸载：`dsh plugin --profile desktop remove dsh-prompt-prefill`

## 用法

- 回答结束且输入框为空时，几秒内出现灰字；按 `Tab` / `→` 采纳，按 `Escape` 关闭，开始打字时灰字自动隐藏。
- 只是打开或翻看会话不会调用模型；Agent 回答中、上一轮出错或被中止时也不会生成。
- 对话没有明显下一步时，模型可能不给建议，这时不显示灰字。
- 带修饰键的组合键、输入法组字、输入框没有焦点时，插件不拦截按键。

## 配置

配置写在 [cordis.patch.yml](cordis.patch.yml) 里，常用的几项：

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `provider` / `model` | `''` | 固定用来生成提示词的模型，两项都填才生效；留空则跟随当前会话 |
| `timeoutMs` | `20000` | 单次生成超时（毫秒） |
| `maxRecentTurns` | `3` | 发给模型的最近消息条数 |

其余配置项见 `cordis.patch.yml` 里的注释。

插件复用你在 DSH 里配好的模型和密钥，本身不需要任何凭据。如果当前模型带思考、比较慢，或者装了会自动切换模型的插件，建议固定一个响应快、不带思考的模型，例如：

```yaml
        provider: 'workbuddy'
        model: 'glm-5.3-flash'
```

发给模型的只有最近几条对话的文字，常见格式的密钥和 token 会先被替换成「[已隐藏]」，但不能保证识别所有敏感信息。

## 注意事项

- 灰字是对齐在输入框上的浮层，候选很长时可能显示不全，采纳后仍是完整内容。
- `↑` 只能填入上一条，只恢复文字，不恢复图片附件。
- 不要和其他同样拦截 `Tab` / `→` / `↑` 的插件同时安装，见[同类插件](docs/similar-plugins.md)。

## 更多文档

- [排查与诊断](docs/troubleshooting.md)：不出灰字时怎么查
- [开发者文档](docs/development.md)：工作原理、踩过的坑、测试
- [更新日志](CHANGELOG.md)

个人维护的小项目，欢迎通过 [issue](https://github.com/Tleon-H/dsh-prompt-prefill/issues) 反馈，但不保证及时回复。

## License

MIT
