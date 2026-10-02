/**
 * 宿主半测试：用桩 ctx 跑 apply()，验证路由注册、同源校验、
 * 模型调用、兜底降级与异常隔离。
 *
 * 运行：node test/host.test.mjs
 */

import { apply, name, __internals } from '../lib/index.js'

let failures = 0
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${label}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

/** 构造一个可编程的假 webServer 与 ctx。 */
function makeHarness(options = {}) {
  const warnings = []
  const infos = []
  let route
  let disposal

  const webServer = {
    register(next) {
      route = next
      return () => { route = undefined }
    },
  }

  const ctx = {
    logger: { warn: (message) => warnings.push(message), info: (message) => infos.push(message) },
    get(serviceName) {
      // webServer 是宿主半通过 ctx.get 读取的可选服务，必须从这里暴露。
      if (serviceName === 'webServer') return webServer
      return options.services?.[serviceName]
    },
    effect(factory) {
      disposal = factory()
    },
    webServer,
  }

  // 既有用例检验兜底轮换本身，因此在测试里显式打开 useFallback；
  // 默认关闭时的行为由「默认不用兜底句」一节单独覆盖（传 useFallback: false）。
  apply(ctx, { useFallback: true, ...options.config })
  return {
    warnings,
    infos,
    get route() { return route },
    dispose: () => disposal?.(),
  }
}

/** 构造一个假 HTTP 请求/响应。 */
function makeExchange(body, headers = {}) {
  const listeners = new Map()
  const request = {
    method: 'POST',
    socket: { remoteAddress: '127.0.0.1', encrypted: false },
    headers: { host: '127.0.0.1:19387', ...headers },
    destroyed: false,
    on(event, handler) {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
      return request
    },
    off(event, handler) {
      const list = listeners.get(event) ?? []
      listeners.set(event, list.filter((item) => item !== handler))
      return request
    },
    destroy() { request.destroyed = true },
    /** 触发请求体。 */
    send(payload) {
      const text = typeof payload === 'string' ? payload : JSON.stringify(payload)
      for (const handler of listeners.get('data') ?? []) handler(Buffer.from(text, 'utf8'))
      for (const handler of listeners.get('end') ?? []) handler()
    },
  }

  const response = {
    status: null,
    headers: null,
    body: '',
    destroyed: false,
    writableEnded: false,
    writeHead(status, responseHeaders) {
      response.status = status
      response.headers = responseHeaders
      return response
    },
    end(chunk) {
      response.writableEnded = true
      response.body += chunk ?? ''
      return response
    },
    on() { return response },
    off() { return response },
  }

  return { request, response, reply: async () => JSON.parse(response.body || 'null') }
}

/** 让路由处理完一次请求。 */
async function invoke(harness, payload, headers) {
  const exchange = makeExchange(payload, headers)
  const task = Promise.resolve(harness.route.handler(exchange.request, exchange.response))
  exchange.request.send(payload ?? {})
  await task
  return exchange
}

/** 造一段会话事件。 */
function turns(...texts) {
  return texts.map((text, index) => (index % 2 === 0
    ? { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } }
    : { type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } }))
}

/** 造一个假的 llm.stream，逐块产出文本。 */
function fakeLlm(chunks, onCall) {
  return {
    stream(options) {
      onCall?.(options)
      return (async function* generate() {
        for (const chunk of chunks) yield chunk
      })()
    },
  }
}

/**
 * 把 SessionEvent 形状转成 Message 形状。
 *
 * 真实 DSH 的 `Session.deriveMessages()` 返回的是 `Message`（`{ role, content, source }`），
 * 不是事件。这个转换让既有的 `turns(...)` 构造器继续可用，同时保证 fake 拿出来的
 * 东西形状是真的。
 */
function eventsToMessages(events) {
  const messages = []
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type === 'user/message' && event.data) {
      messages.push({ role: 'user', content: event.data.content, source: event.data.source })
    } else if (event?.type === 'assistant/message' && event.data?.message) {
      messages.push({ role: 'assistant', content: event.data.message.content, source: { kind: 'model' } })
    }
  }
  return messages
}

