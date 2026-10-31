# Material cards · dsh-material-cards

[简体中文](README.md) · **English**

A button next to the composer. Open it, type a material name, press Enter — a finished material card lands inside the message you are already writing, provenance included.

This is a **generic** plugin: any markdown directory organised as "one note per material" works. You point it at your own library; the package contains nobody's paths.

---

## Why not just read the files

The notes are already on your disk. The problem is not that they cannot be read — it is that they get read **from scratch, every time**:

- the model has to find candidates, open two or three notes, then assemble "what are the selling points of this material" — the same work redone in every session;
- the result carries no provenance, so nobody can tell which section of which note a claim came from;
- sections like "specs (to be filled in)" or "hype to avoid" are often empty or self-reminders, and pulling them in only dilutes the context.

So this is not a file browser. It **pre-condenses the library into cards**: title, one-line definition, tags, the three most useful sections, and a provenance line. Under 1,400 characters — enough for the model to use directly, and enough for you to check.

## Using it

1. A "material cards" icon appears on the left of the composer toolbar.
2. Open it; focus lands in the search box. Typing filters immediately (180 ms debounce, server-side search, not a local list filter).
3. `↑` `↓` to move, `Home` `End` for the ends, `Enter` to insert; `Esc` works in two stages — the first clears the query, the second closes the panel.
4. The card is appended to the current draft (or dropped straight in when the draft is empty) with one blank line between. Inserting into existing text is an undoable edit — it will not overwrite what you wrote.

An empty query is not a flat dump of every note — it is three shelves:

| Shelf | What is in it | How a note gets there |
|---|---|---|
| **Pinned** | the notes you keep quoting | the pin button at the end of a row; click again to release |
| **Recent** | notes inserted lately (up to 8) | automatic, recorded on insert |
| **All** | everything else, most recently changed first | — |

A shelf header appears only when it separates two shelves; a lone shelf stays unlabelled. The moment you type, the shelves collapse into one filtered list — a search is a question about the whole library, and no note should be moved away from the others by it.

To the right of the field sit the clear button (×), the hit count and a row-density switch (roomy / compact). Pins, recents and density live in this machine's localStorage only: nothing is uploaded and nothing enters the repository. The `medium` badge on a row is the confidence the note declares in its own frontmatter; a note that declares none simply shows none.

## What a card looks like

The text actually inserted (sample material, ~600 characters):

```
【材料】棉麻混纺面料

亚麻与棉的混纺，夏季面套常见，手感粗爽、吸湿快干

标签：面料 · 亚麻 · 夏季 · 透气 · 置信度：medium

## 定义
- 亚麻（Flax）纤维与棉纤维按比例混纺的机织面料
- 常见配比 55% 亚麻 / 45% 棉；亚麻比例越高越挺括，也越容易起皱

## 核心特性
**优点**
- 吸湿快干：回潮率高，出汗后不黏身
- 挺括有筋骨：比亚麻纯纺更抗皱
**缺点/注意**
- 易起皱：日常穿着需要熨烫
- 缩水：首次水洗缩率可达 3%–5%

## 应用
- 面套顶层面料，定位夏季面
- 与冬季面料做双面设计：翻面只改温度、不改睡感

（出处：notes/棉麻混纺面料.md）
```

Three things are deliberate: **facts and a relative provenance, never an absolute path** (an absolute path makes the model go read the file again, and writes one machine's directory layout into your conversation), **header rows are not data** (detected from markdown's `---` separator, not from a word list), and **group labels get their own line** (`**优点**` followed by items, rather than a `- 优点：` bullet that reads like a rendering bug).

If you want absolute paths for auditing, set `fullPath` to `true` (see "Pointing it at your library").

## Pointing it at your library

The package ships no paths. Resolution order, highest first:

| # | Source | Notes |
|---|---|---|
| 1 | plugin config `root` / `dir` | written in the bundle patch, travels with the profile |
| 2 | env var `DSH_MATERIAL_CARDS_ROOT` | overrides `root` only |
| 3 | `~/.dsh/material-cards.json` | per-machine file, easiest; never committed |
| 4 | fallback `~/materials` | when `dir` is empty, this *is* the note directory |

The per-machine file looks like this (`dir` may be omitted, in which case `root` is the note directory itself):

```json
{
  "root": "D:\\notes",
  "dir": "materials",
  "fullPath": false
}
```

If `dir` is missing or holds no `.md` files, search returns an empty list instead of an error — an installed-but-unconfigured plugin shows "no notes in the library yet".

