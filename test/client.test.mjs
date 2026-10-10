/**
 * 浏览器半测试。
 *
 * 这里没有真实浏览器，所以自建了一套最小运行时：
 * - 一个**真的会执行** hooks（useRef / useReducer / useEffect）的微型 React；
 * - 一个只实现必要选择器的微型 DOM（[data-composer-card] / [data-composer-input]）；
 * - 一个可控的 fetch 与事件派发。
 *
 * 目的是验证真正的验收标准：草稿为空且输入框聚焦时按 → 会调用
 * `inputActions.setDraft(...)` 写入候选提示词；以及各种情况下幽灵文本的显隐。
 *
 * 运行：node test/client.test.mjs
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

let failures = 0
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${label}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

/* ------------------------------------------------------------------ *
 * 微型 DOM
 * ------------------------------------------------------------------ */

function matches(element, selector) {
  if (selector === '[data-composer-card]') return element.dataset.composerCard === true
  if (selector === '[data-composer-input]') return element.dataset.composerInput === true
  if (selector === 'textarea') return element.tagName === 'TEXTAREA'
  if (selector.startsWith('style[')) return element.tagName === 'STYLE'
  return false
}

function makeElement(tagName) {
  const upper = tagName.toUpperCase()
  const element = {
    tagName: upper,
    style: {},
    dataset: {},
    hidden: false,
    textContent: '',
    children: [],
    parentNode: null,
    appendChild(child) {
      child.parentNode = element
      element.children.push(child)
      return child
    },
    closest(selector) {
      let node = element
      while (node) {
        if (matches(node, selector)) return node
        node = node.parentNode
      }
      return null
    },
    querySelector(selector) {
      const stack = [...element.children]
      while (stack.length > 0) {
        const node = stack.shift()
        if (matches(node, selector)) return node
        stack.push(...node.children)
      }
      return null
    },
    querySelectorAll(selector) {
      const found = []
      const stack = [...element.children]
      while (stack.length > 0) {
        const node = stack.shift()
        if (matches(node, selector)) found.push(node)
        stack.push(...node.children)
      }
      return found
    },
    getBoundingClientRect() {
      return { left: 10, top: 20, width: 600, height: 80, right: 610, bottom: 100 }
    },
    /** 属性袋：兼容 getAttribute('contenteditable') 这类读取。 */
    attributes: {},
    setAttribute(name, value) {
      element.attributes[name] = String(value)
      return element
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(element.attributes, name)
        ? element.attributes[name]
        : null
    },
    removeAttribute(name) { delete element.attributes[name] },
    /** 是否包含某节点（用于焦点落在输入框子节点时的判定）。 */
    contains(node) {
      let cursor = node
      while (cursor) {
        if (cursor === element) return true
        cursor = cursor.parentNode
      }
      return false
    },
    addEventListener() {},
    removeEventListener() {},
  }
  // 只有真正的 <textarea> 才有 .value；contentEditable div 没有该属性。
  // 这个差别正是插件必须同时兼容两种形态的原因，因此桩件也要如实模拟。
  if (upper === 'TEXTAREA') element.value = ''
  return element
}

/* ------------------------------------------------------------------ *
 * 微型 React：真正运行 hooks
 * ------------------------------------------------------------------ */

function createReact() {
  let slots = []
  let cursor = 0
  let active = null

  function resetHooks() {
    cursor = 0
  }

  const react = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children }
    },
    useRef(initial) {
      const index = cursor++
      if (!slots[index]) slots[index] = { type: 'ref', value: { current: initial } }
      return slots[index].value
    },
    useReducer(reducer, initial) {
      const index = cursor++
      if (!slots[index]) slots[index] = { type: 'state', value: initial }
      const slot = slots[index]
      if (!slot.dispatch) {
        const owner = active
        slot.dispatch = (action) => {
          slot.value = reducer(slot.value, action)
          if (owner) owner.dirty = true
        }
      }
      return [slot.value, slot.dispatch]
    },
    useState(initial) {
      return react.useReducer((value, next) => (typeof next === 'function' ? next(value) : next), initial)
    },
    useMemo(factory) {
      return factory()
    },
    useCallback(fn) {
      return fn
    },
    useEffect(create, deps) {
      const index = cursor++
      let slot = slots[index]
      if (!slot) {
        slot = { type: 'effect' }
        slots[index] = slot
      }
      const changed = slot.deps === undefined
        || deps === undefined
        || deps.length !== slot.deps.length
        || deps.some((value, position) => !Object.is(value, slot.deps[position]))
      slot.pending = { create, deps, changed, cleanup: slot.cleanup }
    },
  }

  return {
    react,
    resetHooks,
    /** 执行本轮渲染里发生变化的 effect。 */
    flushEffects() {
      for (const slot of slots) {
        if (!slot?.pending) continue
        const { create, deps, changed, cleanup } = slot.pending
        delete slot.pending
        if (!changed) continue
        if (typeof cleanup === 'function') cleanup()
        const next = create()
        slot.cleanup = typeof next === 'function' ? next : undefined
        slot.deps = deps
        slot.create = create
      }
    },
    /** StrictMode 重放全部 effect，保留 hooks 和组件实例。 */
    replayEffects() {
      for (const slot of slots) {
        if (slot?.cleanup) slot.cleanup()
        if (slot) slot.cleanup = undefined
      }
      for (const slot of slots) {
        if (slot?.type !== 'effect' || !slot.create) continue
        const next = slot.create()
        slot.cleanup = typeof next === 'function' ? next : undefined
      }
    },
    /** 卸载：执行所有 cleanup。 */
    unmount() {
      // React 在 passive effect 清理前摘掉宿主 ref。
      for (const slot of slots) {
        if (slot?.type === 'ref') slot.value.current = null
      }
      for (const slot of slots) {
        if (slot?.cleanup) slot.cleanup()
        if (slot) slot.cleanup = undefined
      }
      if (active) active.hooks = []
      slots = []
    },
    setActive(component) {
      active = component
      slots = component.hooks ??= []
    },
  }
}

/* ------------------------------------------------------------------ *
 * 载入插件
 * ------------------------------------------------------------------ */

/**
 * 装配一次完整的运行环境：微型 DOM + 微型 React + 可控 fetch。
 * 每次都重新求值源码，保证模块级状态（stores / 样式注入）相互隔离。
 */
