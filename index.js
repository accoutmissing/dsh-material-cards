/**
 * dsh-material-cards — a material library, as cards you can drop into a message.
 *
 * Why this exists: notes that describe how a material behaves live in a directory outside the
 * workspace, so every session that needs one greps them again and pastes raw markdown. This
 * plugin reads that directory once per cache window and hands back a *finished card*: the facts
 * the model needs, with a relative provenance line instead of an absolute path to chase.
 *
 * The library location is configuration, not code: `root` and `dir` come from the plugin config,
 * then `DSH_MATERIAL_CARDS_ROOT`, then `~/.dsh/material-cards.json`, then `~/materials`. Nothing
 * about a particular library is baked in, so the package is the same for every user.
 *
 * The host half is small on purpose. There is no watcher and no daemon: a few hundred files
 * totalling well under a megabyte are re-read at most once per `CACHE_MS`, keyed by mtime, which
 * is cheaper than keeping an index coherent and impossible to get out of sync.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SEARCH_ROUTE = '/plugins/material-cards/search'
const CARD_ROUTE = '/plugins/material-cards/card'
const HOME = process.env.USERPROFILE ?? process.env.HOME ?? ''
const LOCAL_CONFIG = HOME.length > 0 ? join(HOME, '.dsh', 'material-cards.json') : ''
const FALLBACK_DIR = 'materials'
const MAX_FILES = 400
const CACHE_MS = 5000
const CARD_BUDGET = 1400
const TITLE_MAX = 80

/**
 * Headings across the 35 notes are heterogeneous — 70 distinct names, from 「定义」 to
 * from 「定义」 to 「它为什么被这么叫」. A whitelist would silently find nothing, so sections are
 * bucketed by what they are *for*, in the order a card wants them.
 */
const SECTION_RANK = [
  { rank: 0, test: /定义|是什么|本质|含义|释义|区别对比/ },
  { rank: 1, test: /核心特性|特性|特点|性能|优点|体感|卖点|支撑|透气|耐用|环保/ },
  { rank: 2, test: /规格|参数|指标|克重|含量|密度|厚度/ },
  { rank: 3, test: /应用|产品|角色|关系|场景|用途/ },
  { rank: 4, test: /局限|注意|缺点|溢美|可信|对比/ }
]

