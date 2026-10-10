/**
 * dsh-prompt-prefill —— 宿主半
 *
 * 职责：接收浏览器半的请求，读取当前会话最近的对话内容，调用 Harness 已配置的
 * 模型生成一条「用户接下来最可能想发」的提示词，并把结果返回给浏览器半。
 *
 * 设计约束（与 DSH 插件生态的既有约定保持一致）：
 * - 只读会话，不写任何会话事件。第三方事件类型会让日志对不认识它的 Harness 构建
 *   不可读（持久化读路径是 fail-closed 的）。
 * - 宿主半永不向 agent loop 抛错：生成失败一律降级为兜底提示词，而不是中断会话。
 * - 不自动发送消息，不绕过权限审批，不调用任何工具。
 * - 路由只接受同源 POST，且有请求体大小上限。
 *
 * @module dsh-prompt-prefill
 */

import { readFileSync } from 'node:fs'

import {
  buildUserPayload,
  extractRecentTurns,
  lastTurnState,
  lastUserText,
  parseCandidate,
  pickFallback,
  resolveConfig,
  systemPrompt,
  utf8Bytes,
} from './core.js'

/** Cordis 插件名。 */
export const name = 'dsh-prompt-prefill'

/** 浏览器半调用的 RPC 路径。 */
const RPC_PATH = '/dsh-prompt-prefill/rpc'

/** 请求体上限：这里只传一个会话 id 和草稿，64 KiB 绰绰有余。 */
const MAX_REQUEST_BYTES = 64 * 1024

/** 诊断记录最多保留最近多少次生成。 */
const MAX_DIAGNOSTICS = 20

/** 最多跟踪多少个会话的最近回合；超出时丢掉最久没更新的。 */
const MAX_TRACKED_SESSIONS = 100

/** 浏览器半来要建议时，最多等多久让宿主收到这一轮的 turn/end。 */
const MAX_WAIT_MS = 15000

/** 插件版本，写进诊断结果，便于确认宿主进程里跑的是哪一版。 */
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
  } catch {
    return 'unknown'
  }
})()

/**
 * 取一个可选服务。
 * @param ctx - cordis context。
 * @param serviceName - 服务键。
 */
function service(ctx, serviceName) {
  return ctx && typeof ctx.get === 'function' ? ctx.get(serviceName) : undefined
}

/**
 * 写一个 JSON 响应。
 * @param response - Node 的 ServerResponse。
 * @param status - HTTP 状态码。
 * @param body - 任意可 JSON 序列化的响应体。
 */
function json(response, status, body) {
  if (response.destroyed || response.writableEnded) return
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(JSON.stringify(body))
}

/**
 * 判断一个 host 名是否指向本机。
 *
 * 只认回环地址，分别用于请求 Host 和实际 TCP 对端的校验。
 * 这样即使 Harness 被以 `--host 0.0.0.0` 之类暴露到局域网，
 * 本插件的端点也不会被同网段的页面调用。
 *
 * @param hostname - URL 的 hostname（不含端口）。
 */
function isLoopbackHost(hostname) {
  if (typeof hostname !== 'string') return false
  const name = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (name === 'localhost' || name === '::1' || name === '0:0:0:0:0:0:0:1') return true
  // 127.0.0.0/8 全部是回环。
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name)
}

/**
 * 同源校验：只允许来自本机 Harness 页面自身的请求。
 *
 * 1. 实际 TCP 对端必须是回环地址；Host 本身不能证明调用者在本机。
 * 2. Host 必须是回环地址；
 * 3. `Origin` 存在时必须与实际连接协议和 Host 同源；
 * 4. `Sec-Fetch-Site: cross-site` 一律拒绝。
 *
 * `Origin` 缺失时放行——这与 DSH 自身的行为一致（同源 GET／部分非浏览器
 * 客户端不带 Origin），此时仍受 TCP 对端、Host 与 Fetch Metadata 的约束。
 *
 * @param request - Node 的 IncomingMessage。
 */