function setup(options = {}) {
  const card = makeElement('div')
  card.dataset.composerCard = true
  // 真实 DSH 的输入框是 Lexical contentEditable div；这里用 editable 选项模拟它，
  // 默认仍用 textarea 以便同时覆盖两种形态。
  const input = makeElement(options.editable === true ? 'div' : 'textarea')
  input.dataset.composerInput = true
  if (options.editable === true) {
    input.isContentEditable = true
    input.setAttribute('contenteditable', 'true')
  }
  card.appendChild(input)

  const styleTags = []
  const keydownListeners = new Set()
  const resizeListeners = new Set()
  const scrollListeners = new Set()

  const documentStub = {
    head: { appendChild: (node) => { styleTags.push(node); return node } },
    body: makeElement('body'),
    activeElement: input,
    createElement: (tagName) => makeElement(tagName),
    querySelector: (selector) => (selector.includes('data-plugin-css') && styleTags.length > 0 ? styleTags[0] : null),
    querySelectorAll: () => [],
  }

  /** options.manualFrames 为 true 时 rAF 回调排队，由 flushFrames() 手动执行。 */
  const frames = []
  let computedStyleCalls = 0
  const windowStub = {
    getComputedStyle: () => (computedStyleCalls += 1, {
      fontFamily: 'sans-serif',
      fontSize: '14px',
      fontWeight: '400',
      fontStyle: 'normal',
      letterSpacing: 'normal',
      lineHeight: '22px',
      textAlign: 'start',
      textIndent: '0px',
      textTransform: 'none',
      wordSpacing: '0px',
      paddingTop: '12px',
      paddingRight: '16px',
      paddingBottom: '12px',
      paddingLeft: '16px',
      borderTopWidth: '0px',
      borderRightWidth: '0px',
      borderBottomWidth: '0px',
      borderLeftWidth: '0px',
      boxSizing: 'border-box',
    }),
    requestAnimationFrame: (callback) => {
      if (options.manualFrames !== true) { callback(); return 1 }
      frames.push(callback)
      return frames.length
    },
    cancelAnimationFrame: () => {},
    addEventListener(type, handler) {
      if (type === 'keydown') keydownListeners.add(handler)
      if (type === 'resize') resizeListeners.add(handler)
      if (type === 'scroll') scrollListeners.add(handler)
    },
    removeEventListener(type, handler) {
      if (type === 'keydown') keydownListeners.delete(handler)
      if (type === 'resize') resizeListeners.delete(handler)
      if (type === 'scroll') scrollListeners.delete(handler)
    },
    localStorage: {
      getItem: () => null,
      setItem: () => {},
    },
  }

  /** 记录 fetch 调用，并返回预置的响应。 */
  const fetchCalls = []
  let fetchPlan = options.fetchPlan ?? (async () => ({
    json: async () => ({ ok: true, candidate: '请继续，并说明判断依据', source: 'model' }),
  }))

  windowStub.fetch = (url, init) => {
    fetchCalls.push({ url, init })
    return Promise.resolve(fetchPlan(url, init))
  }

  const loaded = []
  windowStub.__ModuleLoader__ = { load: (entry) => loaded.push(entry) }

  const requireStub = (specifier) => {
    if (specifier === 'react') return runtime.react
    throw new Error(`unexpected require: ${specifier}`)
  }

  const runtime = createReact()
  runtime.setActive({ dirty: false })

  // 用注入的全局对象求值，避免污染真实的 globalThis。
  const evaluate = new Function(
    'window',
    'document',
    'MutationObserver',
    'ResizeObserver',
    'AbortController',
    'require',
    source,
  )

  /** 记录 ResizeObserver 观察过哪些元素，用于断言卡片也被观察。 */
  const observedTargets = []
  class ResizeObserverStub {
    observe(target) { observedTargets.push(target) }
    disconnect() {}
  }

  evaluate(windowStub, documentStub, class { observe() {} disconnect() {} }, ResizeObserverStub, AbortController, requireStub)

  const plugin = loaded[0].factory(requireStub)

  /** 收集注册进 slot 的组件。 */
  const registrations = []
  const injectedSlots = []
  const warnings = []
  const ctx = {
    logger: { warn: (message) => warnings.push(message) },
    slots: {
      inject(slot, callback) {
        injectedSlots.push(slot)
        callback()
        return () => {}
      },
      register(registration, component) {
        registrations.push({ registration, component })
        return () => {}
      },
    },
  }

  plugin.apply(ctx)

  /** 把一份 props 改成「Agent 正在回答」的版本（兼容 session 与 useSession 两种形态）。 */
  function runningVariant(props) {
    if (typeof props?.useSession === 'function') {
      const useSession = props.useSession
      return { ...props, useSession: (selector) => useSession((state) => selector({ ...state, running: true })) }
    }
    return { ...props, session: { ...props?.session, running: true } }
  }

  /**
   * @param ghostOptions.primeTurn - 默认 true：首次渲染前先渲染一次「正在回答」，
   *   模拟「Agent 刚回答完」，因为插件只在回答结束时生成。
   *   验证「只打开会话不生成」的用例传 false。
   */
  function makeGhost(ghostOptions = {}) {
    const instance = { dirty: false, hooks: [] }
    let lastProps
    let lastTree
    let primed = ghostOptions.primeTurn === false || options.primeTurn === false
    const ghost = {
      component: registrations[0]?.component,
      render(props) {
        if (!primed) {
          primed = true
          ghost.render(runningVariant(props))
        }
        lastProps = props
        runtime.setActive(instance)
        runtime.resetHooks()
        instance.dirty = false
        lastTree = ghost.component(props)
        assignRefs(lastTree)
        runtime.flushEffects()
        return lastTree
      },
      flush() {
        let count = 0
        while (instance.dirty) {
          if (++count > 20) throw new Error('无限重渲染')
          ghost.render(lastProps)
        }
        return lastTree
      },
      replayEffects() { runtime.setActive(instance); runtime.replayEffects() },
      unmount() { runtime.setActive(instance); runtime.unmount() },
    }
    return ghost
  }
  const ghost = makeGhost()

  function assignRefs(node) {
    if (!node || typeof node !== 'object') return
    const element = node.type === runtime.react.Fragment ? null : makeElement('div')
    if (element && node.props?.ref && typeof node.props.ref === 'object') {
      // 关键：把锚点接到真实的 composer 卡片上，让 closest() 能走通。
      element.parentNode = card
      if (node.props.className === 'dsh-pp-ghost') {
        element.className = 'dsh-pp-ghost'
        element.textContent = node.children?.[0] ?? ''
        element.dataset.dshPromptPrefill = 'ghost'
      }
      // 保持同一宿主节点的身份；真实 React 不会每次渲染都替换 DOM。
      node.props.ref.current ??= element
    }
    for (const child of node.children ?? []) assignRefs(child)
  }

  /** 从渲染树里取出幽灵文本节点。 */
  function findGhostNode(node) {
    if (!node || typeof node !== 'object') return null
    if (node.props?.className === 'dsh-pp-ghost') return node
    for (const child of node.children ?? []) {
      const found = findGhostNode(child)
      if (found) return found
    }
    return null
  }

  return {
    card,
    input,
    documentStub,
    windowStub,
    runtime,
    plugin,
    loaded,
    registrations,
    injectedSlots,
    warnings,
    fetchCalls,
    styleTags,
    observedTargets,
    ghost,
    makeGhost,
    findGhostNode,
    setFetchPlan(next) { fetchPlan = next },
    /**
     * 造一个挂在输入框内部的子节点，用于模拟 Lexical 把焦点放在子节点上的情形。
     * 它会成为 input 的子节点，因此 input.contains(inner) === true。
     */
    makeInner() {
      const inner = makeElement('p')
      input.appendChild(inner)
      return inner
    },
    /** 派发一次 keydown。 */
    dispatchKey(key, extra = {}) {
      const event = {
        key,
        repeat: false,
        isComposing: false,
        defaultPrevented: false,
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        preventDefault() { event.defaultPrevented = true },
        stopPropagation() {},
        ...extra,
      }
      for (const handler of [...keydownListeners]) handler(event)
      return event
    },
    keydownCount: () => keydownListeners.size,
    /** 派发一次滚动 / 窗口尺寸变化。 */
    dispatchScroll() { for (const handler of [...scrollListeners]) handler() },
    dispatchResize() { for (const handler of [...resizeListeners]) handler() },
    /** 执行排队中的 rAF 回调，返回执行了几个。 */
    flushFrames() {
      const pending = frames.splice(0)
      for (const callback of pending) callback()
      return pending.length
    },
    computedStyleCalls: () => computedStyleCalls,
  }
}

/** 允许挂起的 promise 链推进。 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

/* ------------------------------------------------------------------ *
 * 测试
 * ------------------------------------------------------------------ */

console.log('加载契约')
{
  const env = setup()
  check('加载了一个模块', env.loaded.length === 1, String(env.loaded.length))
  check('模块 id 是包名', env.loaded[0]?.id === 'dsh-prompt-prefill', String(env.loaded[0]?.id))
  check('导出插件名', env.plugin.name === 'dsh-prompt-prefill-client', String(env.plugin.name))
  check('声明注入 slots', Array.isArray(env.plugin.inject) && env.plugin.inject.includes('slots'))
  check('导出 apply', typeof env.plugin.apply === 'function')
  check('注册进 conversation.input.overlay', env.injectedSlots[0] === 'conversation.input.overlay', JSON.stringify(env.injectedSlots))
  check('注册了一个组件', env.registrations.length === 1, String(env.registrations.length))
  check('注册项带自有 id', env.registrations[0]?.registration?.id === 'prompt-prefill')
  check('注入了样式标签', env.styleTags.length === 1, String(env.styleTags.length))
  check('样式是灰色幽灵文本风格', env.styleTags[0]?.textContent?.includes('dsh-pp-ghost') === true)
  check('样式使用主题三级文字色', env.styleTags[0]?.textContent?.includes('--dsw-alias-label-tertiary') === true)
  check('幽灵文本不接收鼠标事件', env.styleTags[0]?.textContent?.includes('pointer-events: none') === true)
}

