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
 *
 * The list itself is modelled on the host's own command palette habits: a pinned shelf, a
 * "recently inserted" shelf, a density switch, and a single keyboard walk over the whole thing.
 * Pins and recents are per-machine conveniences, so they live in localStorage and never travel
 * to the host — the library stays the only source of truth about materials.
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
    /* An empty query is the browsing state: every shelf (pins, recents, the rest) needs the
       whole library present, otherwise a pinned note could silently fall outside the window. */
    const BROWSE_LIMIT = 35
    const NOTE_MS = 2600
    const PINS_KEY = 'dsh-material-cards:pins'
    const RECENT_KEY = 'dsh-material-cards:recent'
    const DENSITY_KEY = 'dsh-material-cards:density'
    const MAX_PINS = 24
    const MAX_RECENT = 8
    const SHELVES = { pinned: 'secPinned', recent: 'secRecent', all: 'secAll' }

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
      retry: '重试',
      cardFailed: '这张卡取不回来，再试一次',
      panel: '材料卡',
      pin: '置顶',
      unpin: '取消置顶',
      secPinned: '置顶',
      secRecent: '最近',
      secAll: '全部',
      density: '切换行距',
      densityRoomy: '宽松',
      densityCompact: '紧凑',
      clear: '清空搜索',
      more: '还有 {n} 个标签'
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
      retry: 'Retry',
      cardFailed: 'Could not load that card, try again',
      panel: 'Material cards',
      pin: 'Pin to the top',
      unpin: 'Unpin',
      secPinned: 'Pinned',
      secRecent: 'Recent',
      secAll: 'All',
      density: 'Toggle row density',
      densityRoomy: 'Roomy',
      densityCompact: 'Compact',
      clear: 'Clear the search',
      more: '{n} more tags'
    }

    /* ------------------------------------------------------------------------------------- *
     * Per-machine preferences. Every read is defensive: localStorage can be absent (dry runs,
     * embedded webviews) or hold something another build wrote. A failure here must never take
     * the panel down, so each helper degrades to a sane value instead of throwing.
     * ------------------------------------------------------------------------------------- */

    function storage() {
      try {
        const store = window.localStorage
        if (store === null || store === undefined) return null
        if (typeof store.getItem !== 'function') return null
        return store
      } catch {
        return null
      }
    }

    function readList(key, max) {
      const store = storage()
      if (store === null) return []
      try {
        const raw = store.getItem(key)
        if (raw === null || raw === undefined) return []
        const parsed = JSON.parse(raw)
        if (!Array.isArray(parsed)) return []
        const seen = new Set()
        const out = []
        for (const entry of parsed) {
          if (typeof entry !== 'string') continue
          const slug = entry.trim()
          if (slug.length === 0 || seen.has(slug)) continue
          seen.add(slug)
          out.push(slug)
          if (out.length >= max) break
        }
        return out
      } catch {
        return []
      }
    }

    function writeList(key, list, max) {
      const store = storage()
      if (store === null) return
      try {
        store.setItem(key, JSON.stringify(list.slice(0, max)))
      } catch {
        /* quota or a locked-down store: pins are a convenience, not a feature */
      }
    }

    function readDensity() {
      const store = storage()
      if (store === null) return 'roomy'
      try {
        return store.getItem(DENSITY_KEY) === 'compact' ? 'compact' : 'roomy'
      } catch {
        return 'roomy'
      }
    }

    function writeDensity(value) {
      const store = storage()
      if (store === null) return
      try {
        store.setItem(DENSITY_KEY, value)
      } catch {
        /* ignore */
      }
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

    /**
     * Shelves, in the order a browsing session wants them: what I pinned, what I just used, then
     * everything else. A query collapses the shelves — a search is a question about the library,
     * not a place where a note should be moved away from the others.
     */
    function arrange(items, pins, recent, query) {
      const pinnedSet = new Set(pins)
      const recentSet = new Set(recent)
      const groups = []
      if (query.length === 0) {
        const rankOf = (list, slug) => {
          const at = list.indexOf(slug)
          return at === -1 ? Number.MAX_SAFE_INTEGER : at
        }
        const pinned = items.filter((item) => pinnedSet.has(item.slug)).sort((a, b) => rankOf(pins, a.slug) - rankOf(pins, b.slug))
        const used = items
          .filter((item) => !pinnedSet.has(item.slug) && recentSet.has(item.slug))
          .sort((a, b) => rankOf(recent, a.slug) - rankOf(recent, b.slug))
        const rest = items.filter((item) => !pinnedSet.has(item.slug) && !recentSet.has(item.slug))
        if (pinned.length > 0) groups.push({ key: 'pinned', items: pinned })
        if (used.length > 0) groups.push({ key: 'recent', items: used })
        if (rest.length > 0) groups.push({ key: 'all', items: rest })
      } else if (items.length > 0) {
        groups.push({ key: 'all', items })
      }
      const rows = []
      const heads = []
      for (const group of groups) {
        // A lone shelf is noise: the header only earns its line when it separates two of them.
        const labelled = groups.length > 1 && group.key !== 'all'
        if (labelled) heads.push({ at: rows.length, key: group.key, count: group.items.length })
        for (const item of group.items) rows.push(item)
      }
      if (groups.length > 1 && rows.length > heads.length) {
        const last = groups[groups.length - 1]
        if (last.key === 'all') heads.push({ at: rows.length - last.items.length, key: 'all', count: last.items.length })
      }
      return { rows, heads }
    }

    /**
     * The shelves and the server order are two different orders, and the keyboard walks the one
     * the eye sees. The last render leaves its row order here so the click and arrow handlers —
     * which run after that render — index the same list the highlight is painted from.
     */
    let viewRows = []

    const EMPTY = {
      open: false,
      query: '',
      items: [],
      total: 0,
      loading: false,
      error: '',
      active: 0,
      note: '',
      pins: [],
      recent: [],
      density: 'roomy'
    }

    const store = {
      snap: { ...EMPTY, pins: readList(PINS_KEY, MAX_PINS), recent: readList(RECENT_KEY, MAX_RECENT), density: readDensity() },
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
        store.set({ open: false, active: 0, query: '' })
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
      clearQuery() {
        if (store.timer !== 0) {
          clearTimeout(store.timer)
          store.timer = 0
        }
        store.set({ query: '', active: 0 })
        void store.search('', true)
      },
      move(delta) {
        const count = viewRows.length
        if (count === 0) return
        const next = (store.snap.active + delta + count) % count
        store.set({ active: next })
      },
      edge(last) {
        const count = viewRows.length
        if (count === 0) return
        store.set({ active: last ? count - 1 : 0 })
      },
      togglePin(slug) {
        if (typeof slug !== 'string' || slug.length === 0) return
        const pinned = store.snap.pins.includes(slug)
        const next = pinned ? store.snap.pins.filter((entry) => entry !== slug) : [slug, ...store.snap.pins].slice(0, MAX_PINS)
        writeList(PINS_KEY, next, MAX_PINS)
        store.set({ pins: next, active: 0 })
      },
      remember(slug) {
        if (typeof slug !== 'string' || slug.length === 0) return
        const next = [slug, ...store.snap.recent.filter((entry) => entry !== slug)].slice(0, MAX_RECENT)
        writeList(RECENT_KEY, next, MAX_RECENT)
        store.set({ recent: next })
      },
      toggleDensity() {
        const next = store.snap.density === 'compact' ? 'roomy' : 'compact'
        writeDensity(next)
        store.set({ density: next })
      },
      async search(query, immediate) {
        const ticket = (store.seq += 1)
        store.set({ loading: true, error: '' })
        const limit = query.length === 0 ? BROWSE_LIMIT : LIMIT
        try {
          const url = `${SEARCH_ROUTE}?q=${encodeURIComponent(query)}&limit=${limit}`
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
      retry() {
        void store.search(store.snap.query, true)
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
        store.snap = { ...EMPTY }
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

    function PinGlyph({ size = 13 }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 12 12',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true'
        },
        h('path', { d: 'M4 1h4M6 1v3.4M3.3 4.4h5.4L7.6 7.6H4.4zM6 7.6V11' })
      )
    }

    function DensityGlyph({ size = 13 }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 12 12',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeLinecap: 'round',
          'aria-hidden': 'true'
        },
        h('path', { d: 'M1.5 2.5h9M1.5 5h9M1.5 7.5h9M1.5 10h9' })
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
          const item = viewRows[index] ?? store.get().items[index]
          if (item === undefined) return
          try {
            const card = await store.fetchCard(item.slug)
            const mode = insertCard(inputActions, card.prompt)
            if (mode === 'failed' || mode === 'unsupported') {
              store.note(t('insertFailed'))
              return
            }
            store.remember(item.slug)
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
            // Two stages, like the host palette: the first Escape undoes the search, the
            // second leaves the panel. Losing the whole panel after a typo is the worst case.
            if (store.get().query.length > 0) store.clearQuery()
            else store.close()
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
          if (event.key === 'Home') {
            event.preventDefault()
            store.edge(false)
            return
          }
          if (event.key === 'End') {
            event.preventDefault()
            store.edge(true)
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

      const view = arrange(state.items, state.pins, state.recent, state.query)
      viewRows = view.rows
      const pinnedSet = new Set(state.pins)
      const headAt = new Map(view.heads.map((head) => [head.at, head]))
      const nodes = []
      view.rows.forEach((item, index) => {
        const head = headAt.get(index)
        if (head !== undefined) {
          nodes.push(
            h(
              'div',
              { className: 'mc-head', key: `head-${head.key}` },
              h('span', { className: 'mc-headname' }, t(SHELVES[head.key])),
              h('span', { className: 'mc-headnum' }, String(head.count))
            )
          )
        }
        const pinned = pinnedSet.has(item.slug)
        const tags = Array.isArray(item.tags) ? item.tags : []
        const shownTags = tags.slice(0, 4).join(' · ')
        const moreTags = tags.length > 4 ? ` +${tags.length - 4}` : ''
        const meta =
          item.hits > 0
            ? t('hits', { n: item.hits })
            : typeof item.confidence === 'string' && item.confidence.length > 0
              ? ''
              : ''
        nodes.push(
          h(
            'div',
            {
              key: item.slug,
              className: 'mc-row',
              id: `mc-opt-${index}`,
              role: 'option',
              'aria-selected': index === state.active ? 'true' : 'false',
              'data-active': index === state.active ? '1' : '0',
              'data-pinned': pinned ? '1' : '0',
              onMouseEnter: () => store.set({ active: index }),
              onClick: () => void pick(index)
            },
            h(
              'span',
              { className: 'mc-main' },
              h('span', { className: 'mc-name' }, item.title),
              shownTags.length > 0 ? h('span', { className: 'mc-tags', title: tags.join(' · ') }, shownTags + moreTags) : null
            ),
            typeof item.confidence === 'string' && item.confidence.length > 0
              ? h('span', { className: 'mc-conf', 'data-level': item.confidence }, item.confidence)
              : null,
            meta.length > 0 ? h('span', { className: 'mc-meta' }, meta) : null,
            h(
              'button',
              {
                type: 'button',
                className: 'mc-pin',
                title: pinned ? t('unpin') : t('pin'),
                'aria-label': pinned ? t('unpin') : t('pin'),
                'aria-pressed': pinned,
                onClick: (event) => {
                  event.stopPropagation()
                  store.togglePin(item.slug)
                }
              },
              h(PinGlyph, null)
            )
          )
        )
      })

      const countText =
        state.query.length > 0 ? t('matches', { n: view.rows.length }) : t('total', { n: state.total })

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
            role: 'combobox',
            'aria-expanded': 'true',
            'aria-controls': 'mc-listbox',
            'aria-autocomplete': 'list',
            'aria-activedescendant': view.rows.length > 0 ? `mc-opt-${state.active}` : undefined,
            onChange: (event) => store.type(event.target.value),
            onKeyDown
          }),
          state.query.length > 0
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'mc-icon mc-clear',
                  title: t('clear'),
                  'aria-label': t('clear'),
                  onClick: () => {
                    store.clearQuery()
                    if (inputRef.current !== null && typeof inputRef.current.focus === 'function') inputRef.current.focus()
                  }
                },
                h('svg', { width: 11, height: 11, viewBox: '0 0 12 12', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', 'aria-hidden': 'true' }, h('path', { d: 'M2 2l8 8M10 2l-8 8' }))
              )
            : null,
          h('span', { className: 'mc-count' }, countText),
          h(
            'button',
            {
              type: 'button',
              className: 'mc-icon mc-density',
              title: state.density === 'compact' ? t('densityRoomy') : t('densityCompact'),
              'aria-label': t('density'),
              'data-density': state.density,
              onClick: () => store.toggleDensity()
            },
            h(DensityGlyph, null)
          )
        ),
        state.error.length > 0
          ? h(
              'div',
              { className: 'mc-note mc-bad' },
              h('span', null, t('loadFailed', { message: state.error })),
              h('button', { type: 'button', className: 'mc-retry', onClick: () => store.retry() }, t('retry'))
            )
          : null,
        state.loading && state.items.length === 0 ? h('div', { className: 'mc-note' }, t('loading')) : null,
        state.loading || view.rows.length > 0
          ? h(
              'div',
              {
                className: 'mc-list',
                id: 'mc-listbox',
                role: 'listbox',
                'aria-label': t('panel'),
                'data-density': state.density
              },
              nodes
            )
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
  min-width:min(240px,100%);max-height:min(380px,48vh);padding:6px;
  border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.3));border-radius:12px;
  background-color:var(--dsw-alias-bg-base,#191919);
  background-image:linear-gradient(var(--dsw-alias-bg-layer-2,#232323),var(--dsw-alias-bg-layer-2,#232323));
  box-shadow:var(--dsw-elevation-prominent,var(--dsw-alias-shadow-lv2,0 4px 16px rgba(0,0,0,.3)));
  overflow:hidden;
  animation:mc-in var(--dsh-claude-duration-enter,320ms) var(--dsh-claude-ease-enter,ease) both;
}
@keyframes mc-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
.mc-search{display:flex;align-items:center;gap:6px;padding:2px 4px 6px;border-bottom:0.5px solid var(--dsh-claude-divider,rgba(128,128,128,.28))}
.mc-input{
  flex:1;min-width:0;border:0;outline:none;padding:4px 2px;
  background:transparent;color:var(--dsw-alias-label-primary,#ececec);
  font-size:12.5px;line-height:1.5;font-family:inherit;
}
.mc-input::placeholder{color:var(--dsw-alias-label-tertiary,#8a8a8a)}
.mc-count{flex:none;font-size:10px;line-height:1.4;letter-spacing:.03em;color:var(--dsw-alias-label-tertiary,#8a8a8a)}
.mc-icon{
  flex:none;display:inline-flex;align-items:center;justify-content:center;
  width:20px;height:20px;padding:0;border:0;border-radius:6px;background:transparent;
  color:var(--dsw-alias-label-tertiary,#8a8a8a);cursor:pointer;
  transition:background-color var(--dsh-claude-timing-feedback,120ms ease),color var(--dsh-claude-timing-feedback,120ms ease);
}
.mc-icon:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12));color:var(--dsw-alias-label-primary,#ececec)}
.mc-icon:focus-visible{outline:2px solid var(--dsw-focus-ring-color,#4d6bfe);outline-offset:-2px}
.mc-icon[data-density="compact"]{color:var(--dsw-alias-label-secondary,#b4b4b4)}
.mc-list{display:flex;flex-direction:column;gap:1px;min-height:0;overflow-y:auto;padding:4px 0 2px}
.mc-list::-webkit-scrollbar{width:8px}
.mc-list::-webkit-scrollbar-thumb{background:var(--dsh-scrollbar-thumb,rgba(128,128,128,.4));border-radius:8px}
.mc-head{display:flex;align-items:center;gap:8px;padding:6px 8px 3px;font-size:9.5px;line-height:1.4;letter-spacing:.06em;color:var(--dsw-alias-label-tertiary,#8a8a8a)}
.mc-head::after{content:"";flex:1;height:0.5px;background:var(--dsh-claude-divider,rgba(128,128,128,.28));opacity:.8}
.mc-headname{flex:none}
.mc-headnum{flex:none;font-family:var(--dsh-claude-font-code,ui-monospace,SFMono-Regular,Menlo,monospace);opacity:.8}
.mc-row{
  display:flex;align-items:center;gap:6px;text-align:left;
  padding:5px 8px;border:0;border-radius:8px;background:transparent;
  color:var(--dsw-alias-label-primary,#ececec);cursor:pointer;
  transition:background-color var(--dsh-claude-timing-feedback,120ms ease);
}
.mc-list[data-density="compact"] .mc-row{padding:2px 8px}
.mc-row[data-active="1"]{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.14))}
.mc-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.mc-list[data-density="compact"] .mc-main{flex-direction:row;align-items:baseline;gap:8px}
.mc-name{min-width:0;font-size:12.5px;line-height:1.45;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mc-tags{min-width:0;font-size:10.5px;line-height:1.4;color:var(--dsw-alias-label-secondary,#b4b4b4);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mc-list[data-density="compact"] .mc-tags{max-width:52%;color:var(--dsw-alias-label-tertiary,#8a8a8a)}
.mc-conf{
  flex:none;padding:1px 5px;border-radius:999px;
  border:0.5px solid var(--dsw-alias-border-l1,rgba(128,128,128,.3));
  font-size:9px;line-height:1.5;letter-spacing:.02em;
  color:var(--dsw-alias-label-tertiary,#8a8a8a);
}
.mc-conf[data-level="high"]{color:var(--dsw-alias-state-success-primary,#3fb950);border-color:currentColor}
.mc-conf[data-level="low"]{color:var(--dsw-alias-state-warn-label,#c98a12);border-color:currentColor}
.mc-meta{flex:none;font-size:10px;line-height:1.4;color:var(--dsw-alias-label-tertiary,#8a8a8a);font-family:var(--dsh-claude-font-code,ui-monospace,SFMono-Regular,Menlo,monospace);opacity:.85}
.mc-pin{
  flex:none;display:inline-flex;align-items:center;justify-content:center;
  width:18px;height:18px;padding:0;border:0;border-radius:6px;background:transparent;
  color:var(--dsw-alias-label-tertiary,#8a8a8a);opacity:.28;cursor:pointer;
  transition:opacity var(--dsh-claude-timing-feedback,120ms ease),color var(--dsh-claude-timing-feedback,120ms ease),background-color var(--dsh-claude-timing-feedback,120ms ease);
}
.mc-row:hover .mc-pin,.mc-row[data-active="1"] .mc-pin{opacity:.6}
.mc-pin:hover{opacity:1;background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12));color:var(--dsw-alias-label-primary,#ececec)}
.mc-pin:focus-visible{opacity:1;outline:2px solid var(--dsw-focus-ring-color,#4d6bfe);outline-offset:-2px}
.mc-row[data-pinned="1"] .mc-pin{opacity:.9;color:var(--dsw-alias-brand-primary,#d97757)}
.mc-note{display:flex;align-items:center;gap:8px;padding:10px 8px;font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-tertiary,#8a8a8a)}
.mc-note.mc-bad{color:var(--dsw-alias-state-warn-label,#c98a12)}
.mc-retry{
  flex:none;margin-left:auto;padding:2px 8px;border-radius:999px;cursor:pointer;
  border:0.5px solid var(--dsw-alias-border-l1,rgba(128,128,128,.3));background:transparent;
  color:inherit;font-size:10.5px;line-height:1.5;font-family:inherit;
}
.mc-retry:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12))}
.mc-foot{display:flex;align-items:center;gap:10px;padding:5px 6px 1px;border-top:0.5px solid var(--dsh-claude-divider,rgba(128,128,128,.28))}
.mc-hint{font-size:10px;line-height:1.4;color:var(--dsw-alias-label-tertiary,#8a8a8a)}
.mc-toast{font-size:10.5px;line-height:1.4;margin-left:auto;color:var(--dsw-alias-brand-primary,#d97757)}
@media (prefers-reduced-motion:reduce){
  .mc-panel{animation:none}
  .mc-entry,.mc-row,.mc-icon,.mc-pin{transition:none}
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
            viewRows = []
          },
          'material-cards: state'
        )
      }
    }
  }
})
