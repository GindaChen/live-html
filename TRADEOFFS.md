# Tradeoffs

Decisions worth revisiting if your situation changes. Not exhaustive — focused on the choices that are load-bearing and reversible.

## contenteditable vs Tiptap

We use the browser's native `contenteditable` and accept its rough edges: paste handling is inconsistent across browsers, the caret occasionally lands in odd places near boundary nodes, and rich structure (nested lists, tables with selection-aware behavior, embedded media) is fiddly to get right.

The win is that `contenteditable` is zero dependencies and zero bytes. The page that uses live-html stays a single HTML file you can email. The whole library is roughly a hundred lines of JS plus a stylesheet.

**Upgrade to Tiptap** when: the artifact has structured content with constraints (a table with typed columns, a list whose items must remain `<li>`s with a specific class, embeds that need handles), or when you find yourself writing more than a handful of paste-sanitization rules. Tiptap brings ProseMirror's schema-aware model and pays for itself fast at that point. The cost: build step, ~150KB, and the page is no longer "open it in a browser, it works."

For prose-heavy artifacts (slides, explainers, internal docs) `contenteditable` is fine. For app-shaped artifacts (forms, structured editors), it isn't.

## single-file vs multi-file

The library ships as a snippet you paste into the target page, not as `<script src="…">`. The target file ends up self-contained: one HTML file that is also its own editor.

This is annoying when you have ten pages all using live-html — every bug fix means re-pasting into ten files. We considered shipping `editor.js` as a separate file pulled by `<script src>` and rejected it for the primary use case: people email these files, fork them, drop them into Slack. A self-contained file survives all of that. A file with `<script src="./editor.js">` doesn't.

**Switch to multi-file** when: you have a stable directory of live-html artifacts you control end-to-end (a docs site, an internal tools index). At that point, dedup wins. Keep `editor.js` and `editor.css` as shared assets and inline only the `snippet.html` markup per page.

## snapshot history vs replay log

The op log is in localStorage and is cleared on save. The persistent record of "what this page looked like yesterday" is a snapshot — a copy of the file dropped into `.history/<timestamp>.html` (when the user opts in) before each save.

The alternative is to keep the op log forever and reconstruct any past state by replaying. That's elegant but wrong for this library:

- **Replay needs the original DOM.** If the user hand-edits the file between sessions (and they will — that's the whole point of round-tripping), replay against the new starting state is undefined.
- **Snapshots are debuggable.** You can open `.history/2026-04-20-1530.html` in a browser. Replaying an op log requires running the library.
- **Snapshots survive library version bumps.** A breaking change to op shape doesn't invalidate yesterday's snapshot.

The replay log is staging, not history. Snapshots are history. Two different jobs, two different storage locations.

## localStorage vs server

localStorage is the default and is right whenever the editor is the file owner — one human, one browser, one file on disk.

It's wrong in exactly one case worth calling out: **human + AI co-edit on the same file.** Two writers (browser and filesystem) with no merge protocol means lost writes. See `recipes/upgrade-to-server.md`.

It's also wrong if you need cross-device edit (start on laptop, finish on phone) — but that's a bigger architectural shift and probably means you want a real CMS, not a server bolt-on.

Don't add a server preemptively. The local-only flow is dramatically simpler — no process to manage, no port to remember, no auth story — and right for ~all single-author cases.

## ID-based vs path-based identity

Editable elements are identified by structural path (`section:2>div:0>h2:0`), not by stamped IDs. The full reasoning is in `ARCHITECTURE.md` ("Why path-based identity"); the short version:

- ID-stamping writes to the file before the user makes any intentional edit. That's hostile to git review and to authors who hand-edit between sessions.
- Path-based identity makes the source file diff-clean — what you wrote is what's on disk.
- The cost is that reordering elements between sessions can't be replayed. The contract is "save before restructuring," and a fresh save clears the log.

**Switch to ID-based** when: the artifact has element-level metadata that needs to outlive its position (comments threaded to a specific paragraph, per-element analytics, A/B variants). At that point you need stable identity across reorderings, and the markup churn is paying for something.

## namespace tokens or not

Design tokens are unnamespaced (`--accent`, `--bg`, `--t-body`) rather than `--lh-accent` or `--ds-accent`. This is the right call for the primary use case — the page's design tokens *are* the design system, the library is just exposing them — and it means a designer hand-authoring CSS doesn't have to learn a prefix convention.

The cost shows up if you embed a live-html page inside another page that already uses `--accent` for something else. Variables leak through `:root`. We don't paper over this; if you're embedding, namespace your host page's tokens, not the artifact's.

**Switch to namespaced tokens** (`--lh-*` or whatever) when: live-html pages are routinely embedded in other contexts and the cascade collisions are a real source of bugs. For the standalone-artifact case (the 95% case) the unnamespaced tokens are cleaner and let `getComputedStyle(root).getPropertyValue('--accent')` mean what it should mean.