function sameOrigin(request) {
  // Host 是客户端可指定的头，必须同时检查实际 TCP 对端。
  const peer = request.socket?.remoteAddress
  if (typeof peer !== 'string' || !isLoopbackHost(peer.replace(/^::ffff:/i, ''))) return false
  const headers = request.headers ?? {}
  const host = headers.host
  if (typeof host !== 'string' || host === '') return false

  let hostname
  try {
    hostname = new URL(`http://${host}`).hostname
  } catch {
    return false
  }
  if (!isLoopbackHost(hostname)) return false

  const fetchSite = headers['sec-fetch-site']
  if (typeof fetchSite === 'string' && fetchSite.toLowerCase() === 'cross-site') return false

  const origin = headers.origin
  if (typeof origin !== 'string' || origin === '') return true

  try {
    const parsed = new URL(origin)
    // 必须精确同源：协议、主机、端口都要一致。
    const protocol = request.socket?.encrypted === true ? 'https:' : 'http:'
    const expected = new URL(`${protocol}//${host}`)
    return parsed.host === expected.host && parsed.protocol === expected.protocol
  } catch {
    return false
  }
}

/** RPC 的取消/超时不能仅依赖适配器是否及时终止异步迭代。 */
function withAbort(task, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error('请求已取消'))
    signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve(task).then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value) },
      (error) => { signal.removeEventListener('abort', onAbort); reject(error) },
    )
    if (signal.aborted) onAbort()
  })
}

/**
 * 读取并解析 JSON 请求体，带大小上限。
 * @param request - Node 的 IncomingMessage。
 */
function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let bytes = 0
    request.on('data', (chunk) => {
      bytes += chunk.length
      if (bytes > MAX_REQUEST_BYTES) {
        reject(new Error('request-too-large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch {
        reject(new Error('invalid-json'))
      }
    })
    request.on('error', reject)
  })
}

/**
 * 决定这次生成使用哪个提供方 / 模型。
 *
 * 优先级：显式配置 > 该会话最近一次请求实际用的路由 > Harness 默认模型。
 * 这样默认情况下插件复用的就是用户已经配好的 API Key，插件自己不需要任何凭据。
 *
 * @param ctx - cordis context。
 * @param session - 当前会话（Agent），可能为 undefined。
 * @param config - 已归一化的配置。
 * @returns { provider, model } 或 undefined。
 */
export function resolveRoute(ctx, session, config) {
  if (config.provider !== '' && config.model !== '') {
    return { provider: config.provider, model: config.model }
  }

  let selected
  try {
    selected = session && typeof session.requestHeader === 'function'
      ? session.requestHeader()?.config
      : undefined
  } catch {
    selected = undefined
  }

  if (!selected) {
    const defaults = service(ctx, 'agentDefaultModel')
    if (defaults && typeof defaults.currentSelection === 'function') {
      try {
        selected = defaults.currentSelection()
      } catch {
        selected = undefined
      }
    }
  }

  return selected
    && typeof selected.provider === 'string' && selected.provider !== ''
    && typeof selected.model === 'string' && selected.model !== ''
    ? { provider: selected.provider, model: selected.model }
    : undefined
}

/**
 * 取一个会话对象；服务不可用、取会话出错或拿到的不是对象时返回 undefined。
 * @param ctx - cordis context。
 * @param sessionId - 会话 id。
 */
function sessionOf(ctx, sessionId) {
  const sessions = service(ctx, 'sessions')
  if (!sessions || typeof sessions.get !== 'function') return undefined
  try {
    const session = sessions.get(sessionId)
    return session && typeof session === 'object' ? session : undefined
  } catch {
    return undefined
  }
}

/**
 * 读取当前会话可供参考的对话历史。
 *
 * **这里曾经有一个致命 bug**：早期实现读的是 `session.events`，但 DSH 的
 * `Session` 类**根本没有 `events` 属性**（官方声明只有 `eventAt` /
 * `snapshotEvents` / `ownEvents` / `deriveMessages`）。于是它恒为 `undefined`，
 * 函数恒返回空数组，「按场景动态生成」永远退化成固定兜底句，而且不报错。
 *
 * 现在的正确做法：调用 `deriveMessages()`。
 * - 它是**唯一没有被 `@deprecated` 标记**的历史读取器
 *   （`eventAt`/`snapshotEvents`/`ownEvents` 三者都标注了
 *   "new production calls are prohibited"）。
 * - 它从 surface 派生并已应用消息投影（compaction、fork 等），
 *   所以拿到的就是「模型实际看到的对话」，语义上正是我们要的「场景」。
 *
 * 保留一条退路：若某个版本的 Session 只提供 `snapshotEvents()`，
 * 就退回读事件（`extractRecentTurns` 两种形状都支持）。
 *
 * @param ctx - cordis context。
 * @param sessionId - 会话 id。
 * @returns Message 数组或 SessionEvent 数组；取不到时返回 []。
 */
