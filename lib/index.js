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

import {
  buildUserPayload,
  extractRecentTurns,
  lastTurnCompleted,
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

/** 交给模型的输出只取第一条完整行，因此不需要等整个流结束。 */

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
  const sessions = service(ctx, 'sessions')
  if (!sessions || typeof sessions.get !== 'function') return []
  let session
  try {
    session = sessions.get(sessionId)
  } catch {
    return []
  }
  if (!session || typeof session !== 'object') return []

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
 * @param args - { sessionId, system, payload, signal, maxTokens, config }。
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

        const sessionId = body && typeof body.sessionId === 'string' ? body.sessionId : ''
        const draft = body && typeof body.draft === 'string' ? body.draft : ''
        if (sessionId === '') {
          json(response, 400, { ok: false, code: 'BAD_REQUEST', message: '缺少 sessionId' })
          return
        }

        const history = sessionHistory(ctx, sessionId)
        if (!lastTurnCompleted(history)) {
          // 上一轮出错或被中断：不给建议，也不用兜底句。
          json(response, 200, { ok: false, code: 'SKIPPED', message: '上一轮没有正常结束，跳过建议' })
          return
        }
        const turns = extractRecentTurns(history, config)
        if (turns.length === 0) {
          // 新会话没有历史：不浪费一次模型调用。
          json(response, 200, fallback('会话还没有可供参考的对话内容'))
          return
        }

        const llm = service(ctx, 'llm')
        if (!llm || typeof llm.stream !== 'function') {
          json(response, 200, fallback('Harness 没有可用的模型路由'))
          return
        }

        const sessions = service(ctx, 'sessions')
        const session = sessions && typeof sessions.get === 'function' ? sessions.get(sessionId) : undefined
        const route = resolveRoute(ctx, session, config)
        if (!route) {
          json(response, 200, fallback('没有为当前会话选定模型'))
          return
        }

        const controller = new AbortController()
        const onClientClose = () => controller.abort()
        request.on('aborted', onClientClose)
        response.on('close', onClientClose)

        let timedOut = false
        const timer = setTimeout(() => {
          timedOut = true
          controller.abort()
        }, config.timeoutMs)

        try {
          const callArgs = {
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
            if (!controller.signal.aborted && /reasoning/i.test(message)) {
              ctx.logger?.warn?.(`dsh-prompt-prefill: 该路由不接受 reasoningEffort=off，改为不带该字段重试（${message}）`)
              candidate = await withAbort(streamCandidate(llm, route, callArgs, true), controller.signal)
            } else {
              throw error
            }
          }

          if (candidate !== undefined) {
            json(response, 200, { ok: true, candidate, source: 'model' })
            return
          }
          json(response, 200, fallback(timedOut ? '生成超时' : '模型没有给出可用的提示词'))
        } catch (error) {
          if (timedOut) {
            json(response, 200, fallback('生成超时'))
            return
          }
          // 客户端主动断开是正常路径，不必记为异常。
          const message = String(error?.message ?? error)
          if (controller.signal.aborted && !timedOut) {
            if (!response.destroyed && !response.writableEnded) {
              json(response, 200, fallback('请求已取消'))
            }
            return
          }
          ctx.logger?.warn?.(`dsh-prompt-prefill: 生成失败：${message}`)
          json(response, 200, fallback(`生成失败：${message}`))
        } finally {
          clearTimeout(timer)
          request.off('aborted', onClientClose)
          response.off('close', onClientClose)
          // 取得首行或发生错误后也释放流，不把取消责任只交给 iterator.return()。
          controller.abort()
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
    + `路由 ${config.provider !== '' && config.model !== '' ? `${config.provider}/${config.model}` : '跟随当前会话'}）`,
  )
}

/** 仅供测试使用，不属于插件对外接口。 */
export const __internals = { resolveRoute, RPC_PATH, MAX_REQUEST_BYTES }
