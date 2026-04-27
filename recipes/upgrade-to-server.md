# Recipe: upgrade to a tiny local server

The local-only flow (browser writes file via File System Access) breaks in one specific case: **human + AI co-edit.** The user is editing in the browser; an AI agent is editing the same file via the filesystem. Two writers, no merge protocol → lost writes.

The fix is a tiny local server that becomes the merge point. The browser stops writing the file directly. Both clients (browser, agent) talk to the server.

## When to do this

- You have an autonomous loop (Claude Code, a Codex agent) routinely editing the same artifact you edit in the browser.
- You're seeing your edits clobbered, or the agent's edits silently desyncing the DOM.
- You actually have this case *now*. Don't preempt — the local-only path is dramatically simpler.

If your problem is multi-human concurrent edit: don't bolt a server onto live-html. Use a real CMS or doc tool. The library's appeal is single-file portability; a multi-user version isn't this library.

## The contract

Two endpoints. One file watcher. That's it.

### `POST /api/ops`

Browser posts ops as it generates them (no localStorage staging — the server is the staging area). Body is one op in the same shape as the localStorage log:

```json
{
  "kind": "content",
  "path": "section:2>div:0>h2:0",
  "before": "<em>old</em> title",
  "after":  "<em>new</em> title",
  "ts":    "2026-04-27T15:32:11.004Z"
}
```

Server responds `200` with the new sequence number, applies the op to its in-memory DOM model, and debounces a write to disk (e.g., 500 ms).

### `GET /events` (SSE)

Server streams ops to all connected browsers. When the agent writes the file, the watcher detects the change, diffs the new file against the in-memory DOM, emits ops on the stream, and updates its model. The browser applies them — the user sees the agent's edits live.

Event shape:

```
event: op
data: { "seq": 142, "kind": "content", "path": "...", "after": "...", "ts": "..." }

event: snapshot
data: { "seq": 142, "html": "<!doctype html>..." }
```

Snapshots are sent on connect and after any change the watcher couldn't decompose into a clean op stream (e.g., the agent rewrote the whole file). The browser hard-replaces the DOM on snapshot.

### File watcher with defensive snapshots

Before each disk write (whether driven by the browser or the agent) the server drops the prior file into `.history/<timestamp>.html`. This is the same snapshot mechanism as the local-only flow, just enforced server-side. Cheap insurance against either client misbehaving.

## What the browser changes

In server mode the browser:

- Skips the localStorage op log (the server is the staging area).
- Skips the File System Access save (the server owns the file).
- Adds an SSE subscription to `/events` and applies remote ops the same way it applies local ones.
- Routes local ops through `POST /api/ops` instead of `commitOp(...)`.

A flag — `window.LIVE_HTML_SERVER = 'http://localhost:7777'` — is enough to switch modes. Everything else is identical.

## Reference impl

TBD. The contract above is the stable bit; the implementation is a ~150-line Node or Deno script. When the reference impl lands it will live next to this recipe as `server.js` with a one-line invocation. Until then: the contract is enough to write your own, and the browser flag is in `editor.js` waiting for a server to talk to.