console.log('\n降级行为')
{
  const noSlots = { logger: { warn: (m) => noSlots.logged.push(m) }, logged: [] }
  let threw = false
  try {
    setup().plugin.apply(noSlots)
  } catch {
    threw = true
  }
  check('没有 slots 服务时不抛错', threw === false)
  check('没有 slots 服务时记录一条 warn', noSlots.logged.length === 1, JSON.stringify(noSlots.logged))

  const hostile = {
    logger: { warn: () => {} },
    slots: {
      inject() { throw new Error('槽位未声明') },
      register() {},
    },
  }
  let threwHostile = false
  try {
    setup().plugin.apply(hostile)
  } catch {
    threwHostile = true
  }
  check('槽位未声明时不抛错', threwHostile === false)
}

console.log('\n候选生成与展示')
{
  const env = setup()
  const props = {
    sessionId: 'session-1',
    input: { draft: '', phase: 'idle' },
    inputActions: { setDraft: () => {}, captureInsertion: () => ({}), insertText: () => true },
    session: { sessionId: 'session-1', running: false, turnEnds: [{ endSeq: 1 }] },
  }

  let tree = env.ghost.render(props)
  check('首次渲染还没有候选', env.findGhostNode(tree) === null)
  check('发起了 RPC 请求', env.fetchCalls.length === 1, String(env.fetchCalls.length))
  check('请求打到插件自己的路径', env.fetchCalls[0]?.url === '/dsh-prompt-prefill/rpc', String(env.fetchCalls[0]?.url))

  const body = JSON.parse(env.fetchCalls[0].init.body)
  check('请求携带 sessionId', body.sessionId === 'session-1', JSON.stringify(body))
  check('请求携带草稿', body.draft === '', JSON.stringify(body))

  await settle()
  tree = env.ghost.render(props)
  const node = env.findGhostNode(tree)
  check('候选到达后渲染幽灵文本', node !== null)
  check('幽灵文本内容是候选提示词', node?.children?.[0] === '请继续，并说明判断依据', JSON.stringify(node?.children))
  check('幽灵文本对无障碍隐藏', node?.props?.['aria-hidden'] === 'true')
  check('幽灵文本带定位标记', node?.props?.['data-dsh-prompt-prefill'] === 'ghost')
}

console.log('\n通过 ctx.get 取 slots（与 dsh-prompt-for-me 一致）')
{
  const env = setup()
  const injected = []
  env.plugin.apply({
    logger: { warn() {} },
    get(serviceName) {
      if (serviceName !== 'slots') return undefined
      return {
        inject(slot, callback) { injected.push(slot); callback() },
        register() { return () => {} },
      }
    },
  })
  check('只有 ctx.get 时也能注册浮层', injected[0] === 'conversation.input.overlay', JSON.stringify(injected))
}

console.log('\nHarness 原生内联建议（offerSuggestion）')
{
  const env = setup()
  const offered = []
  const dismissed = []
  const drafted = []
  const actions = {
    setDraft: (text) => drafted.push(text),
    offerSuggestion: (suggestion) => { offered.push(suggestion); return true },
    dismissSuggestion: (id) => { dismissed.push(id); return true },
  }
  const props = (input, session = { sessionId: 'session-n', running: false }) => ({
    sessionId: 'session-n', input, inputActions: actions, session,
  })

  env.ghost.render(props({ draft: '', phase: 'idle' }))
  await settle()
  let tree = env.ghost.flush()
  check('候选交给原生 offerSuggestion', offered.length === 1 && offered[0].text === '请继续，并说明判断依据', JSON.stringify(offered))
  check('原生模式不画自绘浮层', env.findGhostNode(tree) === null)
  env.documentStub.activeElement = env.input
  const nativeRight = env.dispatchKey('ArrowRight')
  const nativeTab = env.dispatchKey('Tab')
  check('原生模式不拦截 → 与 Tab（交给 Harness）',
    drafted.length === 0 && !nativeRight.defaultPrevented && !nativeTab.defaultPrevented, JSON.stringify(drafted))
  check('原生模式不抑制原生 placeholder', env.input.getAttribute('data-dsh-prompt-prefill') === null)

  const id = offered[0]?.id
  env.ghost.render(props({ draft: '', phase: 'idle', suggestion: { id, text: offered[0]?.text } }))
  env.ghost.flush()
  check('建议已显示时不重复提交', offered.length === 1, String(offered.length))

  // 原生采纳：草稿变成候选、suggestion 消失。
  env.ghost.render(props({ draft: '请继续，并说明判断依据', phase: 'idle' }))
  env.ghost.flush()
  check('采纳后不重复提交', offered.length === 1, String(offered.length))
  // 清空草稿后可以再次出现，且不再请求模型。
  env.ghost.render(props({ draft: '', phase: 'idle' }))
  env.ghost.flush()
  check('清空草稿后重新提交建议', offered.length === 2 && offered[1].id !== id, JSON.stringify(offered))
  check('重新提交不再请求模型', env.fetchCalls.length === 1, String(env.fetchCalls.length))

  // 草稿为空时建议消失 = 用户按 Escape 关闭：本轮不再出现。
  const second = offered[1]?.id
  env.ghost.render(props({ draft: '', phase: 'idle', suggestion: { id: second } }))
  env.ghost.flush()
  env.ghost.render(props({ draft: '', phase: 'idle' }))
  env.ghost.flush()
  env.ghost.render(props({ draft: '', phase: 'idle' }))
  env.ghost.flush()
  check('Escape 关闭后不再提交', offered.length === 2, String(offered.length))

  // Agent 开始回答时撤下原生建议。
  const busy = setup()
  const busyDismissed = []
  const busyActions = {
    setDraft() {},
    offerSuggestion: () => true,
    dismissSuggestion: (sid) => { busyDismissed.push(sid); return true },
  }
  busy.ghost.render({ sessionId: 's-b', input: { draft: '', phase: 'idle' }, inputActions: busyActions, session: { sessionId: 's-b', running: false } })
  await settle()
  busy.ghost.flush()
  busy.ghost.render({ sessionId: 's-b', input: { draft: '', phase: 'idle' }, inputActions: busyActions, session: { sessionId: 's-b', running: true } })
  busy.ghost.flush()
  check('Agent 开始回答时撤下原生建议', busyDismissed.length === 1, JSON.stringify(busyDismissed))

  // Harness 拒绝：不强行展示，也不退回自绘浮层。
  const refused = setup()
  const refusedOffers = []
  refused.ghost.render({ sessionId: 's-r', input: { draft: '', phase: 'idle' }, session: { sessionId: 's-r', running: false },
    inputActions: { setDraft() {}, offerSuggestion: (x) => { refusedOffers.push(x); return false } } })
  await settle()
  const refusedTree = refused.ghost.flush()
  check('原生拒绝时只尝试一次', refusedOffers.length === 1, String(refusedOffers.length))
  check('原生拒绝时不退回自绘浮层', refused.findGhostNode(refusedTree) === null)
}