/** Frontmatter is a tiny YAML subset here: `key: value`, inline arrays, one nested map. */
function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)
  if (!match) return { data: {}, body: text }
  const data = {}
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (!kv) continue
    const [, key, raw] = kv
    const value = raw.trim()
    if (value.startsWith('[') && value.endsWith(']')) {
      data[key] = value
        .slice(1, -1)
        .split(',')
        .map((part) => part.trim().replace(/^["']|["']$/g, ''))
        .filter((part) => part.length > 0)
    } else if (value.startsWith('{')) {
      data[key] = value
    } else {
      data[key] = value.replace(/^["']|["']$/g, '')
    }
  }
  return { data, body: text.slice(match[0].length) }
}

/** Split the body on `## ` headings; unnamed preamble becomes its own leading section. */
function splitSections(body) {
  const lines = body.split(/\r?\n/)
  const sections = []
  let current = { heading: '', lines: [] }
  for (const line of lines) {
    const heading = /^##\s+(.+?)\s*$/.exec(line)
    if (heading) {
      sections.push(current)
      current = { heading: heading[1], lines: [] }
      continue
    }
    current.lines.push(line)
  }
  sections.push(current)
  return sections
}

function flattenLinks(text) {
  return text
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, (_, target) => String(target).split('/').pop())
    .replace(/\*\*|__|`/g, '')
}

function trimCell(cell) {
  return flattenLinks(cell).replace(/^\s*|\s*$/g, '')
}

/**
 * Bullet/paragraph/table text from a section, with wiki links flattened to their label.
 * Returns `{kind, text}` pairs because a card has to tell a *group label* (`**优点：**`) apart
 * from an *item* — rendering the label as a bullet produced empty-looking rows like `- 优点：`.
 */
function sectionText(section, limit) {
  const out = []
  let used = 0
  let index = 0
  while (index < section.lines.length) {
    const raw = section.lines[index]
    const bare = raw.trim()

    // Tables carry the substance in several notes (「定义」 lists three variants in one table).
    if (bare.startsWith('|')) {
      const rows = []
      while (index < section.lines.length && section.lines[index].trim().startsWith('|')) {
        rows.push(section.lines[index].trim())
        index += 1
      }
      // Markdown's own rule decides the header: the row above a `---` separator. Guessing by
      // header *text* missed 「指标 / 数值」, 「说法 / 判定 · 理由」 and 「形态 / 构成 · …」.
      const isSeparator = (row) =>
        row
          .replace(/^\|/, '')
          .replace(/\|$/, '')
          .split('|')
          .every((cell) => /^\s*:?-{2,}:?\s*$/.test(cell) || /^\s*$/.test(cell))
      if (rows.length >= 2 && isSeparator(rows[1])) rows.shift()
      for (const row of rows) {
        if (isSeparator(row)) continue
        const cells = row.replace(/^\|/, '').replace(/\|$/, '').split('|').map(trimCell)
        if (cells.every((cell) => cell.length === 0)) continue
        const [head, ...rest] = cells
        const tail = rest.filter((cell) => cell.length > 0).join(' · ')
        if (head.length === 0 || tail.length === 0) continue
        const text = `${head}：${tail}`
        out.push({ kind: 'item', text: text.length > 220 ? `${text.slice(0, 219)}…` : text })
        used += text.length
        if (out.length >= 8) break
      }
      continue
    }
    index += 1

    const line = flattenLinks(raw).trim()
    if (line.length === 0) continue
    if (line.startsWith('>')) continue
    if (/^[-:|\s]+$/.test(line)) continue
    if (line.startsWith('![')) continue
    let text = line.replace(/^[-*+]\s+/, '').trim()
    if (text.length === 0) continue

    // A short line that ends in a colon is a group label, not a fact.
    if (text.length <= 14 && /[:：]$/.test(text)) {
      out.push({ kind: 'group', text: text.replace(/[:：]$/, '') })
      continue
    }
    // A whole section of prose is worse than its first few claims: cards are read, not skimmed.
    if (text.length > 220) text = `${text.slice(0, 219)}…`
    if (used + text.length > limit) break
    out.push({ kind: 'item', text })
    used += text.length
    if (out.length >= 8) break
  }
  return out
}

function slugOf(filename) {
  return filename.replace(/\.md$/i, '')
}

function cleanTitle(frontmatter, body, filename) {
  if (frontmatter.title) return String(frontmatter.title).slice(0, TITLE_MAX)
  const h1 = /^#\s+(.+?)\s*$/m.exec(body)
  if (h1) return h1[1].slice(0, TITLE_MAX)
  return slugOf(filename)
    .replace(/^材料-通用-/, '')
    .slice(0, TITLE_MAX)
}

function firstParagraph(sections) {
  for (const section of sections) {
    for (const raw of section.lines) {
      const line = raw
        .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
        .replace(/\[\[([^\]]+)\]\]/g, (_, target) => String(target).split('/').pop())
        .replace(/^[-*+]\s+/, '')
        .replace(/\*\*|__|`/g, '')
        .trim()
      if (line.length === 0) continue
      if (line.startsWith('>') || line.startsWith('|') || line.startsWith('#') || line.startsWith('![')) continue
      if (/^[-:|\s]+$/.test(line)) continue
      return line.length > 180 ? `${line.slice(0, 179)}…` : line
    }
  }
  return ''
}

function pickSections(sections) {
  const scored = []
  for (const section of sections) {
    if (section.heading.length === 0) continue
    for (const rule of SECTION_RANK) {
      if (!rule.test.test(section.heading)) continue
      const lines = sectionText(section, 260)
      if (lines.length === 0) break
      scored.push({ heading: section.heading, lines, rank: rule.rank })
      break
    }
  }
  scored.sort((left, right) => left.rank - right.rank)
  return scored.slice(0, 3)
}