/**
 * 造一个假 sessions 服务，**刻意复刻真实 `Session` 的形状**。
 *
 * 关键约束：真实 `Session` 类**没有 `events` 属性**（官方声明只有
 * `deriveMessages()` / `snapshotEvents()` / `ownEvents()` / `eventAt()`）。
 * 早先这个 fake 返回 `{ events }`，于是测试通过、线上却永远走兜底——
 * 测试把 bug 固化成期望。现在 fake 暴露 `deriveMessages()`，
 * 并且故意**不**提供 `events`，从而任何「再去读 session.events」的回归都会被测出来。
 *
 * @param events - 用 turns(...) 造的事件数组，会被转成 messages。
 * @param session - 额外要覆盖的 Session 成员（如 requestHeader）。
 */
function fakeSessions(events, session = {}) {
  const messages = eventsToMessages(events)
  return {
    get: () => ({
      deriveMessages: () => messages,
      snapshotEvents: () => events,
      ...session,
    }),
  }
}

/** 造一个只有旧式 API 的假会话，用于验证 `snapshotEvents()` 退路。 */
function fakeLegacySessions(events, session = {}) {
  return {
    get: () => ({
      snapshotEvents: () => events,
      ...session,
    }),
  }
}

console.log('插件契约')
check('插件名正确', name === 'dsh-prompt-prefill', name)
check('RPC 路径已导出', __internals.RPC_PATH === '/dsh-prompt-prefill/rpc')

console.log('\n路由注册')
{
  const harness = makeHarness()
  check('注册了一个 exact 路由', harness.route?.kind === 'exact', harness.route?.kind)
  check('路由路径正确', harness.route?.path === '/dsh-prompt-prefill/rpc')
  check('注册了 info 日志', harness.infos.length === 1, JSON.stringify(harness.infos))

  const noServer = { logger: { warn: (m) => noServer.logged.push(m) }, logged: [] }
  let threw = false
  try {
    apply(noServer, {})
  } catch {
    threw = true
  }
  check('没有 webServer 时安静降级', threw === false && noServer.logged.length === 1)

  // 真实 cordis：apply 时 webServer 可能还没就绪，必须等 ctx.inject 回调再注册。
  // 曾经因为直接 ctx.get('webServer') 拿到 undefined 而从不注册路由（界面上完全没有灰字）。
  const pending = []
  const routes = []
  const lateCtx = {
    logger: { info() {}, warn() {} },
    inject(deps, callback) { pending.push({ deps, callback }) },
    get() { return undefined },
  }
  apply(lateCtx, {})
  check('通过 ctx.inject 等待 webServer', pending.length === 1 && pending[0].deps.includes('webServer'), JSON.stringify(pending.map((x) => x.deps)))
  check('webServer 就绪前不注册路由', routes.length === 0)
  pending[0]?.callback({
    logger: { info() {}, warn() {} },
    effect() {},
    get(serviceName) {
      return serviceName === 'webServer' ? { register: (route) => { routes.push(route); return () => {} } } : undefined
    },
  })
  check('webServer 就绪后注册路由', routes.length === 1 && routes[0].path === '/dsh-prompt-prefill/rpc')
}

