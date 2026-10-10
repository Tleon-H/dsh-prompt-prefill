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
  /**
   * 生成失败时是否改用兜底提示词。默认关闭：与 Claude Code 一致，
   * 宁可不显示，也不给一句千篇一律的泛泛建议。
   */
  useFallback: false,
  /** useFallback 打开时使用的兜底提示词（依次轮换）。 */
  fallbackPrompts: [
    '请总结一下我们刚才讨论的内容，并给出下一步建议。',
    '请把上面的结论整理成一份简洁的要点清单。',
    '请继续，并说明你的判断依据。',
  ],
}

/** 配置项的类型表，用于按类型校验外部传入的原始配置。 */
const CONFIG_TYPES = {
  enabled: 'boolean',
  useFallback: 'boolean',
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
 * 脱敏：密钥、令牌、口令、Bearer / Basic 头、URL 里的口令和 PEM 私钥。
 *
 * 提示词生成会把最近对话发给模型，所以这里在送给模型之前先做一次
 * 保守的脱敏，避免把用户贴在对话里的凭据再外发一遍。
 *
 * @param text - 原始文本。
 */
export function redactSecrets(text) {
  return String(text)
    // PEM 私钥块（缺少结尾行时一直隐藏到文本末尾）。
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, REDACTED)
    .replace(/\b(?:sk|pk)-[A-Za-z0-9_-]{12,}\b/g, REDACTED)
    // 常见服务的固定前缀令牌：GitHub、AWS 访问密钥、Slack。
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, REDACTED)
    .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, REDACTED)
    .replace(/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, REDACTED)
    // URL 里的口令：scheme://user:口令@host，保留用户名和主机。
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]+@/gi, `$1${REDACTED}@`)
    .replace(/(\bauthorization\s*[:=]\s*["']?basic\s+)[A-Za-z0-9+/=]+/gi, `$1${REDACTED}`)
    // 中文写法：密码：xxx、令牌=xxx。
    .replace(/((?:密码|口令|密钥|令牌)\s*[:：=]\s*)[^\s，。；、,;"'}\]]+/g, `$1${REDACTED}`)
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
 * 找出用户在这个会话里最后发出的那条消息的文字。
 *
 * 只认真人输入（`source.kind === 'user'`），工具结果、系统注入不算。
 * 返回原文：这段文字只会回填到用户自己的输入框，不会发给模型，因此不脱敏、不截断。
 * 两种形状都接受，见 extractRecentTurns。
 *
 * @param items - Message 数组或 SessionEvent 数组。
 * @returns 最后一条用户消息的文字；没有时返回 undefined。
 */
export function lastUserText(items) {
  if (!Array.isArray(items)) return undefined
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (!item || typeof item !== 'object') continue
    let payload
    if (item.type === 'user/message') payload = item.data
    else if (typeof item.type !== 'string' && item.role === 'user') payload = item
    else continue
    if (!payload || !payload.source || payload.source.kind !== 'user') continue
    const text = messageText(payload)
    if (text.trim() !== '') return text
  }
  return undefined
}

/**
 * 排在最后时说明「助手还没给出最终回复」的消息来源：真人输入、工具结果、
 * 用户对 Agent 提问的回答、用户对工具调用的批准——它们之后本该还有助手回复。
 *
 * DSH 0.2.0-rc.2 的 MessageSourceMap 还有 model-selection、compact-checkpoint、
 * subagent-settled、goal、schedule、session-reference 等十几种来源，它们会在回答
 * 结束后出现在末尾（例如刚切换过模型、刚压缩过上下文），不能当成「没收尾」。
 */
const UNFINISHED_SOURCES = new Set(['user', 'tool', 'user-question-reply', 'user-approval'])

/**
 * 判断会话的上一轮是否正常结束，并说明依据的是哪一条。
 *
 * 上一轮出错或被中断时不该给建议（Claude Code 同样会跳过）：此时用户要做的是
 * 处理错误，而不是顺着一段没说完的对话往下走。
 *
 * 从末尾往前找第一条能说明问题的条目，两种形状都接受：
 * - SessionEvent：`turn/end` 以 `data.reason.kind` 为准（没有该字段视为正常）；
 *   `assistant/message` 视为正常；`user/message` 按来源判断（见下）。
 * - Message：`assistant` 视为正常；`tool` 角色视为没收尾；`user` 角色按来源判断。
 *
 * 用户角色的消息只有来源属于 UNFINISHED_SOURCES，或者干脆没有来源时，才说明
 * 助手没给出最终回复。**其他来源（如切换模型、压缩上下文、goal、schedule）跳过
 * 不看**——DSH 会在回答结束后以用户角色插入这些消息，若把它们当成「没收尾」，
 * 正常结束的回答也会被误判而不出建议（「回答完有时不出灰字」的主要嫌疑）。
 *
 * 什么都判断不了时视为正常，交给后续流程决定。
 *
 * @param items - Message 数组或 SessionEvent 数组。
 * @returns { completed, basis }：basis 是给诊断日志看的简短说明。
 */
export function lastTurnState(items) {
  if (!Array.isArray(items)) return { completed: true, basis: '没有历史' }
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (!item || typeof item !== 'object') continue
    if (typeof item.type === 'string') {
      if (item.type === 'turn/end') {
        const kind = item.data?.reason?.kind
        return { completed: kind === undefined || kind === 'completed', basis: `turn/end:${kind ?? '无原因'}` }
      }
      if (item.type === 'assistant/message') return { completed: true, basis: 'assistant/message' }
      if (item.type === 'user/message') {
        const kind = item.data?.source?.kind
        if (kind === undefined || UNFINISHED_SOURCES.has(kind)) {
          return { completed: false, basis: `user/message:${kind ?? '无来源'}` }
        }
      }
      continue
    }
    if (item.role === 'assistant') return { completed: true, basis: 'assistant' }
    if (item.role === 'tool') return { completed: false, basis: 'tool' }
    if (item.role === 'user') {
      const kind = item.source?.kind
      if (kind === undefined || UNFINISHED_SOURCES.has(kind)) {
        return { completed: false, basis: `user:${kind ?? '无来源'}` }
      }
    }
  }
  return { completed: true, basis: '无可判断的消息' }
}

/**
 * 上一轮是否正常结束（只要结论时用这个）。
 * @param items - Message 数组或 SessionEvent 数组。
 */
export function lastTurnCompleted(items) {
  return lastTurnState(items).completed
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