## Injecting rules into the prompt (optional)

The same local file can carry a `rules` entry: it is registered as a system-prompt section, which removes the "grep the guidelines again in every session" step. Leave it out and nothing changes.

```json
{
  "root": "D:\\\\notes",
  "dir": "materials",
  "rules": "brand/design-system.md",
  "rulesSections": ["overview", "palette", "red lines"],
  "rulesMax": 4000
}
```

| Key | Effect |
|---|---|
| `rules` | A path (relative to `root`, or absolute); a string without a separator is treated as the text itself |
| `rulesSections` | Keep only the `##` sections whose heading contains one of these words; omit to keep the whole file |
| `rulesMax` | Character cap, default 6000, clamped to 500–12000; longer text is cut at a line break and marked |

The injected block starts with "only where relevant" — **the plugin cannot see the current workspace**: the assembly context carries only `scope` and `signal`, no cwd. Rather than guess from a path, the scope statement lives in the text and the model decides relevance.

`GET /plugins/material-cards/rules` returns the effective text, its source, and `registered` (whether the prompt section really mounted) — enough to tell a wrong path from a missing wire.

## Note format

Only frontmatter plus `##` sections is required; everything else is free-form:

```markdown
---
type: material
title: 棉麻混纺面料
description: 一句话说清它是什么、用在哪
tags: [面料, 亚麻, 夏季]
confidence: medium
---

# 棉麻混纺面料

## 定义
...
## 核心特性
**优点**
- ...
**缺点/注意**
- ...
```

`title` / `description` / `tags` / `confidence` / `status` are all optional: without `title` the first `#` heading is used, then the filename; without `description` the first body paragraph is used.

## Which sections get picked

Heading names wander (a single library can produce dozens, from "定义" to "why it is called that"). A whitelist is guaranteed to miss, so sections are scored by **what the section is for**, in five tiers, and the top three are kept:

| Tier | Purpose | Headings |
|---|---|---|
| 0 | what it is | 定义 / 是什么 / 本质 / 含义 / 区别对比 |
| 1 | why it is good | 核心特性 / 特性 / 特点 / 优点 / 体感 / 卖点 / 支撑 |
| 2 | numbers | 规格 / 参数 / 指标 / 克重 / 含量 / 密度 / 厚度 |
| 3 | where it is used | 应用 / 产品 / 角色 / 关系 / 场景 / 用途 |
| 4 | do not overclaim | 局限 / 注意 / 缺点 / 溢美 / 可信 / 对比 |

## Search

Scoring: title 8, description 4, tags 4, slug 3, body 2 (body hit counts cap at 99, used as a ranking hint). The whole library is walked in memory with a 5-second cache — at the few-hundred-files scale, re-reading is simpler than maintaining an index and cannot go stale relative to the notes.

## Routes

Three read-only endpoints, loopback-only, `GET`-only:

| Route | Params | Returns |
|---|---|---|
| `GET /plugins/material-cards/search` | `q` (≤64 chars), `limit` (default 8, max 35) | `{ok, query, total, results[]}` |
| `GET /plugins/material-cards/card` | `slug` | `{ok, card, prompt}` |
| `GET /plugins/material-cards/rules` | — | `{ok, registered, source, sections, length, text}` |

`card`'s `prompt` is exactly the text to insert; the client does not reassemble it — **there is one renderer**, so host and UI cannot drift apart.

## Install

```bash
plugin_manager  action: install_bundle
               target: <absolute path>\dsh-material-cards
```

Then toggle the plugin off and on (`set_plugin` + `enabled:false` → `true`) so the new code loads, press `Ctrl+R`, and point `~/.dsh/material-cards.json` at your notes directory.

## What it deliberately does not do

- **Never writes back to notes** — read-only `.md`.
- **No vector search** — at a few hundred files, field weighting is enough; embeddings would only add "when does the index expire" as a new problem.
- **Does not decide what you may claim** — cards carry a confidence field and provenance, but which wording is citable, and whether it can be used as marketing copy, is your call.
- **Does not guess where your library is** — unconfigured means empty; it will not scan the disk.

## Development

```bash
node --check index.js client.js
node ../.tmp-codex/materials-render-test.mjs   # dry-run the production client bundle
```

`materials-render-test.mjs` loads the **production `client.js`** (not a copy) against a mocked platform and asserts both seats register, the panel renders real host data, `Enter` goes through `inputActions.insertText` rather than touching the DOM, and the inserted text carries provenance.

## License

MIT.