console.log('\n只在回答结束时生成（与 Claude Code 一致）')
{
  const env = setup({ primeTurn: false })
  const idle = {
    sessionId: 'turn',
    input: { draft: '', phase: 'idle' },
    inputActions: { setDraft: () => {} },
    session: { sessionId: 'turn', running: false },
  }
  env.ghost.render(idle)
  await settle()
  env.ghost.render(idle)
  check('只打开会话不发请求', env.fetchCalls.length === 0, String(env.fetchCalls.length))

  env.ghost.render({ ...idle, session: { sessionId: 'turn', running: true } })
  check('回答中不发请求', env.fetchCalls.length === 0, String(env.fetchCalls.length))
  env.ghost.render(idle)
  await settle()
  check('回答结束时发一次请求', env.fetchCalls.length === 1, String(env.fetchCalls.length))
  check('回答结束后显示候选', env.findGhostNode(env.ghost.flush()) !== null)
  env.ghost.render(idle)
  check('重渲染不重复请求', env.fetchCalls.length === 1, String(env.fetchCalls.length))

  // 回答结束时用户已经在打字：先挂着，草稿清空后再生成。
  const typing = setup({ primeTurn: false })
  const typed = { ...idle, sessionId: 'typing', session: { sessionId: 'typing', running: true }, input: { draft: '在打字', phase: 'idle' } }
  typing.ghost.render(typed)
  typing.ghost.render({ ...typed, session: { sessionId: 'typing', running: false } })
  check('回答结束时草稿非空先不请求', typing.fetchCalls.length === 0, String(typing.fetchCalls.length))
  typing.ghost.render({ ...typed, session: { sessionId: 'typing', running: false }, input: { draft: '', phase: 'idle' } })
  await settle()
  check('草稿清空后补一次请求', typing.fetchCalls.length === 1, String(typing.fetchCalls.length))

  // 失败后不重试，直到下一轮回答结束。
  const failing = setup({ primeTurn: false, fetchPlan: async () => ({ json: async () => ({ ok: false, message: '没有候选' }) }) })
  const f = { ...idle, sessionId: 'fail' }
  failing.ghost.render({ ...f, session: { sessionId: 'fail', running: true } })
  failing.ghost.render({ ...f, session: { sessionId: 'fail', running: false } })
  await settle()
  failing.ghost.render({ ...f, session: { sessionId: 'fail', running: false } })
  failing.ghost.render({ ...f, session: { sessionId: 'fail', running: false } })
  check('失败后同一轮不重试', failing.fetchCalls.length === 1, String(failing.fetchCalls.length))
  failing.ghost.render({ ...f, session: { sessionId: 'fail', running: true } })
  failing.ghost.render({ ...f, session: { sessionId: 'fail', running: false } })
  await settle()
  check('下一轮回答结束再试一次', failing.fetchCalls.length === 2, String(failing.fetchCalls.length))
}

console.log('\n按 Tab 采纳')
{
  const env = setup()
  const drafted = []
  const props = {
    sessionId: 'tab',
    input: { draft: '', phase: 'idle' },
    inputActions: { setDraft: (text) => drafted.push(text) },
    session: { sessionId: 'tab', running: false },
  }
  env.ghost.render(props)
  await settle()
  env.ghost.render(props)
  env.documentStub.activeElement = env.input

  const shiftTab = env.dispatchKey('Tab', { shiftKey: true })
  check('Shift+Tab 不拦截', drafted.length === 0 && shiftTab.defaultPrevented === false)
  const tab = env.dispatchKey('Tab')
  check('Tab 写入候选', drafted.length === 1 && drafted[0] === '请继续，并说明判断依据', JSON.stringify(drafted))
  check('Tab 的默认行为（切换焦点）被阻止', tab.defaultPrevented === true)

  // 输入框没有聚焦时 Tab 照常切换焦点。
  const blurred = setup()
  const blurredDrafts = []
  const blurredProps = { ...props, sessionId: 'tab-2', session: { sessionId: 'tab-2', running: false }, inputActions: { setDraft: (t) => blurredDrafts.push(t) } }
  blurred.ghost.render(blurredProps)
  await settle()
  blurred.ghost.render(blurredProps)
  blurred.documentStub.activeElement = blurred.card
  const away = blurred.dispatchKey('Tab')
  check('未聚焦时 Tab 不拦截', blurredDrafts.length === 0 && away.defaultPrevented === false)
}

console.log('\n按 ↑ 回填上一次发送的内容')
{
  /** 按请求类型分别应答：lastSent 返回上一次发送的内容，其余返回候选。 */
  const routed = (text = '上次发的那句') => async (url, init) => {
    const body = JSON.parse(init.body)
    return body.method === 'lastSent'
      ? { json: async () => (text === null ? { ok: false, code: 'NO_HISTORY', message: '没有历史' } : { ok: true, text }) }
      : { json: async () => ({ ok: true, candidate: '请继续，并说明判断依据' }) }
  }
  const lastSentCalls = (env) => env.fetchCalls.filter((call) => JSON.parse(call.init.body).method === 'lastSent')
  const make = (overrides = {}) => {
    const drafted = []
    const env = setup({ primeTurn: false, fetchPlan: overrides.fetchPlan ?? routed() })
    const props = {
      sessionId: 'up',
      input: { draft: '', phase: 'idle', ...overrides.input },
      inputActions: { setDraft: (text) => drafted.push(text) },
      session: { sessionId: 'up', running: false, ...overrides.session },
    }
    env.ghost.render(props)
    env.documentStub.activeElement = env.input
    return { env, props, drafted }
  }

  const { env, drafted } = make()
  const up = env.dispatchKey('ArrowUp')
  check('空输入框按 ↑ 被拦截', up.defaultPrevented === true)
  await settle()
  check('↑ 发出 lastSent 请求', lastSentCalls(env).length === 1, JSON.stringify(env.fetchCalls.map((c) => c.init.body)))
  check('请求带上会话 id', JSON.parse(lastSentCalls(env)[0]?.init.body ?? '{}').sessionId === 'up')
  check('↑ 写入上一次发送的内容', drafted.length === 1 && drafted[0] === '上次发的那句', JSON.stringify(drafted))

  // 不需要先有幽灵文本：只打开会话（没有回答结束）也能用。
  check('没有幽灵文本时也能用', env.findGhostNode(env.ghost.flush()) === null)

  // Agent 正在回答时也能用（Harness 支持排队发送）。
  const busy = make({ session: { running: true } })
  busy.env.dispatchKey('ArrowUp')
  await settle()
  check('回答中也能回填', busy.drafted[0] === '上次发的那句', JSON.stringify(busy.drafted))

  // 不拦截的情况。
  const typed = make({ input: { draft: '已有文字' } })
  typed.env.input.value = '已有文字'
  const typedUp = typed.env.dispatchKey('ArrowUp')
  await settle()
  check('有文字时 ↑ 交给光标移动', !typedUp.defaultPrevented && lastSentCalls(typed.env).length === 0)

  for (const [label, extra] of [['Shift+↑', { shiftKey: true }], ['Alt+↑', { altKey: true }], ['输入法组合中', { isComposing: true }], ['长按重复', { repeat: true }]]) {
    const m = make()
    const event = m.env.dispatchKey('ArrowUp', extra)
    await settle()
    check(`${label} 不拦截`, !event.defaultPrevented && lastSentCalls(m.env).length === 0)
  }

  const blurred = make()
  blurred.env.documentStub.activeElement = blurred.env.card
  const blurredUp = blurred.env.dispatchKey('ArrowUp')
  check('输入框没聚焦时不拦截', !blurredUp.defaultPrevented)

  for (const phase of ['adjudicating', 'claimed', 'submitting']) {
    const m = make({ input: { phase } })
    const event = m.env.dispatchKey('ArrowUp')
    check(`${phase} 时不拦截`, !event.defaultPrevented)
  }

  const removed = make({ session: { removed: true } })
  check('会话已移除时不拦截', !removed.env.dispatchKey('ArrowUp').defaultPrevented)

  // 没有历史：不写入、不报错。
  const none = make({ fetchPlan: routed(null) })
  none.env.dispatchKey('ArrowUp')
  await settle()
  check('没有历史时不写入', none.drafted.length === 0)

  // 等待期间用户已经开始输入：不覆盖。
  let release
  const slow = make({ fetchPlan: () => new Promise((resolve) => { release = resolve }) })
  slow.env.dispatchKey('ArrowUp')
  slow.env.ghost.render({ ...slow.props, input: { draft: '我自己打的', phase: 'idle' } })
  await settle()
  release?.({ json: async () => ({ ok: true, text: '上次发的那句' }) })
  await settle()
  check('等待期间开始输入则不覆盖', slow.drafted.length === 0, JSON.stringify(slow.drafted))

  // 等待期间切换了会话：不写到别的会话。
  let releaseSwitch
  const switching = make({ fetchPlan: () => new Promise((resolve) => { releaseSwitch = resolve }) })
  switching.env.dispatchKey('ArrowUp')
  switching.env.ghost.render({ ...switching.props, sessionId: 'other', session: { sessionId: 'other', running: false } })
  await settle()
  releaseSwitch?.({ json: async () => ({ ok: true, text: '上次发的那句' }) })
  await settle()
  check('等待期间切换会话则不写入', switching.drafted.length === 0, JSON.stringify(switching.drafted))

  // 同一会话有两个实例，其中处理按键的那个切到别的会话：
  // 会话状态仍被另一个实例占用，必须靠会话 id 判断，不能写进新会话。
  let releaseShared
  const sharedUp = setup({ primeTurn: false, fetchPlan: () => new Promise((resolve) => { releaseShared = resolve }) })
  const upDrafts = []
  const otherDrafts = []
  const upProps = { sessionId: 'up', input: { draft: '', phase: 'idle' }, inputActions: { setDraft: (t) => upDrafts.push(t) }, session: { sessionId: 'up', running: false } }
  const secondUp = sharedUp.makeGhost({ primeTurn: false })
  sharedUp.ghost.render(upProps)
  secondUp.render(upProps)
  sharedUp.documentStub.activeElement = sharedUp.input
  sharedUp.dispatchKey('ArrowUp')
  sharedUp.ghost.render({ ...upProps, sessionId: 'other', session: { sessionId: 'other', running: false }, inputActions: { setDraft: (t) => otherDrafts.push(t) } })
  await settle()
  releaseShared?.({ json: async () => ({ ok: true, text: '上次发的那句' }) })
  await settle()
  check('切到别的会话后不写进新会话', otherDrafts.length === 0, JSON.stringify(otherDrafts))

  // 连按只发一次请求。
  let releaseDouble
  const double = make({ fetchPlan: () => new Promise((resolve) => { releaseDouble = resolve }) })
  double.env.dispatchKey('ArrowUp')
  double.env.dispatchKey('ArrowUp')
  await settle()
  check('连按只请求一次', double.env.fetchCalls.length === 1, String(double.env.fetchCalls.length))
  releaseDouble?.({ json: async () => ({ ok: true, text: '上次发的那句' }) })
  await settle()
  check('连按只写入一次', double.drafted.length === 1, JSON.stringify(double.drafted))

  // 宿主半不可用（404）：不写入、不抛错。
  const missing = make({ fetchPlan: async () => ({ ok: false, status: 404, json: async () => { throw new Error('not json') } }) })
  missing.env.dispatchKey('ArrowUp')
  await settle()
  check('宿主半 404 时不写入', missing.drafted.length === 0)

  // claimed 时幽灵文本也隐藏。
  const claimed = setup()
  const claimedProps = { sessionId: 'c', input: { draft: '', phase: 'claimed' }, inputActions: { setDraft() {} }, session: { sessionId: 'c', running: false } }
  claimed.ghost.render({ ...claimedProps, input: { draft: '', phase: 'idle' } })
  await settle()
  claimed.ghost.flush()
  check('claimed 时隐藏幽灵文本', claimed.findGhostNode(claimed.ghost.render(claimedProps)) === null)
}

