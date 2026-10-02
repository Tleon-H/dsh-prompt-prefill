/**
 * dsh-prompt-prefill —— 浏览器半
 *
 * 交互契约：
 * - **Agent 回答结束时**（running: true → false），若输入框为空，就在输入框内以
 *   **浅灰色幽灵文本**预填充一条「用户接下来最可能想发」的提示词。此时它**不是**
 *   草稿：发送按钮不可用，也不会被提交。只打开或翻看会话不会触发生成
 *   （与 Claude Code 的 prompt suggestions 一致，避免白白调用模型）。
 * - 输入框为空且获得焦点时按 **Tab** 或 **→**，把这条幽灵文本写入草稿
 *   （一次可撤销的编辑）。
 * - 开始输入文字、或按 Escape，幽灵文本立即隐藏。
 *
 * 为什么是「浮层」而不是真的写进输入框：
 * 本版 Harness 没有内联建议（inline suggestion）API——我在发行版 `app.asar` 里
 * 检索过 `ghostText` / `setSuggestion` / `inlineSuggestion` 均无命中，只有 Button 的
 * `variant: "ghost"` 样式。参考项目 dsh-prompt-for-me 的 README 也写明：新版客户端
 * 用内联 ghost text，较旧客户端退化为「不修改草稿的轻量预览」。因此这里采用后者的
 * 思路，并把预览做成与输入框像素对齐的灰色文本，视觉上等价于内联幽灵文本。
 *
 * 之所以能做到像素对齐：幽灵文本只在**草稿为空**时出现，此时插入点必然在内容区
 * 左上角，所以只要把浮层的字体、内边距、行高与输入框的计算样式保持一致，
 * 再按输入框的包围盒定位即可。
 *
 * 关于输入框形态：DSH 桌面端 0.2.0-rc.2 的 composer 输入框是 Lexical 驱动的
 * `contentEditable` 容器（`<div data-composer-input contenteditable="true"
 * role="textbox">`），**不是** `<textarea>`。本文件同时兼容两种形态，
 * 详见 `domTextOf` / `findComposerInput` 的注释。
 *
 * 全部实现都是防御式的：取不到 slot、服务或 DOM 锚点时退化为「什么都不渲染」，
 * 绝不把输入区弄坏。
 *
 * @module dsh-prompt-prefill/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-prompt-prefill',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    const h = react.createElement

    /** 插件 id，同时用作样式标签标记。 */
    const ID = 'dsh-prompt-prefill'
    /** 宿主半注册的 RPC 路径。 */
    const RPC_PATH = '/dsh-prompt-prefill/rpc'
    /** 输入框的 DOM 锚点，来自 ui-conversation 的宿主组件。 */
    const INPUT_SELECTOR = '[data-composer-input]'
    /** 输入框所在卡片的 DOM 锚点。 */
    const CARD_SELECTOR = '[data-composer-card]'
    /** 一次会话内最多保留这么多字符的候选，防止异常长的模型输出撑爆浮层。 */
    const MAX_RENDER_CHARS = 2000

    const CSS = `
.dsh-pp-ghost {
  position: fixed;
  z-index: 3;
  pointer-events: none;
  margin: 0;
  border: 0;
  background: transparent;
  overflow: hidden;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: var(--dsw-alias-label-tertiary, #8a8f98);
  opacity: .78;
  user-select: none;
}
.dsh-pp-ghost[hidden] { display: none; }
/* 幽灵文本可见时，隐藏 Harness 自带的输入提示。
   空输入框上 Harness 会渲染自己的提示（[data-composer-placeholder] 节点，以及
   contenteditable 内 p:last-child:after { content: var(--dsh-composer-hint) }），
   位置与幽灵文本完全重合，同时出现会叠字。
   选择器依据：placeholder 是输入容器的**下一个兄弟节点**——Harness 自己的
   input[data-composer-composing] + .placeholder { visibility: hidden } 就是这么写的。
   标记属性由 alignGhost 一侧的 sync() 维护。 */
[data-composer-input][data-dsh-prompt-prefill="on"] + [data-composer-placeholder] { visibility: hidden; }
[data-composer-input][data-dsh-prompt-prefill="on"] p:last-child:after { content: none; }
`

    if (typeof document !== 'undefined') {
      try {
        if (document.querySelector(`style[data-plugin-css=${JSON.stringify(ID)}]`) === null) {
          const tag = document.createElement('style')
          tag.dataset.plugin = ID
          tag.dataset.pluginCss = ID
          tag.textContent = CSS
          document.head.appendChild(tag)
        }
      } catch {
        /* 没有 head 或被锁死的文档只会丢掉样式，不影响功能 */
      }
    }

    /**
     * 每个会话一份的候选状态。
     * 之所以按会话隔离：切换会话时不应该看到上一个会话的提示词。
     */
    const stores = new Map()

    /** 取（或建立）一个会话的状态。 */
    function storeFor(sessionId) {
      const key = typeof sessionId === 'string' ? sessionId : ''
      let store = stores.get(key)
      if (store === undefined) {
        store = {
          /** 当前可展示的候选；undefined 表示还没有。 */
          candidate: undefined,
          /** 'idle' | 'loading'。 */
          status: 'idle',
          /** 上一次失败的说明，仅用于 tooltip。 */
          note: undefined,
          /** 是否观察到 Agent 正在回答；变回空闲的那一刻即「一轮结束」。 */
          turnRunning: false,
          /**
           * 是否有一次「回答结束」等待消费。每次回答结束只生成一次：
           * 失败后不会因为重渲染而反复请求（模型不可用时的重试风暴），
           * 只打开会话也不会生成。
           */
          turnEnded: false,
          /** 正在进行的请求，用于去重与取消。 */
          controller: null,
          /** 请求身份与 AbortController 分开，取消或无 controller 时也能拒绝旧回调。 */
          request: null,
          /** 所有已挂载组件都要收到共享候选的更新。 */
          listeners: new Set(),
          /**
           * 当前有多少个组件实例正在使用这个 store。
           *
           * 槽位 scope 是 "session"，同一个会话理论上可能并存多个实例；
           * 再加上 React StrictMode 的 mount→unmount→mount 双挂载，
           * 若任一实例卸载就清空状态，会误伤仍在使用的那个实例
           * （表现为：刚出现的候选被立刻抹掉）。因此用计数决定真正清理的时机。
           */
          instances: 0,
          /** 交给 Harness 原生内联建议的 id；未使用原生接口时为 undefined。 */
          suggestionId: undefined,
          /** 上一次观察到的原生建议 id，用来区分「被 Escape 关闭」与「被采纳」。 */
          observedSuggestionId: undefined,
        }
        stores.set(key, store)
      }
      return store
    }

    /** 组件挂载时登记一个实例。 */
    function retainStore(store) {
      store.instances += 1
      return store
    }

    function notifyStore(store) {
      for (const listener of store.listeners) listener()
    }

    /**
     * 组件卸载时注销一个实例。
     *
     * 只有当**最后一个**实例离开时才真正清理并删除条目；否则仅让引用计数减一。
     * 延后一轮微任务清理，使 StrictMode 的 effect 重放仍使用同一个 store。
     *
     * @param key - 会话键（与 storeFor 使用的一致）。
     */
    function releaseStore(key, store) {
      store.instances -= 1
      if (store.instances > 0) return
      queueMicrotask(() => {
        if (store.instances > 0 || stores.get(key) !== store) return
        resetStore(store)
        stores.delete(key)
      })
    }

    /** 清掉一个会话的候选与在途请求。 */
    function resetStore(store) {
      // 先失效身份，再取消传输；取消产生的回调也不能改写状态。
      store.request = null
      if (store.controller !== null) {
        try {
          store.controller.abort()
        } catch {
          /* 已结束的请求再取消一次不是错误 */
        }
        store.controller = null
      }
      store.candidate = undefined
      store.status = 'idle'
      store.note = undefined
      store.turnEnded = false
      store.suggestionId = undefined
      store.observedSuggestionId = undefined
      notifyStore(store)
    }

    /**
     * 向宿主半请求一条候选提示词。
     *
     * @param sessionId - 会话 id。
     * @param draft - 当前草稿（通常为空；非空时宿主半也能据此判断意图）。
     * @param store - 该会话的状态对象。
     */
    function generate(sessionId, draft, store) {
      if (store.status === 'loading') return

      let controller
      try {
        controller = new AbortController()
      } catch {
        controller = null
      }

      store.status = 'loading'
      store.note = undefined
      store.controller = controller
      const requestToken = {}
      store.request = requestToken
      notifyStore(store)

      const finish = (candidate, note) => {
        if (store.request !== requestToken || controller?.signal.aborted) return
        // 失败时界面上什么都不显示，留一条控制台日志便于排查（Ctrl+Shift+I 查看）。
        if (note !== undefined) {
          try {
            console.warn(`dsh-prompt-prefill: 没有拿到提示词：${note}`)
          } catch {
            /* 没有 console 不影响功能 */
          }
        }
        store.request = null
        store.controller = null
        store.status = 'idle'
        store.note = note
        if (typeof candidate === 'string' && candidate !== '') {
          store.candidate = candidate
        }
        notifyStore(store)
      }

      let request
      try {
        request = window.fetch(RPC_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, draft }),
          ...(controller === null ? {} : { signal: controller.signal }),
        })
      } catch (error) {
        finish(undefined, `请求失败：${String(error?.message ?? error)}`)
        return
      }

      Promise.resolve(request)
        .then((response) => {
          // 路由未注册时宿主会回 404 页面，直接 json() 只会得到一句难懂的解析错误。
          if (response && response.ok === false && response.status === 404) {
            throw new Error('宿主半的 RPC 路由不存在（404），请确认插件已启用并重启桌面端')
          }
          return response.json()
        })
        .then((payload) => {
          if (!payload || payload.ok !== true) {
            // 失败响应没有候选，不影响输入框的其他功能。
            finish(undefined, typeof payload?.message === 'string' ? payload.message : '没有可用的提示词')
            return
          }
          const candidate = typeof payload.candidate === 'string' ? payload.candidate : ''
          finish(candidate.slice(0, MAX_RENDER_CHARS), undefined)
        })
        .catch((error) => {
          const aborted = controller !== null && controller.signal.aborted === true
          finish(undefined, aborted ? undefined : `请求失败：${String(error?.message ?? error)}`)
        })
    }

    /**
     * 把幽灵浮层对齐到 textarea 的内容区。
     *
     * 只在草稿为空时展示，所以插入点一定在左上角；这里把 textarea 的计算样式
     * 里影响排版的属性逐一复制到浮层，再用包围盒定位，从而与真实文字严丝合缝。
     *
     * @param ghost - 浮层元素。
     * @param input - textarea 元素。
     */
    function alignGhost(ghost, input) {
      if (!ghost || !input || typeof window.getComputedStyle !== 'function') return
      const rect = input.getBoundingClientRect()
      const style = window.getComputedStyle(input)

      const copy = [
        'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing',
        'lineHeight', 'textAlign', 'textIndent', 'textTransform', 'wordSpacing',
        'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
        'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
        'boxSizing',
      ]
      for (const property of copy) {
        const value = style[property]
        if (typeof value === 'string' && value !== '') ghost.style[property] = value
      }

      ghost.style.left = `${rect.left}px`
      ghost.style.top = `${rect.top}px`
      ghost.style.width = `${rect.width}px`
      ghost.style.height = `${rect.height}px`
      ghost.style.maxHeight = `${rect.height}px`
    }

    /**
     * 读取输入框当前的可见文本。
     *
     * **这是本插件最容易踩的一个坑**：DSH 的 composer 输入框不是 `<textarea>`，
     * 而是 Lexical 驱动的 `contentEditable` 容器（`<div data-composer-input
     * contenteditable="true" role="textbox">`）。它的 `.value` 恒为 `undefined`，
     * 文本在 `.textContent` 里。若按 textarea 的 `.value !== ''` 判断「是否为空」，
     * 会得到 `undefined !== ''` → 永远判定为「非空」→ 右方向键永远不生效。
     *
     * 因此两种形态都要支持：`<textarea>` 读 `.value`，contentEditable 读
     * `.textContent`。
     *
     * @param input - 输入框元素。
     * @returns 当前文本；无法读取时返回空串。
     */
    function domTextOf(input) {
      if (!input) return ''
      if (typeof input.value === 'string') return input.value
      if (typeof input.textContent === 'string') return input.textContent
      return ''
    }

    /** 输入框是否是空白的（忽略纯空白）。 */
    function domIsEmpty(input) {
      return domTextOf(input).trim() === ''
    }

    /**
     * 找到这个浮层所属 composer 卡片里的输入容器。
     *
     * 优先用 `[data-composer-input]` 锚点；同时兼容更早/更晚版本把它渲染成
     * `<textarea>` 的形态。两者都必须能命中，否则整个交互失效。
     *
     * @param anchor - 浮层的锚点元素（位于同一张 composer 卡片内）。
     */
    function findComposerInput(anchor) {
      if (!anchor || typeof anchor.closest !== 'function') return null
      const card = anchor.closest(CARD_SELECTOR)
      if (!card) return null
      const candidate = card.querySelector(INPUT_SELECTOR) ?? card.querySelector('textarea')
      if (candidate === null || candidate === undefined) return null
      const isTextarea = candidate.tagName === 'TEXTAREA'
      const isEditable = candidate.isContentEditable === true
        || candidate.getAttribute?.('contenteditable') === 'true'
      return isTextarea || isEditable ? candidate : null
    }

    /**
     * 恒等选择器。
     *
     * 提到模块作用域而不是写在组件里，是因为 `useInput` 是基于
     * useSyncExternalStore 的快照选择器：一个稳定的引用更符合它的用法。
     */
    const selectSelf = (state) => state

    /** 原生建议 id 的自增序号，保证每次提交的 id 都不同。 */
    let nativeSeq = 0

    /** 读取 InputState 快照里的草稿。 */
    function draftOf(input) {
      return input && typeof input.draft === 'string' ? input.draft : ''
    }

    /** 是否处于不可编辑的状态（正在裁决或提交）。 */
    function inputLocked(input) {
      const phase = input && typeof input.phase === 'string' ? input.phase : 'idle'
      return phase === 'adjudicating' || phase === 'submitting'
    }

    // 同一输入框可能有多个浮层：每个实例只释放自己的抑制标记。
    const placeholderUsers = new WeakMap()
    function suppressPlaceholder(input) {
      placeholderUsers.set(input, (placeholderUsers.get(input) ?? 0) + 1)
      input.setAttribute?.('data-dsh-prompt-prefill', 'on')
      return () => {
        const remaining = (placeholderUsers.get(input) ?? 1) - 1
        if (remaining > 0) placeholderUsers.set(input, remaining)
        else {
          placeholderUsers.delete(input)
          input.removeAttribute?.('data-dsh-prompt-prefill')
        }
      }
    }

    /**
     * 幽灵文本组件。
     *
     * 注册进 `conversation.input.overlay`：该槽位渲染在常驻 composer 卡片**内部**，
     * 因此可以就近找到同一张卡片里的输入框，并且随会话挂载/卸载。
     *
     * 只使用该槽位**文档化**的标准 props（见 `Slots.listSubTree` 的 standardProps）：
     * `useInput`、`inputActions`、`useSession`、`sessionId`。
     * 注意：这里刻意**不**依赖一个裸的 `props.session`——槽位标准属性里只有
     * `useSession` 选择器与 `sessionId`，而且 `SessionSnapshot` 并没有 `turnEnds`
     * 字段，所以「轮次是否结束」只能由 `running` 的跳变推断（见下）。
     *
     * @param props - 槽位标准属性。
     */
    function GhostPrefill(props) {
      const sessionId = typeof props?.sessionId === 'string'
        ? props.sessionId
        : (typeof props?.session?.sessionId === 'string' ? props.session.sessionId : undefined)
      const actions = props?.inputActions

      // `useInput` / `useSession` 都是槽位标准 prop。同时兼容把快照直接挂在
      // `props.input` / `props.session` 上的形态，便于测试与旧版本。
      const inputSnapshot = typeof props?.useInput === 'function'
        ? props.useInput(selectSelf)
        : props?.input
      const sessionSnapshot = typeof props?.useSession === 'function'
        ? props.useSession(selectSelf)
        : props?.session

      const draft = draftOf(inputSnapshot)
      const running = sessionSnapshot?.running === true
      // 会话已被移除（归档/删除）时不应再展示或生成。
      const removed = sessionSnapshot?.removed === true
      const busy = running || removed
      const locked = inputLocked(inputSnapshot)

      const anchorRef = react.useRef(null)
      const ghostRef = react.useRef(null)
      const [, forceRender] = react.useReducer((value) => value + 1, 0)
      const interactionRef = react.useRef(null)
      interactionRef.current = { draft, busy, locked, actions }

      const store = storeFor(sessionId)

      // 会话切换或卸载时注销本实例。用引用计数而不是直接清空：
      // 同一会话可能并存多个实例（槽位 scope = session），StrictMode 也会
      // mount→unmount→mount 双挂载；直接清空会误伤仍在使用的那个实例。
      // 只有最后一个实例离开时才真正清理。
      react.useEffect(() => {
        const key = typeof sessionId === 'string' ? sessionId : ''
        retainStore(store)
        store.listeners.add(forceRender)
        // 补上 render 到订阅之间可能已经发生的共享状态更新。
        forceRender()
        return () => {
          store.listeners.delete(forceRender)
          releaseStore(key, store)
        }
      }, [sessionId, store, forceRender])

      // Agent 开始回答时，上一轮的候选已经过期：清掉候选，并记下「正在回答」；
      // 等它重新空闲下来（running: true → false）时登记一次「回答结束」，
      // 由下面的生成 effect 消费。
      //
      // 这里用不到 `turnEnds`：`SessionSnapshot` 只提供 running/removed 等字段，
      // 而 running 的跳变恰好就是「一轮结束」这个时机。
      react.useEffect(() => {
        if (!busy) {
          if (store.turnRunning) {
            store.turnRunning = false
            store.turnEnded = true
          }
          return
        }
        // 原生建议也要一起撤下，避免回答过程中残留上一轮的灰字。
        const dismiss = interactionRef.current?.actions?.dismissSuggestion
        if (store.suggestionId !== undefined && typeof dismiss === 'function') {
          try {
            dismiss(store.suggestionId)
          } catch {
            /* 已被 Harness 自己撤下 */
          }
        }
        resetStore(store)
        // 会话被移除不算「回答中」，之后也不会有「回答结束」。
        store.turnRunning = running
      }, [busy, running, store])

      // 生成时机：刚有一轮回答结束、草稿为空、会话空闲、还没有候选、也没有在途请求。
      // 回答结束时草稿不为空（用户已经在打字）就先挂着，等草稿清空再生成。
      react.useEffect(() => {
        if (sessionId === undefined || !store.turnEnded) return
        if (draft !== '' || busy || locked) return
        if (store.candidate !== undefined || store.status === 'loading') return
        store.turnEnded = false
        generate(sessionId, '', store)
      }, [sessionId, draft, busy, locked, store])

      const candidate = draft === '' && !busy && !locked ? store.candidate : undefined
      const eligible = typeof candidate === 'string' && candidate !== ''

      // Harness 较新版本在 inputActions 上提供原生内联建议（offerSuggestion /
      // dismissSuggestion，输入快照里有 suggestion 字段），由它负责灰字显示和
      // Tab / → 采纳，与 dsh-prompt-for-me 用的是同一套接口。有原生接口时就交给
      // Harness，自绘浮层与按键拦截全部关闭；没有时才退回自绘浮层。
      const native = typeof actions?.offerSuggestion === 'function'
      const nativeSuggestionId = typeof inputSnapshot?.suggestion?.id === 'string'
        ? inputSnapshot.suggestion.id
        : undefined
      const visible = eligible && !native

      react.useEffect(() => {
        if (!native) return
        const ownId = store.suggestionId
        const wasShown = ownId !== undefined && store.observedSuggestionId === ownId
        store.observedSuggestionId = nativeSuggestionId
        // 草稿仍为空时我们的建议消失了：用户按了 Escape，尊重关闭，本轮不再出现。
        // （被采纳时草稿会变成非空，走不到这里。）
        if (wasShown && nativeSuggestionId !== ownId && draft === '' && !busy && !locked) {
          store.candidate = undefined
          store.suggestionId = undefined
          notifyStore(store)
          return
        }
        if (!eligible || (ownId !== undefined && nativeSuggestionId === ownId)) return
        nativeSeq += 1
        const id = `${ID}:${sessionId}:${nativeSeq}`
        let offered = false
        try {
          offered = actions.offerSuggestion({ id, text: candidate }) === true
        } catch {
          offered = false
        }
        if (offered) {
          store.suggestionId = id
          return
        }
        // Harness 拒绝（例如此时输入框不适合显示建议）：尊重它，不再强行展示。
        store.candidate = undefined
        store.suggestionId = undefined
        notifyStore(store)
      }, [native, eligible, candidate, nativeSuggestionId, draft, busy, locked, sessionId, actions, store])

      // 展示时对齐浮层；随窗口尺寸/滚动变化重新对齐。
      react.useEffect(() => {
        const ghost = ghostRef.current
        if (!visible || !ghost) return
        let markedInput = null
        let restorePlaceholder = null

        const sync = () => {
          const input = findComposerInput(anchorRef.current)
          if (markedInput !== input) {
            restorePlaceholder?.()
            markedInput = input
            restorePlaceholder = null
          }
          if (input === null) {
            ghost.hidden = true
            return
          }
          ghost.hidden = false
          // 打上标记，让样式表隐藏 Harness 自带的输入提示（否则与幽灵文本叠字）。
          try {
            restorePlaceholder ??= suppressPlaceholder(input)
          } catch {
            /* 只读属性不是失败 */
          }
          alignGhost(ghost, input)
        }

        sync()
        // 用 rAF 再对齐一次：卡片高度/宽度常常在同一帧之后才稳定。
        let frame = 0
        try {
          frame = window.requestAnimationFrame(sync)
        } catch {
          frame = 0
        }

        let observer
        try {
          const input = findComposerInput(anchorRef.current)
          if (input !== null && typeof ResizeObserver === 'function') {
            observer = new ResizeObserver(sync)
            observer.observe(input)
            // 同时观察卡片：附件栏、notice、工具栏换行都会改变卡片高度/宽度，
            // 而输入框自身的尺寸不一定变化。只观察 input 会漏掉这些重排。
            const card = typeof input.closest === 'function' ? input.closest(CARD_SELECTOR) : null
            if (card !== null && card !== undefined) observer.observe(card)
          }
        } catch {
          observer = undefined
        }

        window.addEventListener('resize', sync)
        window.addEventListener('scroll', sync, true)
        return () => {
          if (frame !== 0) {
            try {
              window.cancelAnimationFrame(frame)
            } catch {
              /* 已取消 */
            }
          }
          observer?.disconnect()
          window.removeEventListener('resize', sync)
          window.removeEventListener('scroll', sync, true)
          // 收起时务必摘掉标记，把 Harness 自带的提示还给用户。
          try {
            // 使用 effect 实际标记过的节点；卸载时 anchorRef 已经被摘掉。
            restorePlaceholder?.()
          } catch {
            /* 节点已卸载 */
          }
        }
      }, [visible, candidate])

      // Tab / 右方向键采纳（与 Claude Code、Harness 原生建议一致）。
      // 挂在捕获阶段，确保先于输入框的默认行为（光标移动、Tab 切换焦点）执行。
      react.useEffect(() => {
        if (!visible || sessionId === undefined || typeof actions?.setDraft !== 'function') return

        const onKeyDown = (event) => {
          if (event.key !== 'ArrowRight' && event.key !== 'Tab') return
          if (event.defaultPrevented || event.isComposing || event.repeat) return
          // 带修饰键的 → / Tab 是别的操作（选区移动、Shift+Tab 反向切换焦点等），不拦截。
          if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
          const current = interactionRef.current
          if (!current || current.busy || current.locked || current.draft !== '') return
          if (typeof current.actions?.setDraft !== 'function') return
          if (store.candidate !== candidate) return

          const input = findComposerInput(anchorRef.current)
          if (input === null) return
          // 焦点判定：contentEditable 场景下 Lexical 可能把焦点放在输入容器
          // 自身或其子节点上，因此既接受「焦点就是该元素」，也接受「焦点在
          // 该元素内部」。两者都不是时不拦截。
          const focused = document.activeElement
          if (focused !== input && !(typeof input.contains === 'function' && input.contains(focused))) return
          // 只有「输入框真的为空」时才采纳，避免抢走正常的行内光标移动。
          // 注意：输入框是 contentEditable div（没有 .value），所以必须用
          // domIsEmpty 而不是直接比较 input.value。
          if (!domIsEmpty(input) || draft !== '') return

          event.preventDefault()
          event.stopPropagation()

          const text = candidate
          try {
            current.actions.setDraft(text)
          } catch {
            // 写入被拒绝时保留候选，用户可以再按一次。
            return
          }
          // 刻意不清掉候选：写入后草稿非空，`visible` 已经为假、幽灵文本会自动
          // 隐藏；用户把文字清空后候选可以重新出现，不必再请求一次模型。
          // 双保险：此时草稿已非空，即使事件再次触发也不会重复写入。
          forceRender()
        }

        window.addEventListener('keydown', onKeyDown, true)
        return () => window.removeEventListener('keydown', onKeyDown, true)
      }, [visible, candidate, draft, sessionId, actions, store])

      // Escape 关闭幽灵文本。
      react.useEffect(() => {
        if (!visible) return
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return
          const input = findComposerInput(anchorRef.current)
          if (input === null) return
          const focused = document.activeElement
          if (focused !== input && !(typeof input.contains === 'function' && input.contains(focused))) return
          store.candidate = undefined
          notifyStore(store)
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
      }, [visible, store])

      // 定位用的零尺寸锚点始终渲染；幽灵文本只在有候选时渲染。
      return h(
        react.Fragment,
        null,
        h('span', { ref: anchorRef, 'aria-hidden': 'true', style: { display: 'none' } }),
        visible
          ? h(
            'div',
            {
              ref: ghostRef,
              className: 'dsh-pp-ghost',
              'aria-hidden': 'true',
              'data-dsh-prompt-prefill': 'ghost',
              title: store.note ?? '按 Tab 或 → 填入这条提示词，Escape 关闭',
            },
            candidate,
          )
          : null,
      )
    }

    const name = 'dsh-prompt-prefill-client'
    const inject = ['slots']

    /**
     * 注册浮层进 composer 卡片内部。
     *
     * 该版本没有声明 `conversation.input.overlay` 时，`inject` 回调不会执行，
     * 插件安静地降级为「什么都不显示」，而不是让整个输入区报错。
     *
     * @param ctx - 客户端 cordis context。
     */
    function apply(ctx) {
      try {
        // 与 dsh-prompt-for-me 一致，优先用 ctx.get 取服务；属性访问只作兼容。
        const slots = (typeof ctx?.get === 'function' ? ctx.get('slots') : undefined) ?? ctx?.slots
        if (typeof slots?.inject !== 'function' || typeof slots?.register !== 'function') {
          ctx?.logger?.warn?.('dsh-prompt-prefill: slots 服务不可用，未注册任何界面')
          return
        }
        slots.inject('conversation.input.overlay', () => slots.register({
          name: 'conversation.input.overlay',
          id: 'prompt-prefill',
          order: 40,
          label: '提示词预填充 / Prompt prefill',
        }, GhostPrefill))
      } catch (error) {
        ctx?.logger?.warn?.(`dsh-prompt-prefill: 无法注册浮层：${String(error?.message ?? error)}`)
      }
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = name
    return module.exports
  },
})
