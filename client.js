/**
 * dsh-material-cards — the brand's material notes, as a card you can drop into the composer.
 *
 * Why it lives in the composer: the notes are only useful at the moment a message is being
 * written. Copying a card out of a side panel and pasting it is the same manual step this
 * plugin exists to delete, so the search surface opens *in* the input area and writes straight
 * into the draft.
 *
 * Insertion goes through `inputActions`, never through a synthetic DOM write: the composer is a
 * contenteditable editor, so setting text by hand would desync its undo history and its model.
 * `captureInsertion()` + `insertText()` keeps the card a single undoable edit; `setDraft()` is
 * the documented fallback when the host bridge is missing.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-material-cards',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    const NS = 'dsh-material-cards'
    const SEARCH_ROUTE = '/plugins/material-cards/search'
    const CARD_ROUTE = '/plugins/material-cards/card'
    const DEBOUNCE_MS = 180
    const LIMIT = 12
    const NOTE_MS = 2600

    const zh = {
      entry: '材料卡',
      entryHint: '搜材料库，插入一张成品卡',
      search: '搜材料：名称、成分、工艺…',
      total: '共 {n} 篇',
      matches: '命中 {n} 篇',
      loading: '搜索中…',
      empty: '没有匹配的材料',
      emptyAll: '材料库里还没有笔记',
      hint: '↑↓ 选择 · Enter 插入 · Esc 关闭',
      hits: '正文 {n} 处',
      picked: '已插入：{name}',
      insertFailed: '插入失败，请重试',
      loadFailed: '材料库读不到：{message}',
      cardFailed: '这张卡取不回来，再试一次',
      panel: '材料卡'
    }

    const en = {
      entry: 'Material cards',
      entryHint: 'Search the material notes and insert a finished card',
      search: 'Search materials: name, composition, process…',
      total: '{n} notes',
      matches: '{n} matches',
      loading: 'Searching…',
      empty: 'No matching material',
      emptyAll: 'The material library is empty',
      hint: '↑↓ to move · Enter to insert · Esc to close',
      hits: '{n} hits in the body',
      picked: 'Inserted: {name}',
      insertFailed: 'Insert failed, try again',
      loadFailed: 'Cannot read the library: {message}',
      cardFailed: 'Could not load that card, try again',
      panel: 'Material cards'
    }

    /**
     * The draft is only reachable inside render (`useInput` is a bare selector hook — calling it
     * from an event handler throws), but the insert happens on click. A child that renders just
     * to read the value is the smallest thing that satisfies both.
     */
    let currentDraft = ''

    function DraftTap({ useInput }) {
      let text = ''
      try {
        text = useInput((state) => (state !== null && state !== undefined && state.draft) || '')
      } catch {
        text = ''
      }
      useEffect(() => {
        currentDraft = typeof text === 'string' ? text : ''
      }, [text])
      return null
    }

    /** One undoable insertion when the host bridge exists, a plain draft replace when it does not. */
    function insertCard(inputActions, text) {
      if (inputActions === null || typeof inputActions !== 'object') return 'unsupported'
      const base = currentDraft
      const glue = base.length === 0 ? '' : base.endsWith('\n\n') ? '' : base.endsWith('\n') ? '\n' : '\n\n'
      const canEdit =
        typeof inputActions.insertText === 'function' && typeof inputActions.captureInsertion === 'function'
      if (canEdit) {
        try {
          const capture = inputActions.captureInsertion()
          const rev = capture !== null && capture !== undefined && typeof capture.draftRev === 'number' ? capture.draftRev : null
          const at = base.length
          // The revision only describes the selection it was captured with, so an append is
          // possible only when the caret already sits at the end of the draft.
          if (rev !== null && capture.start === at && capture.end === at) {
            if (inputActions.insertText(glue + text, { draftRev: rev, start: at, end: at }) === true) return 'inserted'
          }
        } catch {
          /* fall through to the documented fallback */
        }
      }
      if (typeof inputActions.setDraft === 'function') {
        try {
          inputActions.setDraft(base + glue + text)
          return 'appended'
        } catch {
          return 'failed'
        }
      }
      return 'unsupported'
    }

    const store = {
      snap: { open: false, query: '', items: [], total: 0, loading: false, error: '', active: 0, note: '' },
      listeners: new Set(),
      timer: 0,
      seq: 0,
      noteTimer: 0,
      get() {
        return store.snap
      },
      subscribe(listener) {
        store.listeners.add(listener)
        return () => {
          store.listeners.delete(listener)
        }
      },
      set(patch) {
        let changed = false
        for (const key of Object.keys(patch)) {
          if (store.snap[key] !== patch[key]) {
            changed = true
            break
          }
        }
        if (!changed) return
        store.snap = { ...store.snap, ...patch }
        for (const listener of store.listeners) listener(store.snap)
      },
      open() {
        store.set({ open: true })
        void store.search(store.snap.query, true)
      },
      close() {
        if (store.timer !== 0) {
          clearTimeout(store.timer)
          store.timer = 0
        }
        store.set({ open: false, active: 0 })
      },
      toggle() {
        if (store.snap.open) store.close()
        else store.open()
      },
      type(query) {
        store.set({ query, active: 0 })
        if (store.timer !== 0) clearTimeout(store.timer)
        store.timer = setTimeout(() => {
          store.timer = 0
          void store.search(store.snap.query, false)
        }, DEBOUNCE_MS)
      },
      move(delta) {
        const count = store.snap.items.length
        if (count === 0) return
        const next = (store.snap.active + delta + count) % count
        store.set({ active: next })
      },
      async search(query, immediate) {
        const ticket = (store.seq += 1)
        store.set({ loading: true, error: '' })
        try {
          const url = `${SEARCH_ROUTE}?q=${encodeURIComponent(query)}&limit=${LIMIT}`
          const response = await fetch(url, { headers: { accept: 'application/json' } })
          const body = await response.json()
          if (ticket !== store.seq) return
          if (body?.ok !== true) {
            store.set({ loading: false, error: String(body?.error ?? 'failed'), items: [], total: 0 })
            return
          }
          store.set({
            loading: false,
            error: '',
            items: Array.isArray(body.results) ? body.results : [],
            total: Number(body.total) || 0,
            active: 0
          })
        } catch (error) {
          if (ticket !== store.seq) return
          store.set({ loading: false, error: String(error?.message ?? error), items: [], total: 0 })
          if (immediate === true) store.set({ active: 0 })
        }
      },
      note(text) {
        if (store.noteTimer !== 0) clearTimeout(store.noteTimer)
        store.set({ note: text })
        store.noteTimer = setTimeout(() => {
          store.noteTimer = 0
          store.set({ note: '' })
        }, NOTE_MS)
      },
      async fetchCard(slug) {
        const url = `${CARD_ROUTE}?slug=${encodeURIComponent(slug)}`
        const response = await fetch(url, { headers: { accept: 'application/json' } })
        const body = await response.json()
        if (body?.ok !== true || typeof body.prompt !== 'string') throw new Error(String(body?.error ?? 'failed'))
        return { prompt: body.prompt, title: String(body.card?.title ?? slug) }
      },
      reset() {
        if (store.timer !== 0) clearTimeout(store.timer)
        if (store.noteTimer !== 0) clearTimeout(store.noteTimer)
        store.timer = 0
        store.noteTimer = 0
        store.listeners.clear()
        store.snap = { open: false, query: '', items: [], total: 0, loading: false, error: '', active: 0, note: '' }
      }
    }

    function Glyph({ size = 15 }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true'
        },
        h('rect', { x: 3, y: 4.5, width: 12, height: 15, rx: 2.5 }),
        h('path', { d: 'M6 8.5h6M6 11.5h6M6 14.5h3.5' }),
        h('circle', { cx: 16.8, cy: 15.6, r: 3.1 }),
        h('path', { d: 'M18.9 17.8L21 20' })
      )
    }

    function Entry({ label }) {
      const [open, setOpen] = useState(store.get().open)
      useEffect(() => {
        setOpen(store.get().open)
        return store.subscribe((snap) => setOpen(snap.open))
      }, [])
      const onClick = useCallback(() => {
        store.toggle()
      }, [])
      return h(
        'button',
        {
          type: 'button',
          className: 'mc-entry',
          'data-open': open ? '1' : '0',
          onClick,
          title: label,
          'aria-label': label,
          'aria-expanded': open
        },
        h(Glyph, null)
      )
    }

    function Panel(props) {
      const { useInput, inputActions, t } = props
      const [state, setState] = useState(store.get())
      const inputRef = useRef(null)
      useEffect(() => {
        setState(store.get())
        return store.subscribe(setState)
      }, [])
      useEffect(() => {
        if (state.open && inputRef.current !== null && typeof inputRef.current.focus === 'function') {
          inputRef.current.focus()
        }
      }, [state.open])
      const pick = useCallback(
        async (index) => {
          const item = store.get().items[index]
          if (item === undefined) return
          try {
            const card = await store.fetchCard(item.slug)
            const mode = insertCard(inputActions, card.prompt)
            if (mode === 'failed' || mode === 'unsupported') {
              store.note(t('insertFailed'))
              return
            }
            store.note(t('picked', { name: card.title }))
            store.close()
          } catch {
            store.note(t('cardFailed'))
          }
        },
        [inputActions, t]
      )
      const onKeyDown = useCallback(
        (event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            store.close()
            return
          }
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            store.move(1)
            return
          }
          if (event.key === 'ArrowUp') {
            event.preventDefault()
            store.move(-1)
            return
          }
          if (event.key === 'Enter') {
            event.preventDefault()
            void pick(store.get().active)
          }
        },
        [pick]
      )
      if (!state.open) return null
      const rows = state.items.map((item, index) =>
        h(
          'button',
          {
            type: 'button',
            key: item.slug,
            className: 'mc-row',
            'data-active': index === state.active ? '1' : '0',
            onMouseEnter: () => store.set({ active: index }),
            onClick: () => void pick(index)
          },
          h(
            'span',
            { className: 'mc-rowhead' },
            h('span', { className: 'mc-name' }, item.title),
            h('span', { className: 'mc-rowmeta' }, item.hits > 0 ? t('hits', { n: item.hits }) : item.confidence)
          ),
          item.tags.length > 0
            ? h('span', { className: 'mc-tags' }, item.tags.slice(0, 4).join(' · '))
            : null
        )
      )
      return h(
        'div',
        { className: 'mc-panel', role: 'dialog', 'aria-label': t('panel') },
        typeof useInput === 'function' ? h(DraftTap, { useInput }) : null,
        h(
          'div',
          { className: 'mc-search' },
          h('input', {
            ref: inputRef,
            className: 'mc-input',
            type: 'text',
            value: state.query,
            placeholder: t('search'),
            spellCheck: false,
            onChange: (event) => store.type(event.target.value),
            onKeyDown
          }),
          h('span', { className: 'mc-count' }, state.query.length > 0 ? t('matches', { n: state.items.length }) : t('total', { n: state.total }))
        ),
        state.error.length > 0
          ? h('div', { className: 'mc-note mc-bad' }, t('loadFailed', { message: state.error }))
          : null,
        state.loading && state.items.length === 0 ? h('div', { className: 'mc-note' }, t('loading')) : null,
        state.loading || state.items.length > 0
          ? h('div', { className: 'mc-list' }, rows)
          : h('div', { className: 'mc-note' }, state.query.length > 0 ? t('empty') : t('emptyAll')),
        h(
          'div',
          { className: 'mc-foot' },
          h('span', { className: 'mc-hint' }, t('hint')),
          state.note.length > 0 ? h('span', { className: 'mc-toast' }, state.note) : null
        )
      )
    }

    const CSS = `
.mc-entry{
  display:inline-flex;align-items:center;justify-content:center;
  width:26px;height:26px;padding:0;border-radius:8px;
  border:1px solid transparent;background:transparent;
  color:var(--dsw-alias-label-tertiary,#8a8a8a);
  cursor:pointer;transition:background-color var(--dsh-claude-timing-feedback,120ms ease),color var(--dsh-claude-timing-feedback,120ms ease),border-color var(--dsh-claude-timing-feedback,120ms ease);
}
.mc-entry:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12));color:var(--dsw-alias-label-primary,#ececec)}
.mc-entry[data-open="1"]{border-color:var(--dsw-alias-border-l1,currentColor);color:var(--dsw-alias-label-primary,#ececec)}
.mc-entry:focus-visible{outline:2px solid var(--dsw-focus-ring-color,#4d6bfe);outline-offset:-2px}
.mc-panel{
  /* Same anchor contract as the host's own popupSelect: absolute above the composer,
     full width, clamped height, own elevation. */
  position:absolute;bottom:calc(100% + 6px);left:0;right:0;z-index:100;
  box-sizing:border-box;display:flex;flex-direction:column;
  min-width:min(240px,100%);max-height:min(360px,46vh);padding:6px;
  border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.3));border-radius:12px;
  background-color:var(--dsw-alias-bg-base,#191919);
  background-image:linear-gradient(var(--dsw-alias-bg-layer-2,#232323),var(--dsw-alias-bg-layer-2,#232323));
  box-shadow:var(--dsw-elevation-prominent,var(--dsw-alias-shadow-lv2,0 4px 16px rgba(0,0,0,.3)));
  overflow:hidden;
  animation:mc-in var(--dsh-claude-duration-enter,320ms) var(--dsh-claude-ease-enter,ease) both;
}
@keyframes mc-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
.mc-search{display:flex;align-items:center;gap:8px;padding:2px 4px 6px;border-bottom:0.5px solid var(--dsh-claude-divider,rgba(128,128,128,.28))}
.mc-input{
  flex:1;min-width:0;border:0;outline:none;padding:4px 2px;
  background:transparent;color:var(--dsw-alias-label-primary,#ececec);
  font-size:12.5px;line-height:1.5;font-family:inherit;
}
.mc-input::placeholder{color:var(--dsw-alias-label-tertiary,#8a8a8a)}
.mc-count{flex:none;font-size:10px;line-height:1.4;letter-spacing:.03em;color:var(--dsw-alias-label-tertiary,#8a8a8a)}
.mc-list{display:flex;flex-direction:column;gap:1px;min-height:0;overflow-y:auto;padding:4px 0 2px}
.mc-list::-webkit-scrollbar{width:8px}
.mc-list::-webkit-scrollbar-thumb{background:var(--dsh-scrollbar-thumb,rgba(128,128,128,.4));border-radius:8px}
.mc-row{
  display:flex;flex-direction:column;gap:1px;text-align:left;
  padding:4px 8px 5px;border:0;border-radius:8px;background:transparent;
  color:var(--dsw-alias-label-primary,#ececec);cursor:pointer;
  transition:background-color var(--dsh-claude-timing-feedback,120ms ease);
}
.mc-row[data-active="1"]{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.14))}
.mc-rowhead{display:flex;align-items:baseline;gap:8px;min-width:0}
.mc-name{flex:1;min-width:0;font-size:12.5px;line-height:1.45;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mc-tags{font-size:10.5px;line-height:1.4;color:var(--dsw-alias-label-secondary,#b4b4b4);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mc-rowmeta{flex:none;font-size:10px;line-height:1.4;color:var(--dsw-alias-label-tertiary,#8a8a8a);font-family:var(--dsh-claude-font-code,ui-monospace,SFMono-Regular,Menlo,monospace);opacity:.85}
.mc-note{padding:10px 8px;font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-tertiary,#8a8a8a)}
.mc-note.mc-bad{color:var(--dsw-alias-state-warn-label,#c98a12)}
.mc-foot{display:flex;align-items:center;gap:10px;padding:5px 6px 1px;border-top:0.5px solid var(--dsh-claude-divider,rgba(128,128,128,.28))}
.mc-hint{font-size:10px;line-height:1.4;color:var(--dsw-alias-label-tertiary,#8a8a8a)}
.mc-toast{font-size:10.5px;line-height:1.4;margin-left:auto;color:var(--dsw-alias-brand-primary,#d97757)}
@media (prefers-reduced-motion:reduce){
  .mc-panel{animation:none}
  .mc-entry,.mc-row{transition:none}
}
`

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => {
          const disposeZh = ctx.locale.register(NS, 'zh', zh)
          const disposeEn = ctx.locale.register(NS, 'en', en)
          return () => {
            disposeZh()
            disposeEn()
          }
        }, 'material-cards: dictionaries')

        const t = ctx.locale.bind(NS)

        ctx.effect(() => {
          // One tag per module generation: a reload must not leave a stale copy of the CSS behind.
          const existing = document.querySelector('style[data-plugin-css="dsh-material-cards"]')
          const tag = document.createElement('style')
          tag.dataset.pluginCss = 'dsh-material-cards'
          tag.textContent = CSS
          document.head.appendChild(tag)
          return () => {
            if (existing === null) tag.remove()
          }
        }, 'material-cards: styles')

        ctx.effect(
          () =>
            ctx.slots.inject('conversation.input.left', () =>
              ctx.slots.register(
                {
                  name: 'conversation.input.left',
                  id: 'dsh-material-cards-entry',
                  order: 40,
                  label: () => t('entryHint')
                },
                () => h(Entry, { label: t('entryHint') })
              )
            ),
          'material-cards: composer entry'
        )

        ctx.effect(
          () =>
            ctx.slots.inject('conversation.input.overlay', () =>
              ctx.slots.register(
                {
                  name: 'conversation.input.overlay',
                  id: 'dsh-material-cards-panel',
                  order: 3,
                  label: () => t('panel')
                },
                (props) => h(Panel, { ...props, t })
              )
            ),
          'material-cards: search panel'
        )

        ctx.effect(
          () => () => {
            store.reset()
            currentDraft = ''
          },
          'material-cards: state'
        )
      }
    }
  }
})