console.log('\n按 → 采纳（核心验收项）')
{
  const env = setup()
  const drafted = []
  const props = {
    sessionId: 'session-1',
    input: { draft: '', phase: 'idle' },
    inputActions: { setDraft: (text) => drafted.push(text) },
    session: { sessionId: 'session-1', running: false, turnEnds: [{ endSeq: 1 }] },
  }

  env.ghost.render(props)
  await settle()
  env.ghost.render(props)
  check('采纳前已注册 keydown 监听', env.keydownCount() > 0, String(env.keydownCount()))

  env.documentStub.activeElement = env.input
  env.input.value = ''
  const event = env.dispatchKey('ArrowRight')

  check('→ 触发了 setDraft', drafted.length === 1, JSON.stringify(drafted))
  check('写入的正是候选提示词', drafted[0] === '请继续，并说明判断依据', JSON.stringify(drafted))
  check('→ 的默认行为被阻止', event.defaultPrevented === true)
}

console.log('\n→ 的边界情况（不冲突）')
{
  // 输入框有文字：不拦截，交给原生光标移动
  const env = setup()
  const drafted = []
  const props = {
    sessionId: 's',
    input: { draft: '', phase: 'idle' },
    inputActions: { setDraft: (text) => drafted.push(text) },
    session: { sessionId: 's', running: false, turnEnds: [{ endSeq: 1 }] },
  }
  env.ghost.render(props)
  await settle()
  env.ghost.render(props)

  env.documentStub.activeElement = env.input
  env.input.value = '用户已经输入了内容'
  const withText = env.dispatchKey('ArrowRight')
  check('输入框有文字时不采纳', drafted.length === 0, JSON.stringify(drafted))
  check('输入框有文字时不阻止默认行为', withText.defaultPrevented === false)
  check('有文字时幽灵文本不渲染', env.findGhostNode(env.ghost.render({ ...props, input: { draft: '用户已经输入了内容', phase: 'idle' } })) === null)

  // 输入框未聚焦：不拦截
  env.input.value = ''
  env.documentStub.activeElement = env.card
  const notFocused = env.dispatchKey('ArrowRight')
  check('输入框未聚焦时不采纳', drafted.length === 0, JSON.stringify(drafted))
  check('输入框未聚焦时不阻止默认行为', notFocused.defaultPrevented === false)

  // 带修饰键：不拦截
  env.documentStub.activeElement = env.input
  const modified = env.dispatchKey('ArrowRight', { shiftKey: true })
  check('Shift+→ 不采纳（保留选区操作）', drafted.length === 0, JSON.stringify(drafted))
  check('Shift+→ 不阻止默认行为', modified.defaultPrevented === false)

  // 输入法组合中：不拦截
  const composing = env.dispatchKey('ArrowRight', { isComposing: true })
  check('输入法组合中不采纳', drafted.length === 0, JSON.stringify(drafted))
  check('输入法组合中不阻止默认行为', composing.defaultPrevented === false)

  // 其他按键：不采纳
  env.dispatchKey('ArrowLeft')
  env.dispatchKey('Enter')
  env.dispatchKey('Tab')
  check('其他按键不触发采纳', drafted.length === 0, JSON.stringify(drafted))
}

console.log('\nEscape 关闭')
{
  const env = setup()
  const props = {
    sessionId: 's',
    input: { draft: '', phase: 'idle' },
    inputActions: { setDraft: () => {} },
    session: { sessionId: 's', running: false, turnEnds: [{ endSeq: 1 }] },
  }
  env.ghost.render(props)
  await settle()
  check('候选已展示', env.findGhostNode(env.ghost.render(props)) !== null)

  env.documentStub.activeElement = env.input
  env.input.value = ''
  env.dispatchKey('Escape')
  check('Escape 后幽灵文本消失', env.findGhostNode(env.ghost.render(props)) === null)
}