console.log('\n请求校验')
{
  const harness = makeHarness({ services: { sessions: fakeSessions(turns('你好')) } })

  const wrongMethod = makeExchange({})
  wrongMethod.request.method = 'GET'
  await harness.route.handler(wrongMethod.request, wrongMethod.response)
  check('拒绝非 POST', wrongMethod.response.status === 405, String(wrongMethod.response.status))

  const crossOrigin = await invoke(harness, { sessionId: 's1' }, { origin: 'http://evil.example' })
  check('拒绝跨源请求', crossOrigin.response.status === 403, String(crossOrigin.response.status))

  const sameOriginOk = await invoke(harness, { sessionId: 's1' }, { origin: 'http://127.0.0.1:19387' })
  check('同源请求被接受', sameOriginOk.response.status !== 403, String(sameOriginOk.response.status))

  // 桌面端真实情形：Electron 会把 dsh-app://app/… 的请求转发到回环 webServer，
  // 并在转发时**删掉** origin / host / sec-fetch-site，再补上自己的 cookie。
  // 因此端点看到的通常没有 Origin，Host 是回环地址 —— 必须放行。
  const desktopForwarded = await invoke(harness, { sessionId: 's1' }, {
    host: '127.0.0.1:19387',
  })
  check('桌面端转发（无 Origin、回环 Host）被接受',
    desktopForwarded.response.status !== 403, String(desktopForwarded.response.status))

  // 但一旦 Harness 被暴露到非回环地址，即使 Origin 与 Host 自洽也必须拒绝：
  // 否则同网段的任意页面都能打到这个端点。
  const nonLoopback = await invoke(harness, { sessionId: 's1' }, {
    host: '192.168.1.50:19387',
    origin: 'http://192.168.1.50:19387',
  })
  check('非回环 Host 一律拒绝', nonLoopback.response.status === 403, String(nonLoopback.response.status))

  const crossSite = await invoke(harness, { sessionId: 's1' }, {
    host: '127.0.0.1:19387',
    origin: 'http://127.0.0.1:19387',
    'sec-fetch-site': 'cross-site',
  })
  check('Sec-Fetch-Site: cross-site 被拒绝', crossSite.response.status === 403, String(crossSite.response.status))

  const localhostOk = await invoke(harness, { sessionId: 's1' }, {
    host: 'localhost:19387',
    origin: 'http://localhost:19387',
  })
  check('localhost 也算回环', localhostOk.response.status !== 403, String(localhostOk.response.status))

  const ipv6Ok = await invoke(harness, { sessionId: 's1' }, {
    host: '[::1]:19387',
    origin: 'http://[::1]:19387',
  })
  check('IPv6 回环被接受', ipv6Ok.response.status !== 403, String(ipv6Ok.response.status))

  const portMismatch = await invoke(harness, { sessionId: 's1' }, {
    host: '127.0.0.1:19387',
    origin: 'http://127.0.0.1:9999',
  })
  check('端口不同的 Origin 被拒绝', portMismatch.response.status === 403, String(portMismatch.response.status))

  const noHost = await invoke(harness, { sessionId: 's1' }, { host: '' })
  check('没有 Host 头时拒绝', noHost.response.status === 403, String(noHost.response.status))

  const badJson = await invoke(harness, 'not json at all')
  check('拒绝非法 JSON', badJson.response.status === 400, String(badJson.response.status))

  const noSession = await invoke(harness, {})
  check('缺少 sessionId 时报错', noSession.response.status === 400, String(noSession.response.status))

  const disabled = makeHarness({ config: { enabled: false } })
  const off = await invoke(disabled, { sessionId: 's1' })
  check('关闭后返回 DISABLED', (await off.reply()).code === 'DISABLED', off.response.body)
}

console.log('\n兜底路径')
{
  // 新会话没有历史事件
  const empty = makeHarness({ services: { sessions: fakeSessions([]) } })
  const noContext = await invoke(empty, { sessionId: 's1' })
  const noContextBody = await noContext.reply()
  check('无历史时走兜底', noContextBody.ok === true && noContextBody.source === 'fallback', noContext.response.body)
  check('兜底返回了提示词', typeof noContextBody.candidate === 'string' && noContextBody.candidate !== '')

  const second = await invoke(empty, { sessionId: 's1' })
  const secondBody = await second.reply()
  check('兜底提示词会轮换', secondBody.candidate !== noContextBody.candidate, `${noContextBody.candidate} / ${secondBody.candidate}`)

  // 有历史但没有 llm 服务
  const noLlm = makeHarness({ services: { sessions: fakeSessions(turns('你好', '你好呀')) } })
  const noLlmReply = await (await invoke(noLlm, { sessionId: 's1' })).reply()
  check('没有 llm 服务时走兜底', noLlmReply.ok === true && noLlmReply.source === 'fallback', JSON.stringify(noLlmReply))

  // 有历史、有 llm，但没有可用路由
  const noRoute = makeHarness({
    services: {
      sessions: fakeSessions(turns('你好', '你好呀')),
      llm: fakeLlm([{ type: 'text-delta', text: '请继续\n' }]),
    },
  })
  const noRouteReply = await (await invoke(noRoute, { sessionId: 's1' })).reply()
  check('没有模型路由时走兜底', noRouteReply.ok === true && noRouteReply.source === 'fallback', JSON.stringify(noRouteReply))
}