function sessionHistory(ctx, sessionId) {
  const session = sessionOf(ctx, sessionId)
  if (session === undefined) return []

  // 首选：surface 派生的消息（未废弃，且已应用投影）。
  if (typeof session.deriveMessages === 'function') {
    try {
      const messages = session.deriveMessages()
      if (Array.isArray(messages)) return messages
    } catch {
      // 落到下面的退路，而不是让整个生成失败。
    }
  }

  // 退路：直接读事件快照。注意该 API 在新版中已被标记为不推荐新调用。
  if (typeof session.snapshotEvents === 'function') {
    try {
      const events = session.snapshotEvents()
      if (Array.isArray(events)) return events
    } catch {
      // 继续尝试下一条退路。
    }
  }

  // 最后的退路：部分版本直接把事件数组挂在 `session.events` 上
  // （dsh-prompt-for-me 就是这样读取的）。
  try {
    if (Array.isArray(session.events)) return session.events
  } catch {
    return []
  }

  return []
}

/**
 * 调用模型并收集第一条完整候选。
 *
 * 一旦拿到可用候选就立刻中止流：预填充只需要一句话，没必要把 token 烧完。
 *
 * @param llm - ctx.llm 服务。
 * @param route - { provider, model }。
 * @param args - { sessionId, system, payload, signal, maxTokens, config, stats }。
 *   stats（可选）会被写入：收到的各类片段数量、正文字数与正文开头，供诊断记录使用。
 * @param omitReasoningEffort - 为 true 时不带 `reasoningEffort`（用于退避重试）。
 * @returns 候选文本，或 undefined。
 */
async function streamCandidate(llm, route, args, omitReasoningEffort = false) {
  let buffered = ''
  let candidate

  // `reasoningEffort: 'off'` 能显著降低首字延迟与成本，但不是所有路由都接受：
  // 若某个适配器用 `reasoningEfforts: { off: null, ... }` 声明能力，
  // `resolveCallConfig` 会抛 UNSUPPORTED_REASONING_EFFORT。因此调用方会先带
  // 该字段试一次，失败后再不带它重试一次，而不是直接降级成固定兜底句。
  const effortField = omitReasoningEffort ? {} : { reasoningEffort: 'off' }

  for await (const chunk of llm.stream({
    provider: route.provider,
    model: route.model,
    sessionId: args.sessionId,
    maxTokens: args.maxTokens,
    ...effortField,
    system: args.system,
    messages: [{
      // 用 RequestUserInput 形状：`{ role:'user', content:[...] }`，不带 id 也不带
      // source。这是 `RequestMessage = Message | RequestUserInput` 里那条**故意**
      // 给非持久化、非会话内消息用的分支。
      //
      // 早先这里写的是 `{ id, role, content, source:{ kind:'plugin', plugin } }`，
      // 但 `MessageSourceMap` 里**没有 `plugin` 这个 kind**（只有 user / model /
      // tool / system-prompt / … / goal / schedule 等），那属于已发布的 V3 遗留
      // 形状，只在读取旧日志时被迁移。类型上不合格。
      role: 'user',
      content: [{ type: 'text', text: args.payload }],
    }],
    signal: args.signal,
  })) {
    args.signal.throwIfAborted()
    if (!chunk || typeof chunk !== 'object') continue
    if (chunk.type === 'finish') {
      // **DSH 不会为模型调用失败抛错**：LlmRuntime.stream() 把适配器的任何失败
      // （包括调用前就被拒绝的 UNSUPPORTED_REASONING_EFFORT）都包装成一个
      // `finish` 片段，reason 为 { kind: 'error' | 'aborted', failure: { message, code } }。
      // 早先这里把它当成普通结束，失败于是表现为「正文 0 字、只有 finish」，
      // 去掉 reasoningEffort 重试的逻辑也永远不会触发。现在把它转成真正的错误。
      const reason = chunk.reason
      if (args.stats) args.stats.finish = typeof reason?.kind === 'string' ? reason.kind : '?'
      if (reason && (reason.kind === 'error' || reason.kind === 'aborted')) {
        args.signal.throwIfAborted()
        const failure = reason.failure && typeof reason.failure === 'object' ? reason.failure : {}
        const error = new Error(typeof failure.message === 'string' && failure.message !== ''
          ? failure.message
          : `模型调用失败（${reason.kind}）`)
        if (typeof failure.code === 'string') error.code = failure.code
        if (args.stats) args.stats.failure = `${failure.code ?? reason.kind}: ${error.message}`
        throw error
      }
    }
    if (args.stats) {
      const type = typeof chunk.type === 'string' ? chunk.type : '?'
      args.stats.chunks[type] = (args.stats.chunks[type] ?? 0) + 1
      if (type === 'text-delta' && typeof chunk.text === 'string') {
        args.stats.textChars += chunk.text.length
        if (args.stats.preview.length < 60) args.stats.preview = (args.stats.preview + chunk.text).slice(0, 60)
      }
    }

    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      buffered += chunk.text
    } else if (chunk.type === 'block-end'
      && chunk.block && chunk.block.type === 'text' && typeof chunk.block.text === 'string') {
      if (buffered === '') buffered = chunk.block.text
    } else {
      continue
    }

    // 只在看到换行（即第一条完整行已经结束）时才尝试解析，
    // 避免把半截句子当成完整提示词。
    if (buffered.includes('\n')) {
      const first = buffered.slice(0, buffered.indexOf('\n'))
      const parsed = parseCandidate(first, args.config)
      if (parsed !== undefined) {
        candidate = parsed
        break
      }
      // 第一条是 NONE 之类的无效行：继续累积，交给后续行。
      buffered = buffered.slice(buffered.indexOf('\n') + 1)
    }
    if (utf8Bytes(buffered) > args.config.maxCandidateChars * 8) break
  }

  // 有些适配器在取消后正常结束迭代，不能把留下的半截文本当成候选。
  args.signal.throwIfAborted()
  if (candidate === undefined) {
    candidate = parseCandidate(buffered, args.config)
  }
  return candidate
}