console.log('\n生成时机')
{
  // 草稿非空：不请求
  const busy = setup()
  busy.ghost.render({
    sessionId: 's',
    input: { draft: '已有草稿', phase: 'idle' },
    inputActions: { setDraft: () => {} },
    session: { sessionId: 's', running: false, turnEnds: [{ endSeq: 1 }] },
  })
  check('草稿非空时不请求模型', busy.fetchCalls.length === 0, String(busy.fetchCalls.length))

  // 会话运行中：不请求
  const running = setup()
  running.ghost.render({
    sessionId: 's',
    input: { draft: '', phase: 'idle' },
    inputActions: { setDraft: () => {} },
    session: { sessionId: 's', running: true, turnEnds: [{ endSeq: 1 }] },
  })
  check('会话运行中不请求模型', running.fetchCalls.length === 0, String(running.fetchCalls.length))

  // 请求失败：静默，不显示幽灵文本
  const failing = setup({ fetchPlan: async () => ({ json: async () => ({ ok: false, message: '模型不可用' }) }) })
  const props = {
    sessionId: 's',
    input: { draft: '', phase: 'idle' },
    inputActions: { setDraft: () => {} },
    session: { sessionId: 's', running: false, turnEnds: [{ endSeq: 1 }] },
  }
  failing.ghost.render(props)
  await settle()
  check('宿主半返回失败时不显示幽灵文本', failing.findGhostNode(failing.ghost.render(props)) === null)

  // fetch 直接抛错：静默
  const throwing = setup({ fetchPlan: async () => { throw new Error('网络断了') } })
  throwing.ghost.render(props)
  await settle()
  let threw = false
  try {
    throwing.ghost.render(props)
  } catch {
    threw = true
  }
  check('网络异常不影响渲染', threw === false)
  check('网络异常时不显示幽灵文本', throwing.findGhostNode(throwing.ghost.render(props)) === null)

  // 防重试风暴：失败后反复重渲染，不应反复打请求
  const stormCount = throwing.fetchCalls.length
  for (let index = 0; index < 5; index += 1) throwing.ghost.render(props)
  check('失败后重渲染不会重复请求', throwing.fetchCalls.length === stormCount, `${stormCount} → ${throwing.fetchCalls.length}`)

  // 下一轮开始（running 变 true）会重置尝试标记，空闲下来后允许再试一次。
  throwing.ghost.render({ ...props, session: { sessionId: 's', running: true } })
  throwing.ghost.render(props)
  check('下一轮空闲后允许再次尝试', throwing.fetchCalls.length === stormCount + 1, String(throwing.fetchCalls.length))
}

console.log('\n采纳后可恢复')
{
  const env = setup()
  const drafted = []
  const props = {
    sessionId: 's',
    input: { draft: '', phase: 'idle' },
    inputActions: { setDraft: (text) => drafted.push(text) },
    session: { sessionId: 's', running: false, turnEnds: [{ endSeq: 1 }] },
  }
  env.ghost.render(props)
  await settle()
  check('候选已展示', env.findGhostNode(env.ghost.render(props)) !== null)

  env.documentStub.activeElement = env.input
  env.input.value = ''
  env.dispatchKey('ArrowRight')
  check('→ 写入了候选', drafted.length === 1)

  // 采纳后草稿非空：幽灵文本隐藏，但不需要重新请求模型
  const afterAccept = env.ghost.render({ ...props, input: { draft: drafted[0], phase: 'idle' } })
  check('采纳后幽灵文本隐藏', env.findGhostNode(afterAccept) === null)
  check('采纳后没有重新请求', env.fetchCalls.length === 1, String(env.fetchCalls.length))

  // 用户清空文字：候选可重新出现，且依然不必重新请求
  const restored = env.ghost.render(props)
  check('清空草稿后候选重新出现', env.findGhostNode(restored) !== null)
  check('恢复显示时没有重新请求', env.fetchCalls.length === 1, String(env.fetchCalls.length))
}

console.log('\n多会话隔离')
{
  const env = setup()
  const base = {
    input: { draft: '', phase: 'idle' },
    inputActions: { setDraft: () => {} },
  }
  env.ghost.render({ ...base, sessionId: 'a', session: { sessionId: 'a', running: false, turnEnds: [{ endSeq: 1 }] } })
  await settle()
  const first = env.ghost.render({ ...base, sessionId: 'a', session: { sessionId: 'a', running: false, turnEnds: [{ endSeq: 1 }] } })
  check('会话 a 有候选', env.findGhostNode(first) !== null)

  const second = env.ghost.render({ ...base, sessionId: 'b', session: { sessionId: 'b', running: false, turnEnds: [{ endSeq: 9 }] } })
  check('切到会话 b 时不显示 a 的候选', env.findGhostNode(second) === null)
  check('只是切到会话 b 不发请求', env.fetchCalls.length === 1, String(env.fetchCalls.length))

  // 会话 b 有一轮回答结束后才生成。
  env.ghost.render({ ...base, sessionId: 'b', session: { sessionId: 'b', running: true } })
  env.ghost.render({ ...base, sessionId: 'b', session: { sessionId: 'b', running: false } })
  await settle()
  check('会话 b 回答结束后发起新请求', env.fetchCalls.length === 2, String(env.fetchCalls.length))
  check('会话 b 显示自己的候选', env.findGhostNode(env.ghost.flush()) !== null)
}

console.log('\n按宿主的回合号要建议')
{
  // 宿主返回回合号；下一次回答结束时只要更新回合的建议。
  let turn = 4
  const env = setup({ fetchPlan: async () => ({ json: async () => ({ ok: true, candidate: `第 ${turn} 回合的建议`, source: 'model', turn }) }) })
  const props = { sessionId: 't', input: { draft: '', phase: 'idle' }, inputActions: { setDraft() {} }, session: { sessionId: 't', running: false } }
  env.ghost.render(props)
  await settle()
  const firstBody = JSON.parse(env.fetchCalls[0]?.init.body ?? '{}')
  check('请求类型是 suggestion', firstBody.method === 'suggestion', JSON.stringify(firstBody))
  check('第一次请求不限回合', firstBody.afterTurn === -1, JSON.stringify(firstBody))
  check('允许宿主等待 turn/end', firstBody.waitMs > 0, JSON.stringify(firstBody))
  check('显示宿主给的建议', env.findGhostNode(env.ghost.flush())?.children[0] === '第 4 回合的建议')

  turn = 5
  env.ghost.render({ ...props, session: { sessionId: 't', running: true } })
  env.ghost.render(props)
  await settle()
  const secondBody = JSON.parse(env.fetchCalls[1]?.init.body ?? '{}')
  check('下一次只要更新回合', secondBody.afterTurn === 4, JSON.stringify(secondBody))
  check('显示新回合的建议', env.findGhostNode(env.ghost.flush())?.children[0] === '第 5 回合的建议')

  // 跳过（例如上一轮出错）也记下回合号，避免重复处理同一回合。
  const skipped = setup({ fetchPlan: async () => ({ json: async () => ({ ok: false, code: 'SKIPPED', message: '上一轮没有正常结束', turn: 7 }) }) })
  const sp = { ...props, sessionId: 'k', session: { sessionId: 'k', running: false } }
  skipped.ghost.render(sp)
  await settle()
  skipped.ghost.render({ ...sp, session: { sessionId: 'k', running: true } })
  skipped.ghost.render(sp)
  await settle()
  check('跳过的回合号也被记下', JSON.parse(skipped.fetchCalls[1]?.init.body ?? '{}').afterTurn === 7, skipped.fetchCalls[1]?.init.body)
}