console.log('\n默认不用兜底句（与 Claude Code 一致）')
{
  const quiet = makeHarness({ config: { useFallback: false }, services: { sessions: fakeSessions([]) } })
  const reply = await (await invoke(quiet, { sessionId: 's1' })).reply()
  check('默认失败时不返回候选', reply.ok === false && reply.candidate === undefined, JSON.stringify(reply))
  check('默认失败时说明原因', reply.code === 'NO_CANDIDATE' && typeof reply.message === 'string', JSON.stringify(reply))

  // 不经过测试 harness 的默认值：直接用空配置调用 apply。
  let route
  apply({
    logger: { info() {}, warn() {} },
    effect() {},
    get: (serviceName) => (serviceName === 'webServer'
      ? { register: (next) => { route = next; return () => {} } }
      : serviceName === 'sessions' ? fakeSessions([]) : undefined),
  }, {})
  const exchange = makeExchange({ sessionId: 's1' })
  const task = Promise.resolve(route.handler(exchange.request, exchange.response))
  exchange.request.send({ sessionId: 's1' })
  await task
  check('空配置下默认关闭兜底', (await exchange.reply()).code === 'NO_CANDIDATE', exchange.response.body)
}

console.log('\n上一轮没有正常结束时跳过')
{
  let calls = 0
  const llm = fakeLlm([{ type: 'text-delta', text: '请继续\n' }], () => { calls += 1 })
  const header = { requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) }

  // 最后一条是用户消息：助手没有给出回复（出错或被中断）。
  const unanswered = makeHarness({ services: { sessions: fakeSessions(turns('你好', '你好呀', '再写一个'), header), llm } })
  const skipped = await (await invoke(unanswered, { sessionId: 's1' })).reply()
  check('助手没回复时跳过', skipped.ok === false && skipped.code === 'SKIPPED', JSON.stringify(skipped))
  check('跳过时不用兜底句', skipped.candidate === undefined)
  check('跳过时不调用模型', calls === 0, String(calls))

  // 旧式事件：turn/end 的 reason 不是 completed。
  const failedEvents = [...turns('你好', '你好呀'), { type: 'turn/end', data: { reason: { kind: 'error' } } }]
  const failed = makeHarness({ services: { sessions: fakeLegacySessions(failedEvents, header), llm } })
  const failedReply = await (await invoke(failed, { sessionId: 's1' })).reply()
  check('turn/end 报错时跳过', failedReply.code === 'SKIPPED', JSON.stringify(failedReply))

  const okEvents = [...turns('你好', '你好呀'), { type: 'turn/end', data: { reason: { kind: 'completed' } } }]
  const completed = makeHarness({ services: { sessions: fakeLegacySessions(okEvents, header), llm } })
  const completedReply = await (await invoke(completed, { sessionId: 's1' })).reply()
  check('正常结束时照常生成', completedReply.ok === true && completedReply.source === 'model', JSON.stringify(completedReply))
}

