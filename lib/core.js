/**
 * dsh-prompt-prefill —— 共享纯逻辑（仅宿主半使用）
 *
 * 这里放的全部是与 Harness 无关的纯函数：配置归一化、敏感信息脱敏、
 * 会话事件文本提取、以及模型输出到「一条提示词」的清洗。
 * 把它们独立出来，是为了让 `test/core.test.mjs` 能在没有 Harness 的情况下
 * 直接覆盖这些最容易出错的边界。
 *
 * @module dsh-prompt-prefill/core
 */

/** 脱敏占位符。 */
const REDACTED = '[已隐藏]'

/** 默认配置；`cordis.patch.yml` 中的同名键会覆盖这里。 */
export const DEFAULT_CONFIG = {
  /** 总开关。关闭后浏览器半不再请求，也不再显示幽灵文本。 */
  enabled: true,
  /** 单次生成的最大输出 token 数。 */
  maxOutputTokens: 512,
  /** 单次生成的超时时间（毫秒）。 */
  timeoutMs: 20000,
  /** 参与上下文的最近对话轮数。 */
  maxRecentTurns: 3,
  /** 最近对话文本的总字符预算。 */
  maxContextChars: 4000,
  /** 单条提示词的字符上限，超出会被截断。 */
  maxCandidateChars: 1200,
  /** 固定使用的提供方；留空表示跟随当前会话或默认模型。 */
  provider: '',
  /** 固定使用的模型；留空表示跟随当前会话或默认模型。 */
  model: '',
  /** 模型不可用时的兜底提示词（仍以灰色预填充展示）。 */
  fallbackPrompts: [
    '请总结一下我们刚才讨论的内容，并给出下一步建议。',
    '请把上面的结论整理成一份简洁的要点清单。',
    '请继续，并说明你的判断依据。',
  ],
}

/** 配置项的类型表，用于按类型校验外部传入的原始配置。 */
const CONFIG_TYPES = {
  enabled: 'boolean',
  maxOutputTokens: 'number',
  timeoutMs: 'number',
  maxRecentTurns: 'number',
  maxContextChars: 'number',
  maxCandidateChars: 'number',
  provider: 'string',
  model: 'string',
  fallbackPrompts: 'stringArray',
}

/**
 * 归一化来自 profile patch 的原始配置。
 *
 * 约定：类型不符的键一律回退到默认值，而不是抛错。插件配置写错不应该
 * 让整个插件挂掉——这与 dsh-optimize 的处理方式一致。
 *
 * @param raw - 原始配置对象，可能为 null / undefined。
 * @returns 完整的、类型可信的配置对象。
 */
export function resolveConfig(raw) {
  const config = { ...DEFAULT_CONFIG, fallbackPrompts: [...DEFAULT_CONFIG.fallbackPrompts] }
  if (raw === null || typeof raw !== 'object') return config

  for (const [key, kind] of Object.entries(CONFIG_TYPES)) {
    const value = raw[key]
    if (kind === 'stringArray') {
      if (!Array.isArray(value)) continue
      const items = value.filter((item) => typeof item === 'string' && item.trim() !== '')
      if (items.length > 0) config[key] = items
      continue
    }
    if (typeof value !== kind) continue
    if (kind === 'number' && (!Number.isFinite(value) || value <= 0)) continue
    config[key] = value
  }
  return config
}

/**
 * 统计 UTF-8 字节数；用于给上下文和候选文本定预算。
 * @param text - 任意字符串。
 */
export function utf8Bytes(text) {
  return Buffer.byteLength(String(text), 'utf8')
}

/**
 * 脱敏：密钥、令牌、口令、Bearer 头。
 *
 * 提示词生成会把最近对话发给模型，所以这里在送给模型之前先做一次
 * 保守的脱敏，避免把用户贴在对话里的凭据再外发一遍。
 *
 * @param text - 原始文本。
 */
