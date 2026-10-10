/**
 * 纯逻辑测试：配置归一化、脱敏、上下文提取、候选清洗、兜底轮换。
 * 不依赖 Harness，直接跑核心函数。
 *
 * 运行：node test/core.test.mjs
 */

import {
  DEFAULT_CONFIG,
  buildUserPayload,
  extractRecentTurns,
  lastTurnCompleted,
  lastTurnState,
  lastUserText,
  parseCandidate,
  pickFallback,
  redactSecrets,
  resolveConfig,
  systemPrompt,
  truncate,
  utf8Bytes,
} from '../lib/core.js'

let failures = 0
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${label}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

console.log('resolveConfig')
{
  const defaults = resolveConfig(null)
  check('null 配置回退到默认值', defaults.enabled === true && defaults.maxRecentTurns === 3)
  check('兜底提示词被复制而非共享引用', defaults.fallbackPrompts !== DEFAULT_CONFIG.fallbackPrompts)
  check('默认不使用兜底句', defaults.useFallback === false)
  check('可以打开兜底句', resolveConfig({ useFallback: true }).useFallback === true)

  const bad = resolveConfig({
    enabled: 'yes',
    maxOutputTokens: -1,
    maxRecentTurns: 0,
    provider: 42,
    fallbackPrompts: ['保留我', '', 7],
    unknownKey: true,
  })
  check('布尔类型不符时回退', bad.enabled === true)
  check('非正数回退到默认值', bad.maxOutputTokens === DEFAULT_CONFIG.maxOutputTokens)
  check('零值回退到默认值', bad.maxRecentTurns === 3)
  check('非字符串 provider 回退', bad.provider === '')
  check('兜底提示词过滤掉空串与非字符串', JSON.stringify(bad.fallbackPrompts) === '["保留我"]')
  check('未知键被忽略', !('unknownKey' in bad))

  const good = resolveConfig({ enabled: false, maxOutputTokens: 64, maxRecentTurns: 5 })
  check('合法布尔生效', good.enabled === false)
  check('合法数字生效', good.maxOutputTokens === 64 && good.maxRecentTurns === 5)

  const emptyFallback = resolveConfig({ fallbackPrompts: [] })
  check('空兜底数组回退到默认值', emptyFallback.fallbackPrompts.length === DEFAULT_CONFIG.fallbackPrompts.length)
}

console.log('\nredactSecrets')
{
  check('隐藏 sk- 密钥', redactSecrets('key sk-abcdefghijklmnop').includes('[已隐藏]'))
  check('隐藏 api_key 赋值', redactSecrets('api_key: supersecretvalue').includes('[已隐藏]'))
  check('隐藏 Bearer', redactSecrets('Authorization: Bearer abcdefghijklmnop').includes('Bearer [已隐藏]'))
  check('不改动普通文本', redactSecrets('今天天气不错') === '今天天气不错')
  const samples = {
    'GitHub 令牌': 'token ghp_EXAMPLEabcdefghijklmnopqrstuvwxyz0123',
    'GitHub 细粒度令牌': 'github_pat_EXAMPLE_abcdefghijklmnopqrstuvwxyz',
    'AWS 访问密钥': 'id AKIAEXAMPLE00000000Q here',
    'Slack 令牌': 'xoxb-EXAMPLE-0000000000-abcdef',
    'Basic 认证头': 'Authorization: Basic EXAMPLEdXNlcjpwYXNz',
    '中文写法的密码': '数据库密码：EXAMPLEhunter2，记得改',
    'PEM 私钥': '-----BEGIN RSA PRIVATE KEY-----\nEXAMPLEMIIEow\nEXAMPLEabc\n-----END RSA PRIVATE KEY-----',
    '缺少结尾行的 PEM 私钥': '贴一下 -----BEGIN PRIVATE KEY-----\nEXAMPLEMIIEow',
  }
  for (const [label, sample] of Object.entries(samples)) {
    const out = redactSecrets(sample)
    check(`隐藏${label}`, !out.includes('EXAMPLE') && out.includes('[已隐藏]'), out)
  }
  const url = redactSecrets('连 postgres://admin:EXAMPLEhunter2@db.local:5432/app 试试')
  check('隐藏 URL 里的口令并保留用户名和主机', url === '连 postgres://admin:[已隐藏]@db.local:5432/app 试试', url)
  check('不误伤普通 URL 和英文单词', redactSecrets('see https://example.com/a:b and Basic understanding') === 'see https://example.com/a:b and Basic understanding')
  check('中文写法保留字段名', redactSecrets('密码：EXAMPLE123') === '密码：[已隐藏]', redactSecrets('密码：EXAMPLE123'))

  const credentials = { api_key: 'EXAMPLE_ONLY_key', password: 'EXAMPLE ONLY password', token: 'EXAMPLE_ONLY_token' }
  const redacted = redactSecrets(JSON.stringify(credentials))
  check('JSON 字段的凭据全部隐藏', Object.values(credentials).every((value) => !redacted.includes(value)), redacted)
  check('脱敏后 JSON 仍可解析', Object.values(JSON.parse(redacted)).every((value) => value === '[已隐藏]'))
  const escaped = redactSecrets(JSON.stringify({ secret: 'EXAMPLE "quoted" tail' }))
  check('JSON 转义引号后的尾部也隐藏', JSON.parse(escaped).secret === '[已隐藏]', escaped)
  const quoted = `password='EXAMPLE ONLY password'; secret="EXAMPLE \\"quote\\" secret"; OPENAI_API_KEY=EXAMPLE_ONLY_key`
  const hidden = redactSecrets(quoted)
  check('带空格和转义引号的凭据全部隐藏', !hidden.includes('EXAMPLE'), hidden)
  const payload = buildUserPayload({ draft: JSON.stringify(credentials) }, extractRecentTurns([{
    role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: JSON.stringify(credentials) }],
  }], resolveConfig(null)))
  check('草稿和历史都不会把 JSON 凭据外发', !payload.includes('EXAMPLE'), payload)
}

