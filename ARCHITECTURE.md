# Architecture

The mental model is small. Hold these four layers and three op kinds and the rest is mechanical.

## The four layers

The page's visual state is composed top-down from four layers. Earlier layers are the substrate; later layers override.

| Layer | Lives in | Role | Edited by |
|-------|----------|------|-----------|
| 1. Base CSS | main `<style>` in `<head>` | Default tokens (`--bg`, `--accent`, `--t-body`, …) and structural rules. The page's identity. | Author, by hand. Not touched by the editor. |
| 2. Theme registry | `<script type="application/json" id="themes">` | Optional. A map of named themes, each a partial override of the base tokens. Static; the source of truth for "switch to dark". | Author, by hand (see `recipes/add-theme.md`). |
| 3. Active overrides | `<style id="theme-overrides">` | The CSS variable deltas currently in force. Generated. Written on save by serializing the current overrides. | The editor (theme picker + theme-switch ops). |
| 4. Active pointer | `<html data-active-theme="…">` attribute | Which named theme (if any) is currently applied. Drives optional CSS selectors like `html[data-active-theme="dark"] .foo`. | The editor (theme-switch ops). |

A page can use only layer 1 (no themes at all). Adding layer 2 enables named-theme switching. Layers 3 and 4 are runtime artifacts maintained by the editor.

The split between layer 2 (registry, declarative, hand-edited) and layer 3 (active, generated, machine-written) is the most important architectural choice. It means the user can hand-author themes in a clean JSON block without colliding with whatever the editor is currently doing, and the editor can freely rewrite the active layer without ever touching the registry.

## The three op kinds

Every edit becomes an op appended to the localStorage log. Three kinds:

### `content`

An `innerHTML` change to a `contenteditable` element.

```js
{
  kind: 'content',
  path: 'section:2>div:0>h2:0',     // structural path, see "path-based identity"
  before: '<em>old</em> title',
  after:  '<em>new</em> title',
  ts:     '2026-04-27T15:32:11.004Z'
}
```

Replayed by walking `path` and setting `innerHTML`.

### `theme`

A single CSS-variable change on `:root`.

```js
{
  kind:  'theme',
  token: '--accent',
  before: '#7aa2f7',
  after:  '#f7768e',
  ts:    '2026-04-27T15:33:02.811Z'
}
```

Replayed by `document.documentElement.style.setProperty(token, after)`.

### `theme-switch`

Atomic swap of the active overrides — the only op that touches multiple variables at once. Used when the user picks a named theme from the registry.

```js
{
  kind: 'theme-switch',
  from: 'light',                    // previous data-active-theme, or null
  to:   'dark',
  beforeMap: { '--bg': '#fff', '--fg': '#111', /* … */ },
  afterMap:  { '--bg': '#111', '--fg': '#eee', /* … */ },
  ts: '2026-04-27T15:34:40.220Z'
}
```

Replayed by clearing all inline `:root` properties from `beforeMap`, then setting all from `afterMap`, then updating `data-active-theme`. Treated as a single undo step.

Legacy ops without a `kind` field are treated as `content` — this lets old logs from pre-multi-kind versions still replay.

## Coalescing rules

Edits are noisy. Typing one character is one op if you're naive. Two rules collapse runs:

1. **Same-key 30s window.** If the new op has the same "key" as the previous op (`c:<path>` for content, `t:<token>` for theme) and lands within 30 seconds, merge: keep the older `before`, take the newer `after`, update `ts`. `theme-switch` is never coalesced — every theme change is a discrete commit.
2. **Null-op skip.** If `before === after` after coalescing, drop the op. (Common when the user clicks into a field and clicks out unchanged.)

The 30s window is tuned for prose editing — long enough that typing a paragraph is one undo step, short enough that "I edited this slide an hour ago" stays a separate op. Constant lives at `COALESCE_MS` in `editor.js`.

## Persistence flow

```
   keystroke ──► DOM mutation ──► op (with coalescing)
                                       │
                                       ▼
                              localStorage[LOG_KEY]
                                       │
                              (survives reloads;
                               supports undo/redo;
                               drives history panel)
                                       │
                              user clicks Save
                                       ▼
                       serialize DOM + bake overrides
                                       ▼
              File System Access API: writable.write(html)
                                       ▼
                       clear log; reset head; done
```

Optional: if the user opts in, a copy of the pre-save file is dropped into `.history/<timestamp>.html` next to the source before overwrite. Cheap insurance — see `TRADEOFFS.md` on snapshots vs replay log.

The localStorage key is namespaced per page (`<slug>::oplog::v2`) so multiple live-html pages on the same origin don't collide. The `v2` suffix lets schema migrations skip legacy logs cleanly — a live-html bump that breaks op shape just changes the suffix.

## Why path-based identity, not IDs

Every editable element is identified by a **structural path** like `section:2>div:0>h2:0` — child-index walk from the root. No IDs are required on the page.

The alternative is to stamp a UUID into every editable element on first save and use it as the identity. We rejected that:

- **Markup churn.** Stamping IDs writes to the file the moment the user opens it, before they've made a single intentional edit. That is hostile to git review and to authors who hand-edit between live-html sessions.
- **Author-hostile diffs.** A diff full of `data-lh-id="…"` attributes nobody wrote is noise.
- **Non-portable.** Copying a slide between files would carry stale IDs.

Path-based identity has one real cost: if the user reorders elements between sessions, the op log can't replay against the new structure. We accept this. The contract is: **save (or discard) before restructuring.** Saving clears the log, so a clean save is a checkpoint that restructuring can't break.

If a path fails to resolve on replay, the op is skipped with a console warning; the rest of the log applies. Partial replay is better than refusing to start.

## When to add a server

The local-only model assumes one editor at a time: the human, in a browser, owning the file. It breaks down in one specific case worth calling out:

**Human + AI co-edit.** The user is editing in the browser; an AI agent (Claude Code, an autonomous loop) is editing the same file via the filesystem. Now there are two writers and no merge protocol. The browser's "save" will clobber the agent's edits; the agent's writes will silently desync the DOM from disk.

For this case, run a tiny local server: the browser posts ops to `POST /api/ops` instead of writing the file directly, and subscribes to `GET /events` (SSE) for changes from disk. The server is the merge point and the file watcher; both clients become thin. Sketch in `recipes/upgrade-to-server.md`. Don't add this until you actually have the co-edit case — the local-only path is dramatically simpler and right for ~all single-author flows.

For multi-human concurrent edit: don't bolt a server onto live-html. Use a real tool. The whole appeal of this library is that it's a hundred lines of JS and a `.html` file you can email.