console.log('\n切换会话后保留预填内容')
{
  const base = { input: { draft: '', phase: 'idle' }, inputActions: { setDraft: () => {} } }
  const at = (id, running = false) => ({ ...base, sessionId: id, session: { sessionId: id, running } })

  // 同一个组件实例切换 sessionId（a → b → a）。
  const env = setup()
  env.ghost.render(at('a'))
  await settle()
  check('会话 a 有候选', env.findGhostNode(env.ghost.flush()) !== null)
  env.ghost.render(at('b'))
  check('切到 b 不显示 a 的候选', env.findGhostNode(env.ghost.flush()) === null)
  const back = env.ghost.render(at('a'))
  check('切回 a 候选还在', env.findGhostNode(back)?.children[0] === '请继续，并说明判断依据')
  check('切回 a 不重新请求', env.fetchCalls.length === 1, String(env.fetchCalls.length))

  // 组件被卸载、再为同一会话重新挂载。
  const remount = setup()
  remount.ghost.render(at('r'))
  await settle()
  remount.ghost.flush()
  remount.ghost.unmount()
  const again = remount.makeGhost({ primeTurn: false })
  again.render(at('r'))
  check('卸载后重新挂载候选还在', remount.findGhostNode(again.flush()) !== null)
  check('重新挂载不重新请求', remount.fetchCalls.length === 1, String(remount.fetchCalls.length))

  // 请求还没回来就切走：结果照样保存，切回来能看到。
  const pending = []
  const inflight = setup({ fetchPlan: () => new Promise((resolve) => pending.push(resolve)) })
  inflight.ghost.render(at('p'))
  inflight.ghost.render(at('q'))
  pending[0]?.({ json: async () => ({ ok: true, candidate: '离开时生成的建议' }) })
  await settle()
  const returned = inflight.ghost.render(at('p'))
  check('切走期间完成的请求切回后可见', inflight.findGhostNode(returned)?.children[0] === '离开时生成的建议')

  // 回答进行中切走，结束后再切回：补生成这一轮的提示词。
  const away = setup({ primeTurn: false })
  away.ghost.render(at('w', true))
  away.ghost.render(at('x'))
  check('回答中切走时不请求', away.fetchCalls.length === 0, String(away.fetchCalls.length))
  away.ghost.render(at('w'))
  await settle()
  check('回答结束后切回补一次请求', away.fetchCalls.length === 1, String(away.fetchCalls.length))
  check('补生成的候选可见', away.findGhostNode(away.ghost.flush()) !== null)

  // 原生建议：切回来重新提交，而不是误判成 Escape 关闭。
  const offered = []
  const native = setup()
  const nativeAt = (id, suggestion) => ({
    sessionId: id,
    session: { sessionId: id, running: false },
    input: { draft: '', phase: 'idle', ...(suggestion ? { suggestion } : {}) },
    inputActions: { setDraft() {}, offerSuggestion: (x) => { offered.push(x); return true }, dismissSuggestion: () => true },
  })
  native.ghost.render(nativeAt('n'))
  await settle()
  native.ghost.flush()
  native.ghost.render(nativeAt('n', { id: offered[0]?.id }))
  native.ghost.render(nativeAt('m'))
  native.ghost.render(nativeAt('n'))
  native.ghost.flush()
  check('原生模式切回后重新提交建议', offered.length === 2 && offered[1].text === offered[0].text, JSON.stringify(offered))

  // 保留数量有上限：超过 50 个会话时，最久没看的被清掉。
  const many = setup()
  many.ghost.render(at('s0'))
  await settle()
  many.ghost.flush()
  for (let index = 1; index <= 51; index += 1) {
    many.ghost.render(at(`s${index}`))
  }
  // 回归护栏：超过上限的那一刻，刚切进来的会话不能被当成「离开已久」清掉。
  many.ghost.render(at('s51', true))
  many.ghost.render(at('s51'))
  await settle()
  check('超过上限时当前会话照常生成', many.findGhostNode(many.ghost.flush()) !== null)
  const oldest = many.ghost.render(at('s0'))
  check('超过上限时最久没看的会话被清掉', many.findGhostNode(oldest) === null)
}

console.log('\nStrictMode 双挂载 / 同会话多实例')
{
  // 回归护栏：store 用引用计数管理生命周期。若某个实例卸载就清空共享 store，
  // StrictMode 的 mount→unmount→mount 会把刚拿到的候选当场抹掉。
  const env = setup()
  const props = {
    sessionId: 'strict',
    input: { draft: '', phase: 'idle' },
    inputActions: { setDraft: () => {} },
    session: { sessionId: 'strict', running: false },
  }

  env.ghost.render(props)
  await settle()
  check('首轮渲染拿到候选', env.findGhostNode(env.ghost.render(props)) !== null)

  // 模拟 StrictMode：卸载后立刻重新挂载同一个会话。
  env.runtime.unmount()
  const afterDouble = env.ghost.render(props)
  check('卸载再挂载后候选仍在（或可恢复）',
    env.findGhostNode(afterDouble) !== null || env.fetchCalls.length > 1,
    `fetchCalls=${env.fetchCalls.length}`)

  // 已展示的候选不应因为一次卸载就消失。
  await settle()
  const finalTree = env.ghost.render(props)
  check('最终仍能显示候选', env.findGhostNode(finalTree) !== null)
}

console.log('\nResizeObserver 同时观察卡片')
{
  // 只观察 input 会漏掉「卡片因附件栏 / notice / 工具栏换行而变高变宽」的重排。
  const env = setup({ editable: true })
  const props = {
    sessionId: 's',
    input: { draft: '', phase: 'idle' },
    inputActions: { setDraft: () => {} },
    session: { sessionId: 's', running: false },
  }
  env.ghost.render(props)
  await settle()
  env.ghost.render(props)

  check('观察了输入框本身', env.observedTargets.includes(env.input))
  check('也观察了 composer 卡片', env.observedTargets.includes(env.card),
    `观察了 ${env.observedTargets.length} 个目标`)
}

console.log('\n滚动与尺寸变化按帧合并')
{
  const env = setup({ editable: true, manualFrames: true })
  const props = {
    sessionId: 's',
    input: { draft: '', phase: 'idle' },
    inputActions: { setDraft: () => {} },
    session: { sessionId: 's', running: false },
  }
  env.ghost.render(props)
  await settle()
  env.ghost.flush()
  env.ghost.render(props)
  env.flushFrames()
  const before = env.computedStyleCalls()
  check('显示时已对齐过浮层', before > 0, String(before))

  for (let index = 0; index < 10; index += 1) env.dispatchScroll()
  check('连续 10 次滚动只排一帧', env.flushFrames() === 1)
  check('滚动只更新位置，不重新读样式', env.computedStyleCalls() === before, `${before} → ${env.computedStyleCalls()}`)

  env.dispatchScroll()
  env.dispatchResize()
  env.dispatchScroll()
  check('滚动和尺寸变化也合并成一帧', env.flushFrames() === 1)
  check('同一帧里有尺寸变化时重新读样式', env.computedStyleCalls() === before + 1, `${before} → ${env.computedStyleCalls()}`)
}

console.log('\ncontentEditable 输入框（真实 DSH 形态）')
{
  // 回归测试：DSH 的 composer 是 Lexical contentEditable div，没有 .value。
  // 如果代码按 textarea 的 .value 判空，右方向键会永远不生效。
  const env = setup({ editable: true })
  const drafted = []
  const props = {
    sessionId: 's',
    input: { draft: '', phase: 'idle' },
    inputActions: { setDraft: (text) => drafted.push(text) },
    session: { sessionId: 's', running: false, turnEnds: [{ endSeq: 1 }] },
  }

  check('输入框被标记为 contentEditable', env.input.isContentEditable === true)
  check('contentEditable 没有 value 属性', env.input.value === undefined)

  env.ghost.render(props)
  await settle()
  check('contentEditable 下候选已展示', env.findGhostNode(env.ghost.render(props)) !== null)

  env.documentStub.activeElement = env.input
  env.input.textContent = ''
  const event = env.dispatchKey('ArrowRight')
  check('contentEditable 下 → 仍能采纳', drafted.length === 1, JSON.stringify(drafted))
  check('contentEditable 下写入正确内容', drafted[0] === '请继续，并说明判断依据', JSON.stringify(drafted))
  check('contentEditable 下阻止了默认行为', event.defaultPrevented === true)

  const before = drafted.length
  env.input.textContent = '已经输入了文字'
  const withText = env.dispatchKey('ArrowRight')
  check('contentEditable 有文字时不采纳', drafted.length === before, JSON.stringify(drafted))
  check('contentEditable 有文字时不阻止默认行为', withText.defaultPrevented === false)

  // 焦点落在输入框的子节点上（Lexical 常见）：仍应识别为聚焦
  drafted.length = 0
  env.input.textContent = ''
  env.documentStub.activeElement = env.makeInner()
  const innerEvent = env.dispatchKey('ArrowRight')
  check('焦点在输入框子节点时仍能采纳', drafted.length === 1, JSON.stringify(drafted))
  check('焦点在子节点时阻止了默认行为', innerEvent.defaultPrevented === true)

  // 焦点完全在输入框之外：不采纳
  drafted.length = 0
  env.documentStub.activeElement = env.card
  const outside = env.dispatchKey('ArrowRight')
  check('焦点在输入框之外时不采纳', drafted.length === 0, JSON.stringify(drafted))
  check('焦点在输入框之外时不阻止默认行为', outside.defaultPrevented === false)
}