console.log('\nextractRecentTurns')
{
  const events = [
    { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }] } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '你好，有什么可以帮你？' }] } } },
    // 系统注入：source.kind 不是 user，必须被忽略
    { type: 'user/message', data: { source: { kind: 'system' }, content: [{ type: 'text', text: '系统提示' }] } },
    // 工具结果：类型不匹配，忽略
    { type: 'tool/result', data: { content: [{ type: 'text', text: '工具输出' }] } },
    // 无 source 的用户消息：忽略
    { type: 'user/message', data: { content: [{ type: 'text', text: '缺少 source' }] } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '第二轮回复' }] } } },
    null,
    'garbage',
  ]
  const turns = extractRecentTurns(events, resolveConfig(null))
  check('只保留真人用户与助手消息', turns.length === 3, JSON.stringify(turns))
  check('顺序为时间正序', turns[0].text === '你好' && turns[2].text === '第二轮回复')
  check('角色被正确标注', turns[0].role === 'user' && turns[1].role === 'assistant')
  check('系统注入被排除', !turns.some((turn) => turn.text.includes('系统提示')))

  check('非数组输入返回空', extractRecentTurns(null, resolveConfig(null)).length === 0)

  const many = []
  for (let index = 0; index < 10; index += 1) {
    many.push({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: `第${index}条` }] } })
  }
  const limited = extractRecentTurns(many, resolveConfig({ maxRecentTurns: 2 }))
  check('遵守 maxRecentTurns 上限', limited.length === 2, String(limited.length))
  check('保留的是最近两条', limited[1].text === '第9条', JSON.stringify(limited))

  const long = [{ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'x'.repeat(5000) }] } }]
  const clipped = extractRecentTurns(long, resolveConfig({ maxContextChars: 300, maxRecentTurns: 3 }))
  check('超长单条被截断', clipped[0].text.length <= 301, String(clipped[0].text.length))

  check('多文本块被拼接', extractRecentTurns([{
    type: 'user/message',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }] },
  }], resolveConfig(null))[0].text === 'A B')

  for (const shape of ['event', 'message']) {
    const message = (role, text) => shape === 'event'
      ? (role === 'user'
        ? { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } }
        : { type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } })
      : { role, source: { kind: role === 'user' ? 'user' : 'model' }, content: [{ type: 'text', text }] }
    const latest = extractRecentTurns([
      message('user', '旧话题'), message('assistant', '旧回复'),
      message('user', '新问题：' + '日志'.repeat(1200)), message('assistant', '请提供版本'),
    ], resolveConfig({ maxRecentTurns: 2 }))
    check(`${shape} 保留长的最新用户请求`, latest[0]?.text.startsWith('新问题：') === true, JSON.stringify(latest))
    check(`${shape} 不用旧话题补足数量`, !latest.some((turn) => turn.text.includes('旧')))
  }
  const budget = extractRecentTurns(long, resolveConfig({ maxContextChars: 1 }))
  check('截断省略号也计入上下文预算', budget.reduce((sum, turn) => sum + turn.text.length, 0) <= 1)
}