/**
 * 应用插件。
 * @param ctx - 插件行的 cordis context。
 * @param rawConfig - profile patch 层传入的原始配置。
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)

  // **这里曾经导致「完全没有灰字」**：插件 apply 时 webServer 服务未必已经就绪，
  // 直接 ctx.get('webServer') 会拿到 undefined，路由从未注册，浏览器半的请求
  // 一律 404，连兜底提示词都显示不出来。
  // 改为用 ctx.inject 等 webServer 就绪后再注册（与 dsh-prompt-for-me 的做法一致）；
  // 服务重启时 cordis 会自动重新调用回调。
  if (typeof ctx?.inject === 'function') {
    ctx.inject(['webServer'], (hostCtx) => registerRoute(hostCtx, config))
    return
  }
  registerRoute(ctx, config)
}

/**
 * 在 webServer 上注册 RPC 路由。
 * @param ctx - 已确保 webServer 可用的 cordis context。
 * @param config - 已归一化的配置。
 */
function registerRoute(ctx, config) {
  // 兜底提示词的轮换游标：让连续两次兜底给出不同内容，同时保持可复现。
  let fallbackCursor = 0

  const webServer = service(ctx, 'webServer')
  if (!webServer || typeof webServer.register !== 'function') {
    ctx.logger?.warn?.('dsh-prompt-prefill: webServer 服务不可用，插件未注册任何路由')
    return
  }

  /**
   * 最近若干次生成的结果（只在内存里，重启即清空）。
   * 「回答完有时不出灰字」时，靠它区分是被跳过、模型回了 NONE、超时还是出错。
   * 通过 RPC `method: 'diagnostics'` 读取，同时每次都写一行宿主日志。
   */
  const diagnostics = []
  function record(entry) {
    diagnostics.push({ at: new Date().toISOString(), ...entry })
    if (diagnostics.length > MAX_DIAGNOSTICS) diagnostics.shift()
    const turn = entry.turn === undefined ? '' : ` 第 ${entry.turn} 回合`
    const detail = entry.detail === undefined ? '' : ` | ${entry.detail}`
    ctx.logger?.info?.(`dsh-prompt-prefill: 生成${turn} ${entry.result}（${entry.ms}ms）${entry.message ?? ''}${detail}`)
  }

  /** 把一次结果整理成诊断记录需要的字段。 */
  function outcome(reply) {
    return {
      result: reply.ok === true ? (reply.source ?? 'ok') : (reply.code ?? 'failed'),
      message: reply.message ?? reply.reason,
    }
  }

  /**
   * 任何失败路径都会走到这里。
   *
   * 默认（useFallback: false）直接回报「没有候选」，界面上什么都不显示；
   * 只有在配置里打开 useFallback 时才轮换一条兜底提示词。
   */
  function fallback(reason) {
    if (!config.useFallback) return { ok: false, code: 'NO_CANDIDATE', message: reason }
    const picked = pickFallback(config, fallbackCursor)
    fallbackCursor = picked.cursor
    return picked.candidate === undefined
      ? { ok: false, code: 'NO_FALLBACK', message: reason }
      : { ok: true, candidate: picked.candidate, source: 'fallback', reason }
  }

  /**
   * 生成一条建议的完整流程：读历史 → 选模型 → 调模型。不负责回复 HTTP。
   *
   * @param sessionId - 会话 id。
   * @param options.signal - 外部取消（浏览器断开、新回合开始、插件卸载）。
   * @param options.checkLastTurn - 没有回合事件可用时，用末尾消息推断上一轮是否正常结束。
   * @param options.draft - 当前草稿（通常为空）。
   * @returns { reply, detail }：reply 是给浏览器半的结果，detail 是给诊断记录的说明。
   */
  async function produce(sessionId, { signal, checkLastTurn = false, draft = '' } = {}) {
    const history = sessionHistory(ctx, sessionId)
    if (checkLastTurn) {
      const lastTurn = lastTurnState(history)
      if (!lastTurn.completed) {
        // 上一轮出错或被中断：不给建议，也不用兜底句。
        return {
          reply: { ok: false, code: 'SKIPPED', message: '上一轮没有正常结束，跳过建议' },
          detail: `依据：最后一条是 ${lastTurn.basis}`,
        }
      }
    }
    const turns = extractRecentTurns(history, config)
    if (turns.length === 0) {
      // 新会话没有历史：不浪费一次模型调用。
      return {
        reply: fallback('会话还没有可供参考的对话内容'),
        detail: `历史 ${Array.isArray(history) ? history.length : 0} 条`,
      }
    }

    const llm = service(ctx, 'llm')
    if (!llm || typeof llm.stream !== 'function') return { reply: fallback('Harness 没有可用的模型路由') }

    const route = resolveRoute(ctx, sessionOf(ctx, sessionId), config)
    if (!route) return { reply: fallback('没有为当前会话选定模型') }

    const controller = new AbortController()
    const onAbort = () => controller.abort()
    signal?.addEventListener?.('abort', onAbort, { once: true })
    if (signal?.aborted) controller.abort()

    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, config.timeoutMs)

    const stats = { chunks: {}, textChars: 0, preview: '' }
    const describe = () => `模型 ${route.provider}/${route.model}，正文 ${stats.textChars} 字，`
      + `片段 ${JSON.stringify(stats.chunks)}`
      + `${stats.finish === undefined ? '' : `，结束原因 ${stats.finish}`}`
      + `${stats.failure === undefined ? '' : `，错误 ${stats.failure}`}`
      + `${stats.retried ? '，已去掉 reasoningEffort 重试' : ''}`
      + `${stats.preview === '' ? '' : `，开头「${stats.preview}」`}`
    try {
      const callArgs = {
        stats,
        sessionId,
        system: systemPrompt(),
        payload: buildUserPayload({ draft }, turns),
        signal: controller.signal,
        maxTokens: config.maxOutputTokens,
        config,
      }

      let candidate
      try {
        candidate = await withAbort(streamCandidate(llm, route, callArgs), controller.signal)
      } catch (error) {
        // 某些路由声明 `reasoningEfforts: { off: null, … }`，此时带
        // `reasoningEffort: 'off'` 会被拒绝。去掉该字段重试一次，
        // 而不是把一次可恢复的能力协商失败降级成固定兜底句。
        const message = String(error?.message ?? error)
        // 只认这一类错误：错误码，或信息里明确提到 reasoning effort。
        // 早先只要信息里有 reasoning 就重试，会为无关错误多调一次模型。
        if (!controller.signal.aborted
          && (error?.code === 'UNSUPPORTED_REASONING_EFFORT' || /UNSUPPORTED_REASONING_EFFORT|reasoning[\s_-]?effort/i.test(message))) {
          ctx.logger?.warn?.(`dsh-prompt-prefill: 该路由不接受 reasoningEffort=off，改为不带该字段重试（${message}）`)
          stats.retried = true
          stats.failure = undefined
          stats.finish = undefined
          candidate = await withAbort(streamCandidate(llm, route, callArgs, true), controller.signal)
        } else {
          throw error
        }
      }

      if (candidate !== undefined) return { reply: { ok: true, candidate, source: 'model' }, detail: describe() }
      return { reply: fallback(timedOut ? '生成超时' : '模型没有给出可用的提示词'), detail: describe() }
    } catch (error) {
      if (timedOut) return { reply: fallback('生成超时'), detail: describe() }
      if (controller.signal.aborted) {
        // 已经没人等这个结果了：不走兜底，免得白白推进兜底句的轮换。
        return {
          reply: { ok: false, code: 'CANCELLED', message: '请求已取消' },
          detail: '生成被取消（通常是 Agent 又开始回答、切换了会话或开始了新回合）',
        }
      }
      const message = `${String(error?.message ?? error)}${typeof error?.code === 'string' ? `（${error.code}）` : ''}`
      ctx.logger?.warn?.(`dsh-prompt-prefill: 生成失败：${message}`)
      return { reply: fallback(`生成失败：${message}`), detail: describe() }
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      // 取得首行或发生错误后也释放流，不把取消责任只交给 iterator.return()。
      controller.abort()
    }
  }

  /*
   * ---------------- 回合跟踪：由宿主监听回合结束 ----------------
   *
   * 订阅 DSH 的 `session/event`，为每个会话记下最近一次 `turn/end` 的回合号与
   * 结束原因（completed / aborted / error / max-tokens / …）。「上一轮是否正常
   * 完成」从此以 DSH 的记录为准，不再靠末尾消息推断——回答结束后 DSH 插入的
   * 切换模型、压缩上下文等消息不会再造成误判。
   *
   * 生成是**按需**的：回合结束时只记账，等浏览器半来要时才调模型，同一回合
   * 只生成一次、结果缓存。这样 DSH 里用户看不到的会话（如后台子任务）结束回合
   * 时不会白白花钱。新回合开始（`turn/start`）时作废上一轮还没生成完的建议。
   *
   * 该事件在写入日志的过程中同步派发：这里只更新内存，不写任何会话事件。
   * 宿主没有 `ctx.on`（例如测试桩或更旧的版本）时退回浏览器半触发的旧做法。
   */
  const eventDriven = typeof ctx.on === 'function'
  /**
   * sessionId → { turn, kind, stale, generation?: { controller, promise } }，按最近更新排序。
   * stale：这一轮之后又开始了新回合，它的建议已经过时，要等新回合结束。
   */
  const turnsBySession = new Map()
  /** sessionId → 正在等待该会话下一次 turn/end 的回调。 */
  const turnWaiters = new Map()
  /**
   * 收到过任何事件的会话。DSH 按范围过滤派发 session/event：若某个会话的事件
   * 根本没有送到本插件，就不能干等 turn/end，而要立刻退回旧做法。
   * 一个回合进行中会产生很多事件（turn/start、user/message、step/…），
   * 所以回答结束时还没见过这个会话的任何事件，就说明事件没有送达。
   */
  const sessionsSeen = new Set()
  /** 总共收到的 session/event 数量，写进诊断结果。 */
  let eventsReceived = 0

  if (eventDriven) {
    ctx.on('session/event', (session, event) => {
      try {
        const sessionId = session?.id
        if (typeof sessionId !== 'string' || !event || typeof event !== 'object') return
        eventsReceived += 1
        sessionsSeen.delete(sessionId)
        sessionsSeen.add(sessionId)
        if (sessionsSeen.size > MAX_TRACKED_SESSIONS * 5) sessionsSeen.delete(sessionsSeen.values().next().value)
        if (event.type === 'turn/start') {
          const entry = turnsBySession.get(sessionId)
          if (entry !== undefined) {
            entry.stale = true
            entry.generation?.controller.abort()
            entry.generation = undefined
          }
          return
        }
        if (event.type !== 'turn/end') return
        const turn = event.data?.turn
        if (typeof turn !== 'number') return
        const kind = typeof event.data?.reason?.kind === 'string' ? event.data.reason.kind : 'completed'
        turnsBySession.get(sessionId)?.generation?.controller.abort()
        turnsBySession.delete(sessionId)
        turnsBySession.set(sessionId, { turn, kind, stale: false, generation: undefined })
        while (turnsBySession.size > MAX_TRACKED_SESSIONS) {
          const [oldest, entry] = turnsBySession.entries().next().value
          entry.generation?.controller.abort()
          turnsBySession.delete(oldest)
        }
        const waiters = turnWaiters.get(sessionId)
        if (waiters !== undefined) {
          turnWaiters.delete(sessionId)
          for (const wake of waiters) wake()
        }
      } catch (error) {
        // 观察者出错不能影响 DSH 写日志。
        ctx.logger?.warn?.(`dsh-prompt-prefill: 处理回合事件失败：${String(error?.message ?? error)}`)
      }
    })
    ctx.effect(() => () => {
      for (const entry of turnsBySession.values()) entry.generation?.controller.abort()
      turnsBySession.clear()
      for (const waiters of turnWaiters.values()) for (const wake of waiters) wake()
      turnWaiters.clear()
    }, 'dsh-prompt-prefill: 回合跟踪')
  }

  /**
   * 等待会话出现比 afterTurn 更新的回合结束；已经有了就立刻返回。
   * @returns 回合记录；等到超时或请求被取消时返回 undefined。
   */
  function waitForTurn(sessionId, afterTurn, waitMs, signal) {
    const newer = () => {
      const entry = turnsBySession.get(sessionId)
      return entry !== undefined && !entry.stale && entry.turn > afterTurn ? entry : undefined
    }
    const ready = newer()
    if (ready !== undefined || waitMs <= 0 || signal?.aborted) return Promise.resolve(ready)
    return new Promise((resolve) => {
      let settled = false
      const settle = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        turnWaiters.get(sessionId)?.delete(wake)
        signal?.removeEventListener?.('abort', settle)
        resolve(newer())
      }
      const wake = settle
      if (!turnWaiters.has(sessionId)) turnWaiters.set(sessionId, new Set())
      turnWaiters.get(sessionId).add(wake)
      const timer = setTimeout(settle, waitMs)
      signal?.addEventListener?.('abort', settle, { once: true })
    })
  }

  /** 取得某个回合的建议：同一回合只生成一次，结果缓存在回合记录上。 */
  function generationFor(sessionId, entry) {
    if (entry.generation === undefined) {
      const controller = new AbortController()
      const started = Date.now()
      const promise = produce(sessionId, { signal: controller.signal }).then(({ reply, detail }) => {
        record({
          sessionId,
          turn: entry.turn,
          trigger: 'turn-end',
          ms: Date.now() - started,
          ...outcome(reply),
          ...(detail === undefined ? {} : { detail }),
        })
        // 被取消的结果不缓存：同一回合再来要时重新生成。
        if (controller.signal.aborted && entry.generation?.controller === controller) entry.generation = undefined
        return reply
      }, (error) => {
        // 意外异常也不缓存：否则这一回合之后每次来要建议都会拿到同一个失败。
        if (entry.generation?.controller === controller) entry.generation = undefined
        const message = String(error?.message ?? error)
        ctx.logger?.warn?.(`dsh-prompt-prefill: 生成异常：${message}`)
        const reply = { ok: false, code: 'INTERNAL', message: '内部错误' }
        record({
          sessionId,
          turn: entry.turn,
          trigger: 'turn-end',
          ms: Date.now() - started,
          ...outcome(reply),
          detail: message,
        })
        return reply
      })
      entry.generation = { controller, promise }
    }
    return entry.generation.promise
  }

  /** 请求断开（浏览器取消、切换会话）时触发的信号。 */
  function closeSignal(request, response) {
    const controller = new AbortController()
    const onClose = () => controller.abort()
    request.on('aborted', onClose)
    response.on('close', onClose)
    return {
      signal: controller.signal,
      release: () => {
        request.off('aborted', onClose)
        response.off('close', onClose)
      },
    }
  }

  const dispose = webServer.register({
    kind: 'exact',
    path: RPC_PATH,
    handler: async (request, response) => {
      try {
        if (request.method !== 'POST') {
          json(response, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', message: '只接受 POST' })
          return
        }
        if (!sameOrigin(request)) {
          json(response, 403, { ok: false, code: 'ORIGIN_NOT_ALLOWED', message: '拒绝跨源请求' })
          return
        }
        if (!config.enabled) {
          json(response, 200, { ok: false, code: 'DISABLED', message: '插件已关闭' })
          return
        }

        let body
        try {
          body = await readJson(request)
        } catch (error) {
          json(response, 400, {
            ok: false,
            code: 'BAD_REQUEST',
            message: String(error?.message ?? error),
          })
          return
        }

        // 诊断：返回版本、关键配置与最近几次生成的结果。
        if (body && body.method === 'diagnostics') {
          json(response, 200, {
            ok: true,
            version: VERSION,
            trigger: eventDriven ? '宿主监听回合结束' : '浏览器半察觉回答结束（宿主不支持回合事件）',
            config: {
              useFallback: config.useFallback,
              timeoutMs: config.timeoutMs,
              maxOutputTokens: config.maxOutputTokens,
              maxRecentTurns: config.maxRecentTurns,
              route: config.provider !== '' && config.model !== '' ? `${config.provider}/${config.model}` : '跟随当前会话',
            },
            trackedSessions: turnsBySession.size,
            eventsReceived,
            recent: [...diagnostics],
          })
          return
        }

        const sessionId = body && typeof body.sessionId === 'string' ? body.sessionId : ''
        const draft = body && typeof body.draft === 'string' ? body.draft : ''
        if (sessionId === '') {
          json(response, 400, { ok: false, code: 'BAD_REQUEST', message: '缺少 sessionId' })
          return
        }

        // 按 ↑ 回填上一次发送的内容：只读会话历史，不调用模型。
        if (body.method === 'lastSent') {
          const text = lastUserText(sessionHistory(ctx, sessionId))
          json(response, 200, text === undefined
            ? { ok: false, code: 'NO_HISTORY', message: '这个会话还没有发送过消息' }
            : { ok: true, text })
          return
        }

        const started = Date.now()
        const closed = closeSignal(request, response)
        try {
          // 浏览器半察觉回答结束后来要建议：以宿主记录的回合为准。
          // 事件没有送到这个会话（见 sessionsSeen）：不干等，直接退回旧做法。
          const eventsReachSession = eventDriven && sessionsSeen.has(sessionId)
          if (body.method === 'suggestion' && eventsReachSession) {
            const afterTurn = Number.isInteger(body.afterTurn) ? body.afterTurn : -1
            const waitMs = Math.min(Math.max(Number(body.waitMs) || 0, 0), MAX_WAIT_MS)
            const entry = await waitForTurn(sessionId, afterTurn, waitMs, closed.signal)
            if (entry === undefined) {
              const reply = { ok: false, code: 'NO_TURN', message: '没有等到新的回合结束' }
              record({
                sessionId,
                trigger: 'turn-end',
                ms: Date.now() - started,
                ...outcome(reply),
                detail: `已看过第 ${afterTurn} 回合，等待 ${waitMs}ms 内没有收到新的 turn/end`,
              })
              json(response, 200, reply)
              return
            }
            if (entry.kind !== 'completed') {
              const reply = { ok: false, code: 'SKIPPED', message: '上一轮没有正常结束，跳过建议', turn: entry.turn }
              record({
                sessionId,
                turn: entry.turn,
                trigger: 'turn-end',
                ms: Date.now() - started,
                ...outcome(reply),
                detail: `依据：turn/end 的结束原因是 ${entry.kind}`,
              })
              json(response, 200, reply)
              return
            }
            const reply = await generationFor(sessionId, entry)
            json(response, 200, { ...reply, turn: entry.turn })
            return
          }

          // 旧做法（宿主不支持回合事件、事件没有送到这个会话，或旧版浏览器半直接请求生成）：
          // 由浏览器半决定时机，宿主用末尾消息推断上一轮是否正常结束。
          if (body.method === 'suggestion' && !(Number(body.waitMs) > 0)) {
            json(response, 200, { ok: false, code: 'NO_TURN', message: '宿主没有这个会话的回合事件，只在回答结束时生成' })
            return
          }
          const { reply, detail } = await produce(sessionId, { signal: closed.signal, checkLastTurn: true, draft })
          const why = !eventDriven ? '' : `宿主没有收到这个会话的回合事件（共收到 ${eventsReceived} 条事件），退回按末尾消息判断；`
          record({
            sessionId,
            trigger: 'request',
            ms: Date.now() - started,
            ...outcome(reply),
            ...(detail === undefined && why === '' ? {} : { detail: `${why}${detail ?? ''}` }),
          })
          json(response, 200, reply)
        } finally {
          closed.release()
        }
      } catch (error) {
        // 兜底的兜底：handler 自身出错也不能让请求悬空。
        ctx.logger?.warn?.(`dsh-prompt-prefill: RPC 处理异常：${String(error?.message ?? error)}`)
        json(response, 500, { ok: false, code: 'INTERNAL', message: '内部错误' })
      }
    },
  })

  ctx.effect(() => dispose, 'dsh-prompt-prefill: rpc 路由')

  ctx.logger?.info?.(
    `dsh-prompt-prefill: 已注册 ${RPC_PATH}（${config.enabled ? '已启用' : '已关闭'}，`
    + `路由 ${config.provider !== '' && config.model !== '' ? `${config.provider}/${config.model}` : '跟随当前会话'}，`
    + `${eventDriven ? '宿主监听回合结束' : '浏览器半触发'}）`,
  )
}

/** 仅供测试使用，不属于插件对外接口。 */
export const __internals = { resolveRoute, RPC_PATH, MAX_REQUEST_BYTES }