console.log('\n模型生成')
{
  let seen
  const services = {
    sessions: fakeSessions(turns('请帮我写一个排序函数', '好的，这是实现')),
    llm: fakeLlm([
      { type: 'text-delta', text: '请把' },
      { type: 'text-delta', text: '时间复杂度' },
      { type: 'text-delta', text: '降到 O(n log n)\n' },
      { type: 'text-delta', text: '这一行不应被采用' },
    ], (options) => { seen = options }),
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-chat' }) },
  }
  const harness = makeHarness({ services })
  const result = await (await invoke(harness, { sessionId: 's1', draft: '' })).reply()

  check('返回模型生成的候选', result.ok === true && result.source === 'model', JSON.stringify(result))
  check('候选为第一条完整行', result.candidate === '请把时间复杂度降到 O(n log n)', result.candidate)
  check('调用了 llm.stream', seen !== undefined)
  check('使用解析出的路由', seen?.provider === 'deepseek-official' && seen?.model === 'deepseek-chat')
  check('携带 sessionId', seen?.sessionId === 's1')
  check('关闭推理以达到低延迟', seen?.reasoningEffort === 'off')
  check('限制输出 token', typeof seen?.maxTokens === 'number' && seen.maxTokens > 0)
  // 用 RequestUserInput 形状：role + content，不带 id、不带 source。
  // 早先这里断言的是 `source.kind === 'plugin'`，但 MessageSourceMap 里
  // 没有 `plugin` 这个 kind（那是已废弃的 V3 遗留形状）。
  check('消息用 RequestUserInput 形状（无 id / 无 source）',
    seen?.messages?.[0]?.role === 'user'
    && seen?.messages?.[0]?.id === undefined
    && seen?.messages?.[0]?.source === undefined,
    JSON.stringify(seen?.messages?.[0]))
  check('消息内容是文本块', seen?.messages?.[0]?.content?.[0]?.type === 'text')
  check('消息内容是 JSON payload', (() => {
    try {
      JSON.parse(seen.messages[0].content[0].text)
      return true
    } catch {
      return false
    }
  })())
}