console.log('\nextractRecentTurns —— Message 形状（deriveMessages 的真实返回）')
{
  // 这是**首选**输入形状：session.deriveMessages() 返回 Message（{role,content,source}），
  // 不是 SessionEvent。早先实现只认事件形状，所以真机上永远拿不到历史。
  const messages = [
    { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '帮我写个排序函数' }] },
    { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: '好的，这是实现' }] },
    // 非真人来源的用户消息：必须排除
    { role: 'user', source: { kind: 'goal' }, content: [{ type: 'text', text: '目标注入' }] },
    { role: 'user', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: '系统提示' }] },
    // 工具/系统角色：不参与
    { role: 'tool', source: { kind: 'tool' }, content: [{ type: 'text', text: '工具结果' }] },
    { role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: '系统' }] },
    { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: '还需要边界测试' }] },
  ]
  const turns = extractRecentTurns(messages, resolveConfig(null))
  check('Message 形状能被识别', turns.length === 3, JSON.stringify(turns))
  check('Message 顺序为正序', turns[0].text === '帮我写个排序函数' && turns[2].text === '还需要边界测试')
  check('Message 角色标注正确', turns[0].role === 'user' && turns[1].role === 'assistant')
  check('非真人来源被排除', !turns.some((turn) => turn.text.includes('目标注入') || turn.text.includes('系统提示')))
  check('工具与系统角色被排除', !turns.some((turn) => turn.text.includes('工具结果')))

  check('Message 缺少 source 的助手续消息仍可用',
    extractRecentTurns([{ role: 'assistant', content: [{ type: 'text', text: '无 source 助手' }] }], resolveConfig(null))
      .length === 1)
  check('Message 缺少 source 的用户消息被排除',
    extractRecentTurns([{ role: 'user', content: [{ type: 'text', text: '无 source 用户' }] }], resolveConfig(null))
      .length === 0)

  const mixed = extractRecentTurns([
    ...messages,
    { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '事件形状也兼容' }] } },
  ], resolveConfig(null))
  check('两种形状可混用', mixed.some((turn) => turn.text === '事件形状也兼容'))

  const longMessage = [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'y'.repeat(5000) }] }]
  check('Message 超长同样被截断',
    extractRecentTurns(longMessage, resolveConfig({ maxContextChars: 300 }))[0].text.length <= 301)
}

console.log('\nparseCandidate')
{
  const config = resolveConfig(null)
  check('普通单行通过', parseCandidate('请继续', config) === '请继续')
  check('去除项目符号', parseCandidate('- 请继续', config) === '请继续')
  check('去除编号', parseCandidate('1. 请继续', config) === '请继续')
  check('去除包裹引号', parseCandidate('"请继续"', config) === '请继续')
  check('去除中文引号', parseCandidate('「请继续」', config) === '请继续')
  check('多行只取第一行', parseCandidate('第一行\n第二行', config) === '第一行')
  check('前导空行被跳过', parseCandidate('\n\n  请继续  ', config) === '请继续')
  check('NONE 被拒绝', parseCandidate('NONE', config) === undefined)
  check('none 大小写不敏感', parseCandidate('none', config) === undefined)
  check('空串被拒绝', parseCandidate('   ', config) === undefined)
  check('非字符串被拒绝', parseCandidate(null, config) === undefined)
  check('超长候选被截断', (parseCandidate('y'.repeat(5000), resolveConfig({ maxCandidateChars: 100 })) ?? '').length <= 101)
  check('纯符号行按原样返回', parseCandidate('---', config) === '---')
}

console.log('\npickFallback')
{
  const config = resolveConfig({ fallbackPrompts: ['A', 'B'] })
  const first = pickFallback(config, 0)
  const second = pickFallback(config, first.cursor)
  const third = pickFallback(config, second.cursor)
  check('按游标轮换', first.candidate === 'A' && second.candidate === 'B')
  check('游标回绕', third.candidate === 'A')
  check('越界游标被取模', pickFallback(config, 7).candidate === 'B')

  // resolveConfig 保证 fallbackPrompts 非空；这里直接构造一个空列表，
  // 覆盖 pickFallback 自身对空数组的防御（宿主半会把它降级为 NO_FALLBACK）。
  const bare = { ...resolveConfig(null), fallbackPrompts: [] }
  const none = pickFallback(bare, 0)
  check('空兜底列表返回 undefined 候选', none.candidate === undefined && none.cursor === 0, JSON.stringify(none))

  check('resolveConfig 不会产出空兜底列表', resolveConfig({ fallbackPrompts: [] }).fallbackPrompts.length > 0)
}

console.log('\n构建请求与系统提示词')
{
  const payload = buildUserPayload({ draft: '带 sk-abcdefghijklmnop 的草稿' }, [{ role: 'user', text: '你好' }])
  const parsed = JSON.parse(payload)
  check('payload 是合法 JSON', parsed !== null && typeof parsed === 'object')
  check('payload 携带最近对话', parsed.最近对话.length === 1)
  check('payload 中的草稿已脱敏', !payload.includes('sk-abcdefghijklmnop'))
  check('payload 要求单行输出', parsed.输出要求.includes('单行'))

  const system = systemPrompt()
  check('系统提示词要求 NONE 兜底', system.includes('NONE'))
  check('系统提示词要求单行', system.includes('单行'))
}