/** Every field a card needs, derived from one file. */
function readNote(root, dir, filename) {
  const path = join(root, dir, filename)
  const stat = statSync(path)
  const text = readFileSync(path, 'utf8')
  const { data, body } = parseFrontmatter(text)
  const sections = splitSections(body)
  const show = pickSections(sections)
  return {
    slug: slugOf(filename),
    title: cleanTitle(data, body, filename),
    description: data.description ? String(data.description) : firstParagraph(sections),
    tags: Array.isArray(data.tags) ? data.tags.slice(0, 8) : [],
    confidence: data.confidence ? String(data.confidence) : '',
    status: data.status ? String(data.status) : '',
    type: data.type ? String(data.type) : '',
    path,
    // What the card shows: `dir/name` when a subdirectory is configured, otherwise the name.
    // An absolute path in a published example would be someone's machine, and in a card it
    // invites the model to go read the file instead of using the fact.
    rel: dir.length > 0 ? `${dir}/${filename}` : filename,
    dir,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    sections: show,
    // The search surface: title/description/tags are cheap, the body is only consulted when
    // the query misses the metadata, so a common word does not scan all 60 KB.
    bodyText: body.toLowerCase()
  }
}

let cache = { at: 0, root: '', dir: '', cards: [] }

/** A local file keeps machine-specific paths out of the published package. */
function readLocalConfig() {
  if (LOCAL_CONFIG.length === 0) return {}
  try {
    const parsed = JSON.parse(readFileSync(LOCAL_CONFIG, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Where the notes are. Precedence: plugin config, then the environment, then the local file —
 * a published package must not name anyone's library, and a user must not need a rebuild to
 * point it somewhere else.
 */
function resolveLibrary(config) {
  const local = readLocalConfig()
  const pick = (key) => {
    const fromConfig = config?.[key]
    if (typeof fromConfig === 'string' && fromConfig.length > 0) return fromConfig
    const fromLocal = local[key]
    if (typeof fromLocal === 'string' && fromLocal.length > 0) return fromLocal
    return ''
  }
  const fromEnv = process.env.DSH_MATERIAL_CARDS_ROOT ?? ''
  const root = pick('root') || fromEnv || (HOME.length > 0 ? join(HOME, FALLBACK_DIR) : '')
  const dir = pick('dir')
  const fullPath = config?.fullPath === true || local.fullPath === true
  return { root, dir, fullPath }
}

function absoluteDir({ root, dir }) {
  return dir.length > 0 ? join(root, dir) : root
}

function loadCards(config) {
  const library = resolveLibrary(config)
  const { root, dir } = library
  const now = Date.now()
  if (cache.cards.length > 0 && cache.root === root && cache.dir === dir && now - cache.at < CACHE_MS) {
    return cache
  }
  const absolute = absoluteDir(library)
  let names = []
  try {
    names = readdirSync(absolute)
      .filter((name) => name.toLowerCase().endsWith('.md'))
      .sort()
      .slice(0, MAX_FILES)
  } catch {
    cache = { at: now, root, dir, cards: [] }
    return cache
  }
  const cards = []
  for (const name of names) {
    try {
      cards.push(readNote(root, dir, name))
    } catch {
      /* one unreadable note must not take the whole index down */
    }
  }
  cache = { at: now, root, dir, cards }
  return cache
}

function score(card, query) {
  if (query.length === 0) return 1
  const needle = query.toLowerCase()
  let total = 0
  if (card.title.toLowerCase().includes(needle)) total += 8
  if (card.description.toLowerCase().includes(needle)) total += 4
  if (card.tags.some((tag) => tag.toLowerCase().includes(needle))) total += 4
  if (card.slug.toLowerCase().includes(needle)) total += 3
  const at = card.bodyText.indexOf(needle)
  if (at >= 0) total += 2
  return total
}

function countMatches(text, needle) {
  if (needle.length === 0) return 0
  let from = 0
  let total = 0
  for (;;) {
    const at = text.indexOf(needle, from)
    if (at < 0) return total
    total += 1
    from = at + needle.length
    if (total >= 99) return total
  }
}

function summarize(card, query) {
  return {
    slug: card.slug,
    title: card.title,
    description: card.description,
    tags: card.tags,
    confidence: card.confidence,
    status: card.status,
    mtimeMs: card.mtimeMs,
    hits: query.length === 0 ? 0 : countMatches(card.bodyText, query.toLowerCase())
  }
}

/**
 * The block that gets inserted. Written as facts plus provenance rather than as a file path —
 * a path makes the model read the file; a card means it already has the answer.
 */
function renderCard(card, options = {}) {
  const lines = [`【材料】${card.title}`]
  if (card.description.length > 0) lines.push(card.description)
  const meta = []
  // Tags read as a sentence fragment, not as a path: same separator the UI uses for its rows.
  if (card.tags.length > 0) meta.push(`标签：${card.tags.join(' · ')}`)
  if (card.confidence.length > 0) meta.push(`置信度：${card.confidence}`)
  if (card.status.length > 0) meta.push(`状态：${card.status}`)
  if (meta.length > 0) lines.push(meta.join(' · '))
  let used = lines.join('\n').length
  for (const section of card.sections) {
    if (used > CARD_BUDGET) break
    const block = [`## ${section.heading}`]
    for (const item of section.lines) {
      // Group labels read as headings inside the section; only facts get a bullet.
      block.push(item.kind === 'group' ? `**${item.text}**` : `- ${item.text}`)
    }
    const text = block.join('\n')
    if (used + text.length > CARD_BUDGET) continue
    lines.push(text)
    used += text.length
  }
  lines.push(`（出处：${options.fullPath === true ? card.path : card.rel}）`)
  return lines.join('\n\n')
}

function json(res, status, payload) {
  if (res.headersSent === true) return
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body)
  })
  res.end(body)
}

function fromLoopback(req) {
  const address = req.socket?.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function numberParam(value, fallback, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.min(parsed, max)
}

export const inject = ['webServer']

export function apply(ctx, config) {
  const library = resolveLibrary(config)
  const { root, dir } = library

  const search = (req, res) => {
    if (!fromLoopback(req)) {
      json(res, 403, { ok: false, error: 'not a local request' })
      return
    }
    let url
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1')
    } catch {
      json(res, 400, { ok: false, error: 'bad url' })
      return
    }
    if (req.method !== 'GET') {
      json(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    const query = (url.searchParams.get('q') ?? '').trim().slice(0, 64)
    const limit = numberParam(url.searchParams.get('limit'), 8, 35)
    const loaded = loadCards({ root, dir, fullPath: library.fullPath })
    const results = loaded.cards
      .map((card) => ({ card, points: score(card, query) }))
      .filter((entry) => entry.points > 0)
      .sort((left, right) => right.points - left.points || right.card.mtimeMs - left.card.mtimeMs)
      .slice(0, limit)
      .map((entry) => summarize(entry.card, query))
    json(res, 200, {
      ok: true,
      query,
      total: loaded.cards.length,
      results
    })
  }

  const card = (req, res) => {
    if (!fromLoopback(req)) {
      json(res, 403, { ok: false, error: 'not a local request' })
      return
    }
    if (req.method !== 'GET') {
      json(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    let url
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1')
    } catch {
      json(res, 400, { ok: false, error: 'bad url' })
      return
    }
    const slug = (url.searchParams.get('slug') ?? '').trim()
    if (slug.length === 0 || slug.length > 120) {
      json(res, 400, { ok: false, error: 'slug required' })
      return
    }
    const loaded = loadCards({ root, dir, fullPath: library.fullPath })
    const found = loaded.cards.find((entry) => entry.slug === slug)
    if (found === undefined) {
      json(res, 404, { ok: false, error: 'no such material' })
      return
    }
    json(res, 200, {
      ok: true,
      card: {
        ...summarize(found, ''),
        sections: found.sections,
        path: found.path
      },
      prompt: renderCard(found, { fullPath: library.fullPath })
    })
  }

  ctx.effect(() => {
    const disposers = [
      ctx.webServer.register({ kind: 'exact', path: SEARCH_ROUTE, handler: guard(SEARCH_ROUTE, search) }),
      ctx.webServer.register({ kind: 'exact', path: CARD_ROUTE, handler: guard(CARD_ROUTE, card) })
    ]
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'material-cards: routes')

  // Warm the cache so the first keystroke in the panel is not the one that pays for the read.
  loadCards({ root, dir, fullPath: library.fullPath })
}

/** Any throw inside a route must become a response, not a hung request. */
function guard(path, handler) {
  return (req, res) => {
    try {
      const result = handler(req, res)
      if (result !== null && typeof result?.then === 'function') {
        result.then(undefined, (error) => {
          json(res, 500, { ok: false, error: `${path}: ${String(error?.message ?? error)}` })
        })
      }
    } catch (error) {
      json(res, 500, { ok: false, error: `${path}: ${String(error?.message ?? error)}` })
    }
  }
}

export const internals = { parseFrontmatter, splitSections, sectionText, pickSections, renderCard, readNote, score, loadCards }