console.log('\n模型异常与降级')
{
  const throwing = {
    sessions: fakeSessions(turns('你好', '你好呀')),
    llm: { stream: () => (async function* generate() { throw new Error('模型炸了') })() },
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
  }
  const harness = makeHarness({ services: throwing })
  const result = await (await invoke(harness, { sessionId: 's1' })).reply()
  check('模型抛错时降级为兜底', result.ok === true && result.source === 'fallback', JSON.stringify(result))
  check('异常被记录为 warn', harness.warnings.some((message) => message.includes('模型炸了')), JSON.stringify(harness.warnings))

  // 路由不接受 reasoningEffort='off' 时，应当去掉该字段重试一次，
  // 而不是把一次能力协商失败直接降级成固定兜底句。
  const effortCalls = []
  const rejectsOff = {
    sessions: fakeSessions(turns('你好', '你好呀')),
    llm: {
      stream(options) {
        effortCalls.push(options.reasoningEffort)
        if (options.reasoningEffort !== undefined) {
          return (async function* generate() {
            throw new Error('UNSUPPORTED_REASONING_EFFORT: off is not supported by this route')
          })()
        }
        return (async function* generate() {
          yield { type: 'text-delta', text: '去掉 effort 之后成功\n' }
        })()
      },
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
  }
  const effortHarness = makeHarness({ services: rejectsOff })
  const effortResult = await (await invoke(effortHarness, { sessionId: 's1' })).reply()
  check('reasoningEffort=off 被拒后重试成功',
    effortResult.source === 'model' && effortResult.candidate === '去掉 effort 之后成功',
    JSON.stringify(effortResult))
  check('先带 off、再不带 effort 各调用一次',
    effortCalls.length === 2 && effortCalls[0] === 'off' && effortCalls[1] === undefined,
    JSON.stringify(effortCalls))

  const noneReply = {
    sessions: fakeSessions(turns('你好', '你好呀')),
    llm: fakeLlm([{ type: 'text-delta', text: 'NONE\n' }]),
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
  }
  const noneHarness = makeHarness({ services: noneReply })
  const noneResult = await (await invoke(noneHarness, { sessionId: 's1' })).reply()
  check('NONE 输出降级为兜底', noneResult.source === 'fallback', JSON.stringify(noneResult))

  const blockEndOnly = {
    sessions: fakeSessions(turns('你好', '你好呀')),
    llm: fakeLlm([{ type: 'block-end', block: { type: 'text', text: '只给整块的输出' } }]),
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
  }
  const blockHarness = makeHarness({ services: blockEndOnly })
  const blockResult = await (await invoke(blockHarness, { sessionId: 's1' })).reply()
  check('支持 block-end 整块输出', blockResult.candidate === '只给整块的输出', JSON.stringify(blockResult))
}

console.log('\n配置与路由解析')
{
  const harness = makeHarness({
    config: { provider: 'fixed-provider', model: 'fixed-model' },
    services: {
      sessions: fakeSessions(turns('你好', '你好呀')),
      llm: fakeLlm([{ type: 'text-delta', text: '结果\n' }]),
      agentDefaultModel: { currentSelection: () => ({ provider: 'default-p', model: 'default-m' }) },
    },
  })
  let seen
  harness.route // 触发 getter
  const fixed = makeHarness({
    config: { provider: 'fixed-provider', model: 'fixed-model' },
    services: {
      sessions: fakeSessions(turns('你好', '你好呀')),
      llm: fakeLlm([{ type: 'text-delta', text: '结果\n' }], (options) => { seen = options }),
      agentDefaultModel: { currentSelection: () => ({ provider: 'default-p', model: 'default-m' }) },
    },
  })
  await invoke(fixed, { sessionId: 's1' })
  check('显式配置的 provider/model 优先', seen?.provider === 'fixed-provider' && seen?.model === 'fixed-model')

  // 会话的 requestHeader 优先于默认模型
  const viaSession = makeHarness({
    services: {
      sessions: fakeSessions(turns('你好', '你好呀'), {
        requestHeader: () => ({ config: { provider: 'session-p', model: 'session-m' } }),
      }),
      llm: fakeLlm([{ type: 'text-delta', text: '结果\n' }], (options) => { seen = options }),
      agentDefaultModel: { currentSelection: () => ({ provider: 'default-p', model: 'default-m' }) },
    },
  })
  await invoke(viaSession, { sessionId: 's1' })
  check('会话路由优先于默认模型', seen?.provider === 'session-p' && seen?.model === 'session-m')

  // requestHeader 抛错时回退到默认模型
  const brokenHeader = makeHarness({
    services: {
      sessions: fakeSessions(turns('你好', '你好呀'), {
        requestHeader: () => { throw new Error('header 不可用') },
      }),
      llm: fakeLlm([{ type: 'text-delta', text: '结果\n' }], (options) => { seen = options }),
      agentDefaultModel: { currentSelection: () => ({ provider: 'default-p', model: 'default-m' }) },
    },
  })
  await invoke(brokenHeader, { sessionId: 's1' })
  check('requestHeader 抛错时回退到默认模型', seen?.provider === 'default-p' && seen?.model === 'default-m')

  // 会话没有任何可读历史 API：此时确实应当走兜底（而不是崩溃）。
  const noHistoryApi = makeHarness({ services: { sessions: { get: () => ({}) } } })
  const noHistory = await (await invoke(noHistoryApi, { sessionId: 's1' })).reply()
  check('会话没有任何历史读取器时走兜底', noHistory.source === 'fallback')

  // 回归护栏：真实 Session 没有 `events` 属性。若实现又退回去读
  // `session.events`，下面这条会失败——因为 fake 只提供 deriveMessages()。
  let seenDerived
  const derivesOnly = makeHarness({
    services: {
      sessions: fakeSessions(turns('你好', '你好呀')),
      llm: fakeLlm([{ type: 'text-delta', text: '来自派生消息的候选\n' }], (options) => { seenDerived = options }),
      agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    },
  })
  const derived = await (await invoke(derivesOnly, { sessionId: 's1' })).reply()
  check('通过 deriveMessages() 能拿到历史并真正调用模型',
    derived.ok === true && derived.source === 'model' && derived.candidate === '来自派生消息的候选',
    JSON.stringify(derived))
  check('确实把历史发给了模型', typeof seenDerived?.messages?.[0]?.content?.[0]?.text === 'string')
  check('发给模型的历史里含最近对话',
    String(seenDerived?.messages?.[0]?.content?.[0]?.text).includes('你好呀'))

  // 只有旧式 snapshotEvents() 的会话：走退路也要能工作。
  const legacy = makeHarness({
    services: {
      sessions: fakeLegacySessions(turns('你好', '你好呀')),
      llm: fakeLlm([{ type: 'text-delta', text: '来自事件快照的候选\n' }]),
      agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    },
  })
  const legacyResult = await (await invoke(legacy, { sessionId: 's1' })).reply()
  check('只有 snapshotEvents() 时退路仍可用',
    legacyResult.source === 'model' && legacyResult.candidate === '来自事件快照的候选',
    JSON.stringify(legacyResult))
}

console.log('\n隔离性')
{
  const hostile = {
    logger: { warn: () => {} },
    get(serviceName) {
      if (serviceName === 'sessions') return { get: () => { throw new Error('sessions 炸了') } }
      return undefined
    },
    effect() {},
    webServer: { register: () => () => {} },
  }
  let threw = false
  try {
    apply(hostile, {})
  } catch {
    threw = true
  }
  check('服务不可用不影响插件加载', threw === false)
}

console.log('\n超时与流释放回归')
{
  const guard = makeHarness()
  for (const peer of ['192.168.1.10', '::ffff:192.168.1.10']) {
    const remote = makeExchange({ sessionId: 's1' })
    remote.request.socket.remoteAddress = peer
    const remoteTask = guard.route.handler(remote.request, remote.response)
    remote.request.send({ sessionId: 's1' })
    await remoteTask
    check(`远端 ${peer} 伪造回环 Host 仍被拒绝`, remote.response.status === 403)
  }
  const mapped = makeExchange({ sessionId: 's1' })
  mapped.request.socket.remoteAddress = '::ffff:127.0.0.1'
  const mappedTask = guard.route.handler(mapped.request, mapped.response)
  mapped.request.send({ sessionId: 's1' })
  await mappedTask
  check('IPv4 映射回环地址仍可使用', mapped.response.status === 200)
  const scheme = makeExchange({ sessionId: 's1' }, { origin: 'https://127.0.0.1:19387' })
  const schemeTask = guard.route.handler(scheme.request, scheme.response)
  scheme.request.send({ sessionId: 's1' })
  await schemeTask
  check('HTTP 请求不能用 HTTPS Origin 自证同源', scheme.response.status === 403)

  let stuckSignal
  const stuck = makeHarness({
    config: { timeoutMs: 5 },
    services: {
      sessions: fakeSessions(turns('你好', '你好呀')),
      agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
      llm: { stream: (options) => (async function* () {
        stuckSignal = options.signal
        await new Promise(() => {})
      })() },
    },
  })
  let deadline
  const stalled = await Promise.race([
    invoke(stuck, { sessionId: 's1' }),
    new Promise((resolve) => { deadline = setTimeout(() => resolve(null), 100) }),
  ])
  clearTimeout(deadline)
  check('适配器不响应 abort 时 RPC 仍按超时返回', stalled !== null)
  const stalledBody = stalled ? await stalled.reply() : null
  check('超时返回兜底而非悬空', stalledBody?.source === 'fallback')
  check('超时向适配器发出取消信号', stuckSignal?.aborted === true)

  const graceful = makeHarness({
    config: { timeoutMs: 5 },
    services: {
      sessions: fakeSessions(turns('你好', '你好呀')),
      agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
      llm: { stream: (options) => (async function* () {
        yield { type: 'text-delta', text: '尚未生成完整的' }
        await new Promise((resolve) => options.signal.addEventListener('abort', resolve, { once: true }))
      })() },
    },
  })
  const partial = await (await invoke(graceful, { sessionId: 's1' })).reply()
  check('适配器取消后正常结束也不采纳半截文本', partial.source === 'fallback', JSON.stringify(partial))

  let successfulSignal
  const successful = makeHarness({
    services: {
      sessions: fakeSessions(turns('你好', '你好呀')),
      agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
      llm: fakeLlm([{ type: 'text-delta', text: '完成的候选\n' }], (options) => { successfulSignal = options.signal }),
    },
  })
  const candidate = await (await invoke(successful, { sessionId: 's1' })).reply()
  check('成功返回候选', candidate.candidate === '完成的候选')
  check('成功后释放底层流信号', successfulSignal?.aborted === true)
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exitCode = failures === 0 ? 0 : 1