export function redactSecrets(text) {
  return String(text)
    .replace(/\b(?:sk|pk)-[A-Za-z0-9_-]{12,}\b/g, REDACTED)
    // 保留字段名和引号，完整消费引号内的空格与转义字符。
    // 同时覆盖 JSON、YAML 和 OPENAI_API_KEY 等环境变量赋值。
    .replace(/(["']?\b(?:[\w-]+[_-])?(?:api[_-]?key|token|password|secret)\b["']?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}\]]+)/gi,
      (_, prefix, value) => {
        const quote = value[0] === '"' || value[0] === "'" ? value[0] : ''
        return `${prefix}${quote}${REDACTED}${quote}`
      })
    .replace(/\bBearer\s+[^\s,;"'}\]]+/gi, `Bearer ${REDACTED}`)
}

/**
 * 按字符数截断，保留头部。
 * @param text - 原始文本。
 * @param limit - 最大字符数。
 */
export function truncate(text, limit) {
  const value = String(text)
  if (!Number.isFinite(limit) || limit <= 0) return ''
  if (value.length <= limit) return value
  return `${value.slice(0, limit)}…`
}

/**
 * 从一条消息数据里取出全部文本块。
 * @param data - 消息对象（含 content 块数组）。
 */
export function messageText(data) {
  if (!data || !Array.isArray(data.content)) return ''
  return data.content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

/**
 * 抽取最近的真人用户 / 助手对话，用于「按场景动态生成」。
 *
 * 只保留 `source.kind === 'user'` 的用户消息，因此系统注入、工具结果、
 * 其他来源的上下文都不会被误当成用户意图。
 *
 * 入参刻意做成**两种形状都接受**，因为 DSH 在不同版本里能拿到的东西不同：
 * - `Message`（`session.deriveMessages()` 的返回）：靠 `role` 区分，
 *   形如 `{ role:'user'|'assistant', content:[...], source:{kind} }`。
 *   这是**首选**形状——`deriveMessages()` 从 surface 派生，已经应用了消息投影
 *   （compaction / fork 等），且是唯一没有被标记 `@deprecated` 的读取器。
 * - `SessionEvent`（`session.snapshotEvents()` 的返回）：靠 `type` 区分，
 *   形如 `{ type:'user/message', data }`。这是兼容旧版本的退路。
 *
 * @param items - Message 数组或 SessionEvent 数组。
 * @param config - 已归一化的配置。
 * @returns 形如 [{ role, text }] 的最近对话，按时间正序。
 */
export function extractRecentTurns(items, config) {
  if (!Array.isArray(items)) return []

  // 从末尾扫描，只处理需要的最近消息，避免每次生成都脱敏整段历史。
  const turns = []
  const perTurn = Math.max(200, Math.floor(config.maxContextChars / Math.max(1, config.maxRecentTurns)))
  let budget = Math.floor(config.maxContextChars)
  for (let index = items.length - 1; index >= 0 && turns.length < config.maxRecentTurns && budget > 0; index -= 1) {
    const item = items[index]
    if (!item || typeof item !== 'object') continue

    let role
    let payload

    if (typeof item.type === 'string') {
      // SessionEvent 形状
      if (item.type === 'user/message') {
        payload = item.data
        if (!payload || !payload.source || payload.source.kind !== 'user') continue
        role = 'user'
      } else if (item.type === 'assistant/message') {
        payload = item.data && item.data.message
        role = 'assistant'
      } else {
        continue
      }
    } else if (typeof item.role === 'string') {
      // Message 形状
      if (item.role === 'user') {
        if (!item.source || item.source.kind !== 'user') continue
        role = 'user'
      } else if (item.role === 'assistant') {
        role = 'assistant'
      } else {
        continue
      }
      payload = item
    } else {
      continue
    }

    const text = redactSecrets(messageText(payload)).replace(/\s+/g, ' ').trim()
    if (text === '') continue
    const allowance = Math.min(perTurn, budget)
    // 长的新消息应截断保留，不能被短的旧消息替代；省略号也占预算。
    const clipped = text.length <= allowance ? text
      : allowance === 1 ? '…' : truncate(text, allowance - 1)
    turns.push({ role, text: clipped })
    budget -= clipped.length
  }
  return turns.reverse()
}

/**
 * 组装发给模型的用户消息正文（JSON 文本）。
 * @param args - { draft, reason } 等请求侧信息。
 * @param turns - extractRecentTurns 的结果。
 */
export function buildUserPayload(args, turns) {
  return JSON.stringify({
    任务: '为输入框预填一条用户接下来最可能想说的提示词',
    当前草稿: typeof args?.draft === 'string' ? truncate(redactSecrets(args.draft), 2000) : '',
    最近对话: turns,
    输出要求: '只输出一条提示词本身，单行，不要引号、不要编号、不要解释；无法判断时输出 NONE。',
  })
}

/** 交给模型的系统提示词。 */
export function systemPrompt() {
  return [
    '你是一个输入框提示助手，服务于一个正在与编程助手对话的用户。',
    '根据给定的最近对话，写出「用户接下来最可能想发送」的那一条消息。',
    '要求：',
    '1. 使用与最近对话相同的语言（中文对话就写中文）。',
    '2. 只输出这一条消息本身，单行纯文本。',
    '3. 不要输出引号、列表符号、编号、解释或任何前缀后缀。',
    '4. 直接可发送：应当是一个完整的、以用户口吻表达的请求或问题。',
    '5. 如果信息不足以判断，只输出 NONE。',
  ].join('\n')
}

/**
 * 把模型输出清洗成一条可用的提示词。
 * @param text - 模型输出。
 * @param config - 已归一化的配置。
 * @returns 清洗后的提示词；不可用时返回 undefined。
 */
export function parseCandidate(text, config) {
  if (typeof text !== 'string') return undefined
  const cleaned = text.replace(/^\uFEFF/, '').trim()
  if (cleaned === '') return undefined

  const line = cleaned
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find((part) => part !== '')
  if (line === undefined) return undefined
  if (/^none$/i.test(line)) return undefined

  const value = line
    .replace(/^[-*•]\s+/, '')
    .replace(/^\d+[.)]\s+/, '')
    .replace(/^["“'「『]+/, '')
    .replace(/["”'」』]+$/, '')
    .trim()

  if (value === '' || /^none$/i.test(value)) return undefined
  return truncate(value, config.maxCandidateChars)
}

/**
 * 在兜底提示词里挑一条。
 *
 * 用游标轮换而不是随机，是为了让「重试」总能给出不同的内容，同时让
 * 同样的调用序列可复现（便于测试）。
 *
 * @param config - 已归一化的配置。
 * @param cursor - 调用方持有的轮换游标。
 * @returns { candidate, cursor } 新的提示词与下一个游标。
 */
export function pickFallback(config, cursor) {
  const prompts = config.fallbackPrompts
  if (!Array.isArray(prompts) || prompts.length === 0) return { candidate: undefined, cursor }
  const index = Number.isSafeInteger(cursor) ? ((cursor % prompts.length) + prompts.length) % prompts.length : 0
  return { candidate: prompts[index], cursor: (index + 1) % prompts.length }
}