console.log('\n工具函数')
{
  check('utf8Bytes 统计中文字节', utf8Bytes('中') === 3)
  check('truncate 短文本原样返回', truncate('abc', 10) === 'abc')
  check('truncate 长文本加省略号', truncate('abcdef', 3) === 'abc…')
  check('truncate 非法上限返回空串', truncate('abc', 0) === '')
}

console.log('\nlastUserText')
{
  const user = (text, kind = 'user') => ({ role: 'user', source: { kind }, content: [{ type: 'text', text }] })
  const assistant = (text) => ({ role: 'assistant', content: [{ type: 'text', text }] })
  check('取最后一条用户消息', lastUserText([user('第一句'), assistant('回复'), user('第二句'), assistant('回复')]) === '第二句')
  check('跳过工具结果', lastUserText([user('真人'), user('工具输出', 'tool'), assistant('回复')]) === '真人')
  check('保留原文不脱敏', lastUserText([user('key sk-abcdefghijklmnop')]) === 'key sk-abcdefghijklmnop')
  check('多段文字按行拼接', lastUserText([{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }] }]) === 'a\nb')
  check('跳过纯空白消息', lastUserText([user('有内容'), user('   ')]) === '有内容')
  check('旧式事件也能取', lastUserText([{ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '事件' }] } }]) === '事件')
  check('没有用户消息返回 undefined', lastUserText([assistant('x')]) === undefined && lastUserText(undefined) === undefined)
}

console.log('\nlastTurnCompleted')
{
  const user = (text) => ({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })
  const assistant = (text) => ({ role: 'assistant', content: [{ type: 'text', text }] })
  check('助手消息结尾算正常', lastTurnCompleted([user('a'), assistant('b')]) === true)
  check('用户消息结尾算没收尾', lastTurnCompleted([user('a'), assistant('b'), user('c')]) === false)
  check('工具结果结尾算没收尾', lastTurnCompleted([user('a'), { role: 'user', source: { kind: 'tool' }, content: [] }]) === false)
  check('未知角色跳过继续往前看', lastTurnCompleted([user('a'), assistant('b'), { role: 'system', content: [] }]) === true)
  check('turn/end completed 算正常', lastTurnCompleted([{ type: 'turn/end', data: { reason: { kind: 'completed' } } }]) === true)
  check('turn/end error 算没收尾', lastTurnCompleted([{ type: 'assistant/message', data: {} }, { type: 'turn/end', data: { reason: { kind: 'error' } } }]) === false)
  check('turn/end 无 reason 算正常', lastTurnCompleted([{ type: 'turn/end', data: {} }]) === true)
  check('空历史无从判断时放行', lastTurnCompleted([]) === true && lastTurnCompleted(undefined) === true)

  // 回答结束后 DSH 组件以用户角色插入的消息（goal / schedule / 系统注入）不算「没收尾」。
  const injected = (kind) => ({ role: 'user', source: { kind }, content: [{ type: 'text', text: '注入' }] })
  check('goal 注入消息不误判', lastTurnCompleted([user('a'), assistant('b'), injected('goal')]) === true)
  check('schedule 注入消息不误判', lastTurnCompleted([user('a'), assistant('b'), injected('schedule')]) === true)
  check('system-prompt 注入消息不误判', lastTurnCompleted([user('a'), assistant('b'), injected('system-prompt')]) === true)
  check('切换模型消息不误判', lastTurnCompleted([user('a'), assistant('b'), injected('model-selection')]) === true)
  check('压缩上下文消息不误判', lastTurnCompleted([user('a'), assistant('b'), injected('compact-checkpoint')]) === true)
  check('子任务完成通知不误判', lastTurnCompleted([user('a'), assistant('b'), injected('subagent-settled')]) === true)
  check('回答提问后没有回复算没收尾', lastTurnCompleted([assistant('b'), injected('user-question-reply')]) === false)
  check('批准工具后没有回复算没收尾', lastTurnCompleted([assistant('b'), injected('user-approval')]) === false)
  check('注入消息之前是真人消息仍算没收尾', lastTurnCompleted([assistant('b'), user('c'), injected('goal')]) === false)
  check('tool 角色算没收尾', lastTurnCompleted([user('a'), { role: 'tool', content: [] }]) === false)
  check('没有来源的用户消息算没收尾', lastTurnCompleted([assistant('b'), { role: 'user', content: [] }]) === false)
  check('事件形状的 goal 注入不误判', lastTurnCompleted([
    { type: 'assistant/message', data: {} },
    { type: 'user/message', data: { source: { kind: 'goal' }, content: [] } },
  ]) === true)
  check('诊断依据说明来源', lastTurnState([assistant('b'), user('c')]).basis === 'user:user', lastTurnState([assistant('b'), user('c')]).basis)
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exitCode = failures === 0 ? 0 : 1