console.log('\n槽位标准 props（useInput / useSession，生产路径）')
{
  // 前面的用例走的是 props.input / props.session 兼容分支；这里必须覆盖
  // 真实槽位给出的标准 prop 形态：useInput / useSession 是选择器函数。
  const env = setup()
  const drafted = []
  const inputState = { draft: '', phase: 'idle' }
  const sessionState = { sessionId: 'std', running: false, removed: false }

  const props = {
    sessionId: 'std',
    useInput: (selector) => selector(inputState),
    useSession: (selector) => selector(sessionState),
    inputActions: { setDraft: (text) => drafted.push(text) },
  }

  env.ghost.render(props)
  await settle()
  check('标准 props 下候选已展示', env.findGhostNode(env.ghost.render(props)) !== null)

  env.documentStub.activeElement = env.input
  env.input.value = ''
  const event = env.dispatchKey('ArrowRight')
  check('标准 props 下 → 能采纳', drafted.length === 1, JSON.stringify(drafted))
  check('标准 props 下写入正确内容', drafted[0] === '请继续，并说明判断依据', JSON.stringify(drafted))
  check('标准 props 下阻止了默认行为', event.defaultPrevented === true)

  // running: true 时不展示（SessionSnapshot.running 是权威字段）
  const runningProps = { ...props, useSession: (selector) => selector({ ...sessionState, running: true }) }
  check('标准 props 下运行中不展示', env.findGhostNode(env.ghost.render(runningProps)) === null)

  // removed: true 时同样不展示
  const removedProps = { ...props, useSession: (selector) => selector({ ...sessionState, removed: true }) }
  check('标准 props 下已移除不展示', env.findGhostNode(env.ghost.render(removedProps)) === null)

  // phase 为 submitting 时不生成新候选
  const submitting = setup()
  submitting.ghost.render({
    sessionId: 'std',
    useInput: (selector) => selector({ draft: '', phase: 'submitting' }),
    useSession: (selector) => selector(sessionState),
    inputActions: { setDraft: () => {} },
  })
  check('submitting 阶段不请求模型', submitting.fetchCalls.length === 0, String(submitting.fetchCalls.length))
}

console.log('\n自带输入提示的抑制（防叠字）')
{
  const env = setup({ editable: true })
  const props = {
    sessionId: 's',
    input: { draft: '', phase: 'idle' },
    inputActions: { setDraft: () => {} },
    session: { sessionId: 's', running: false },
  }

  env.ghost.render(props)
  await settle()
  env.ghost.render(props)
  check('展示时给输入框打上抑制标记', env.input.getAttribute('data-dsh-prompt-prefill') === 'on',
    String(env.input.getAttribute('data-dsh-prompt-prefill')))
  check('样式表按标记隐藏自带 placeholder', env.styleTags[0]?.textContent?.includes('[data-composer-placeholder]') === true)
  check('样式表同时清掉 :after 提示', env.styleTags[0]?.textContent?.includes('p:last-child:after') === true)

  const hidden = setup({ editable: true })
  hidden.ghost.render({ ...props, session: { sessionId: 's', running: true } })
  check('未展示时不留抑制标记', hidden.input.getAttribute('data-dsh-prompt-prefill') === null,
    String(hidden.input.getAttribute('data-dsh-prompt-prefill')))
}

console.log('\n锁定、取消、卸载与共享状态回归')
{
  const drafted = []
  const props = {
    sessionId: 'regression', input: { draft: '', phase: 'idle' },
    session: { running: false }, inputActions: { setDraft: (text) => drafted.push(text) },
  }
  const locked = setup()
  locked.ghost.render(props)
  await settle()
  locked.ghost.render(props)
  for (const phase of ['submitting', 'adjudicating']) {
    const tree = locked.ghost.render({ ...props, input: { draft: '', phase } })
    const event = locked.dispatchKey('ArrowRight')
    check(`${phase} 已有候选也隐藏`, locked.findGhostNode(tree) === null)
    check(`${phase} 不采纳也不拦截按键`, drafted.length === 0 && !event.defaultPrevented)
  }

  for (const outcome of ['success', 'failure']) {
    const pending = []
    const env = setup({ fetchPlan: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) })
    env.ghost.render(props)
    env.ghost.render({ ...props, session: { running: true } })
    env.ghost.render(props)
    check(`${outcome} 新一轮可以发起新请求`, pending.length === 2)
    if (outcome === 'success') pending[0].resolve({ json: async () => ({ ok: true, candidate: '旧建议' }) })
    else pending[0].reject(new Error('旧请求失败'))
    await settle()
    check(`${outcome} 迟到旧请求不显示候选`, env.findGhostNode(env.ghost.render(props)) === null)
    pending[1].resolve({ json: async () => ({ ok: true, candidate: '新建议' }) })
    await settle()
    check(`${outcome} 新请求仍能显示正确候选`, env.findGhostNode(env.ghost.render(props))?.children[0] === '新建议')
    check(`${outcome} 没有额外重复请求`, env.fetchCalls.length === 2)
    env.ghost.unmount()
  }

  const unloaded = setup()
  unloaded.ghost.render(props)
  await settle()
  unloaded.ghost.render(props)
  unloaded.ghost.unmount()
  check('ref 被摘掉后卸载仍恢复原生 placeholder', unloaded.input.getAttribute('data-dsh-prompt-prefill') === null)
  check('卸载后没有键盘监听残留', unloaded.keydownCount() === 0)

  const replayed = setup()
  replayed.ghost.render(props)
  replayed.ghost.replayEffects()
  await settle()
  check('StrictMode effect 重放后能展示候选', replayed.findGhostNode(replayed.ghost.flush()) !== null)
  check('StrictMode effect 重放复用同一请求', replayed.fetchCalls.length === 1, String(replayed.fetchCalls.length))
  replayed.ghost.unmount()

  const shared = setup()
  // 第二个实例与第一个看到同一个会话状态，不需要再模拟一次「正在回答」。
  const other = shared.makeGhost({ primeTurn: false })
  shared.ghost.render(props)
  other.render(props)
  await settle()
  check('第一个实例收到候选更新', shared.findGhostNode(shared.ghost.flush()) !== null)
  check('第二个实例也收到候选更新', shared.findGhostNode(other.flush()) !== null)
  check('同会话多实例只生成一次', shared.fetchCalls.length === 1)
  shared.ghost.unmount()
  check('一个实例卸载不清掉其他实例的 placeholder 标记', shared.input.getAttribute('data-dsh-prompt-prefill') === 'on')
  check('一个实例卸载不清掉其他实例的候选', shared.findGhostNode(other.flush()) !== null)
  shared.dispatchKey('Escape')
  check('剩余实例仍可关闭候选', shared.findGhostNode(other.flush()) === null)
  other.unmount()
  check('最后实例卸载恢复 placeholder', shared.input.getAttribute('data-dsh-prompt-prefill') === null)
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exitCode = failures === 0 ? 0 : 1
