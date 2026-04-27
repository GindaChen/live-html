/* ──────────────────────────────────────────────────────────────────
 * live-html · editor.js
 *
 * A drop-in inline editing layer for static HTML pages.
 *
 * Features:
 *   • contenteditable toggle with hover/focus outlines
 *   • op-log (content + theme ops) persisted to localStorage
 *   • undo / redo with ⌘Z / ⌘⇧Z (Ctrl on Windows/Linux), with op coalescing
 *   • history panel (#eb-hist-panel) with click-to-jump
 *   • File System Access API save (with IndexedDB-stashed file handle)
 *   • download fallback for browsers without showOpenFilePicker
 *   • optional design-system controls: only initializes if the page has
 *     a `.ds-slide` section with `#ds-colors` and `#ds-type` containers.
 *     Theme ops mutate CSS custom properties on <html> and bake into a
 *     <style id="theme-overrides"> block on save.
 *
 * Usage:
 *   1. <link rel="stylesheet" href="editor.css">  in <head>
 *   2. paste snippet.html (the toolbar markup) before </body>
 *   3. <script src="editor.js"></script>  at end of <body>
 *
 * Configuration (optional): include a JSON block before editor.js:
 *   <script type="application/json" id="live-html-config">
 *   { "storageKey":"...", "fileHandleDb":"...", "rootSelector":"body",
 *     "editableSelectors":["h1","h2","p", ...] }
 *   </script>
 *
 * Public API: window.LiveHTML
 *   .enable() / .disable()  — toggle edit mode
 *   .undo() / .redo()
 *   .save()                  — write to disk (or download)
 *   .getLog()                — current op log {ops, head}
 *   .revert()                — clear log + reload
 * ──────────────────────────────────────────────────────────────── */

(function () {
  'use strict';

  // ── config ─────────────────────────────────────────────────────
  const DEFAULTS = {
    storageKey: 'live-html::oplog::v1',
    fileHandleDb: 'live-html-fh',
    rootSelector: 'body',
    editableSelectors: [
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'p', 'li', 'td', 'th', 'code', 'blockquote', 'figcaption',
      'dt', 'dd', 'summary', 'caption'
    ]
  };
  function readConfig() {
    const cfg = Object.assign({}, DEFAULTS);
    // <html data-live-html-config='{"storageKey":"..."}'> form
    try {
      const attr = document.documentElement.getAttribute('data-live-html-config');
      if (attr) Object.assign(cfg, JSON.parse(attr));
    } catch (e) { console.warn('[live-html] bad data-live-html-config', e); }
    // <script type="application/json" id="live-html-config"> form
    try {
      const blk = document.getElementById('live-html-config');
      if (blk && blk.textContent.trim()) Object.assign(cfg, JSON.parse(blk.textContent));
    } catch (e) { console.warn('[live-html] bad #live-html-config', e); }
    return cfg;
  }
  const CFG = readConfig();
  const EDITABLE_SEL = CFG.editableSelectors.join(',');
  const LOG_KEY = CFG.storageKey;
  const FH_DB = CFG.fileHandleDb;

  // ── DOM lookup ────────────────────────────────────────────────
  function $(id) { return document.getElementById(id); }
  function rootEl() {
    return document.querySelector(CFG.rootSelector) || document.body;
  }

  // Bail early (with no error) if toolbar markup isn't on the page yet.
  // Re-try on DOMContentLoaded.
  function hasToolbar() { return !!document.getElementById('ebar'); }

  // ── log model ─────────────────────────────────────────────────
  // log = { ops: [{kind, ...}], head: int }
  // ops[0..head-1] are applied; ops[head..] are undone-but-redoable.
  // op shape:
  //   content: { kind:'content', path, before, after, ts }
  //   theme:   { kind:'theme',   token, before, after, ts }
  let log = { ops: [], head: 0 };
  let pending = null;        // {path, before, after} for the focused element
  let suppressInput = false; // true while we're programmatically setting innerHTML

  function loadLog() {
    try {
      const raw = localStorage.getItem(LOG_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.ops)) log = parsed;
      }
    } catch (e) { console.warn('[live-html] log load failed', e); }
  }
  function persistLog() {
    try { localStorage.setItem(LOG_KEY, JSON.stringify(log)); }
    catch (e) { console.warn('[live-html] localStorage full', e); }
  }

  // ── path identity (structural address within rootEl) ──────────
  function pathFor(el) {
    const root = rootEl();
    const parts = [];
    let cur = el;
    while (cur && cur !== root) {
      const p = cur.parentElement;
      if (!p) break;
      const idx = [].indexOf.call(p.children, cur);
      parts.unshift(cur.tagName.toLowerCase() + ':' + idx);
      cur = p;
    }
    return parts.join('>');
  }
  function elemAt(path) {
    if (!path) return null;
    let cur = rootEl();
    for (const part of path.split('>')) {
      if (!cur) return null;
      const [tag, idx] = part.split(':');
      const child = cur.children[+idx];
      if (!child || child.tagName.toLowerCase() !== tag) return null;
      cur = child;
    }
    return cur;
  }

  // ── op commit (with coalescing) ───────────────────────────────
  const COALESCE_MS = 30000;
  function opKey(op) {
    return op.kind === 'theme' ? 't:' + op.token : 'c:' + (op.path || '');
  }
  function commitOp(op) {
    if (!op.kind) op.kind = 'content';
    if (op.before === op.after) return;
    if (log.head < log.ops.length) log.ops.length = log.head; // truncate redo tail
    const prev = log.ops[log.ops.length - 1];
    if (prev && opKey(prev) === opKey(op)
        && Date.parse(op.ts) - Date.parse(prev.ts) < COALESCE_MS) {
      prev.after = op.after;
      prev.ts = op.ts;
      if (prev.before === prev.after) log.ops.pop();
      log.head = log.ops.length;
    } else {
      log.ops.push(op);
      log.head = log.ops.length;
    }
    persistLog(); updateStatus();
    if (op.kind === 'theme') { refreshThemeUI(); refreshRawOverrides(); }
  }

  // ── theme ops ─────────────────────────────────────────────────
  function setThemeRaw(token, value) {
    if (value === '' || value == null) {
      document.documentElement.style.removeProperty(token);
    } else {
      document.documentElement.style.setProperty(token, value);
    }
  }
  function currentThemeValue(token) {
    const inline = document.documentElement.style.getPropertyValue(token);
    if (inline) return inline.trim();
    return getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  }
  function inlineThemeMap() {
    const m = {};
    for (const prop of document.documentElement.style) {
      if (prop.startsWith('--')) {
        m[prop] = document.documentElement.style.getPropertyValue(prop).trim();
      }
    }
    return m;
  }
  function recordThemeChange(token, before, after) {
    if (before === after) return;
    commitOp({ kind: 'theme', token, before, after, ts: new Date().toISOString() });
  }

  // ── pending content-op capture ────────────────────────────────
  let idleTimer = null;
  function startPending(el) {
    if (pending) flushPending();
    pending = { path: pathFor(el), before: el.innerHTML, after: el.innerHTML };
  }
  function updatePending(el) {
    const p = pathFor(el);
    if (!pending || pending.path !== p) startPending(el);
    pending.after = el.innerHTML;
  }
  function flushPending() {
    if (!pending) return;
    if (pending.before !== pending.after) {
      commitOp({
        kind: 'content', path: pending.path,
        before: pending.before, after: pending.after,
        ts: new Date().toISOString()
      });
    }
    pending = null;
  }
  function bumpIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(flushPending, 1500);
  }

  // ── undo / redo helpers ───────────────────────────────────────
  function setHTMLSilently(el, html) {
    suppressInput = true;
    el.innerHTML = html;
    setTimeout(() => { suppressInput = false; }, 0);
  }
  function flashElement(el, color) {
    if (!el) return;
    const prev = el.style.boxShadow, prevT = el.style.transition;
    el.style.transition = 'box-shadow 0.4s';
    el.style.boxShadow = '0 0 0 2px ' + color;
    setTimeout(() => { el.style.boxShadow = prev; el.style.transition = prevT; }, 700);
    if (el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  function undo() {
    flushPending();
    if (log.head === 0) return;
    const op = log.ops[log.head - 1];
    if (op.kind === 'theme') {
      setThemeRaw(op.token, op.before);
      refreshThemeUI(); refreshRawOverrides();
    } else {
      const el = elemAt(op.path);
      if (el) { setHTMLSilently(el, op.before); flashElement(el, '#e8b86b'); }
    }
    log.head--;
    persistLog(); updateStatus();
  }
  function redo() {
    flushPending();
    if (log.head === log.ops.length) return;
    const op = log.ops[log.head];
    if (op.kind === 'theme') {
      setThemeRaw(op.token, op.after);
      refreshThemeUI(); refreshRawOverrides();
    } else {
      const el = elemAt(op.path);
      if (el) { setHTMLSilently(el, op.after); flashElement(el, '#9ed27a'); }
    }
    log.head++;
    persistLog(); updateStatus();
  }
  function replayLog() {
    for (let k = 0; k < log.head; k++) {
      const op = log.ops[k];
      if (op.kind === 'theme') setThemeRaw(op.token, op.after);
      else {
        const el = elemAt(op.path);
        if (el && el.innerHTML !== op.after) el.innerHTML = op.after;
      }
    }
  }

  // ── editable mode ─────────────────────────────────────────────
  function applyEditableAttr(on) {
    const root = rootEl();
    root.querySelectorAll(EDITABLE_SEL).forEach(el => {
      if (el.closest('.ebar') || el.closest('.hp')) return;
      if (on) { el.setAttribute('contenteditable', 'true'); el.spellcheck = false; }
      else { el.removeAttribute('contenteditable'); }
    });
    document.body.classList.toggle('lh-editing', on);
    const btn = $('eb-toggle');
    if (btn) { btn.classList.toggle('on', on); btn.textContent = on ? 'on' : 'off'; }
  }
  function isEditing() { return document.body.classList.contains('lh-editing'); }

  // ── status / history panel ────────────────────────────────────
  function updateStatus() {
    const status = $('eb-status'), countEl = $('eb-count');
    const btnUndo = $('eb-undo'), btnRedo = $('eb-redo');
    const histPanel = $('eb-hist-panel');
    if (!status || !countEl) return;
    const n = log.head;
    countEl.textContent = n === 0 ? 'clean' : (n + (n === 1 ? ' edit' : ' edits'));
    countEl.classList.toggle('dirty', n > 0);
    status.classList.toggle('dirty', n > 0);
    if (btnUndo) btnUndo.disabled = log.head === 0;
    if (btnRedo) btnRedo.disabled = log.head === log.ops.length;
    if (histPanel && histPanel.classList.contains('open')) renderHistory();
  }
  function plain(html) {
    const t = (html || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    return t.length > 50 ? t.slice(0, 47) + '…' : t;
  }
  function whereLabel(path) {
    const segs = path.split('>');
    const head = segs[0] || '';
    const m = head.match(/section:(\d+)/);
    const where = m ? 'section ' + (+m[1] + 1) : head;
    const tail = segs[segs.length - 1].split(':')[0];
    return where + ' · ' + tail;
  }
  function escapeHtml(s) {
    return (s || '').replace(/[&<>"]/g,
      c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  }
  function renderHistory() {
    const histPanel = $('eb-hist-panel');
    if (!histPanel) return;
    const list = histPanel.querySelector('.hp-list');
    list.innerHTML = '';
    if (log.ops.length === 0) {
      list.innerHTML = '<div class="hp-empty">no ops · saved state matches disk</div>';
      return;
    }
    log.ops.forEach((op, k) => {
      const div = document.createElement('div');
      const isTheme = op.kind === 'theme';
      div.className = 'hp-row ' + (k < log.head ? 'applied' : 'unredone') + (isTheme ? ' theme' : '');
      const ts = new Date(op.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const where = isTheme ? ('theme · ' + escapeHtml(op.token)) : escapeHtml(whereLabel(op.path || ''));
      const diff = isTheme
        ? escapeHtml((op.before || '<base>') + ' → ' + (op.after || '<base>'))
        : '"' + escapeHtml(plain(op.before)) + '" → "' + escapeHtml(plain(op.after)) + '"';
      div.innerHTML =
        '<span class="hp-ts">' + ts + '</span>' +
        '<span class="hp-where">' + where + '</span>' +
        '<span class="hp-diff">' + diff + '</span>';
      div.title = (isTheme ? op.token : op.path) + '\n\nbefore: ' + (op.before || '') + '\nafter:  ' + (op.after || '');
      div.onclick = () => {
        if (isTheme) {
          const ctrl = document.querySelector('[data-ds-token="' + op.token + '"]');
          if (ctrl) flashElement(ctrl, '#e8b86b');
        } else {
          const el = elemAt(op.path);
          if (el) flashElement(el, '#7aa2ff');
        }
      };
      list.appendChild(div);
    });
  }

  // ── serialize / save / download ───────────────────────────────
  function bakeThemeBlock(clone) {
    const merged = {};
    const existing = clone.querySelector('#theme-overrides');
    if (existing) {
      const re = /(--[\w-]+)\s*:\s*([^;]+);/g;
      let m;
      while ((m = re.exec(existing.textContent)) !== null) merged[m[1]] = m[2].trim();
    }
    const inline = inlineThemeMap();
    for (const k in inline) merged[k] = inline[k];
    const keys = Object.keys(merged);
    if (keys.length === 0) { if (existing) existing.remove(); return; }
    const css = ':root{\n' + keys.map(k => '  ' + k + ': ' + merged[k] + ';').join('\n') + '\n}';
    if (existing) existing.textContent = css;
    else {
      const head = clone.querySelector('head');
      const styleEl = clone.ownerDocument.createElement('style');
      styleEl.id = 'theme-overrides';
      styleEl.textContent = css;
      head.appendChild(styleEl);
    }
  }
  function serializeDoc() {
    flushPending();
    const clone = document.documentElement.cloneNode(true);
    clone.querySelectorAll('[contenteditable]').forEach(n => n.removeAttribute('contenteditable'));
    clone.querySelectorAll('[spellcheck]').forEach(n => n.removeAttribute('spellcheck'));
    const body = clone.querySelector('body');
    if (body) body.classList.remove('lh-editing');
    const hp = clone.querySelector('#eb-hist-panel');
    if (hp) hp.classList.remove('open');
    clone.removeAttribute('style');
    bakeThemeBlock(clone);
    return '<!doctype html>\n' + clone.outerHTML;
  }
  function downloadCurrent() {
    const blob = new Blob([serializeDoc()], { type: 'text/html' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (location.pathname.split('/').pop() || 'index.html');
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 100);
  }

  // ── File System Access persistence (handle stashed in IndexedDB) ─
  function idb() {
    return new Promise((res, rej) => {
      const req = indexedDB.open(FH_DB, 1);
      req.onupgradeneeded = () => { req.result.createObjectStore('h'); };
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
  }
  async function getStoredHandle() {
    try {
      const db = await idb();
      return await new Promise(res => {
        const tx = db.transaction('h', 'readonly').objectStore('h').get('file');
        tx.onsuccess = () => res(tx.result || null);
        tx.onerror = () => res(null);
      });
    } catch (e) { return null; }
  }
  async function setStoredHandle(h) {
    const db = await idb();
    return new Promise(res => {
      const tx = db.transaction('h', 'readwrite').objectStore('h').put(h, 'file');
      tx.onsuccess = () => res(true);
      tx.onerror = () => res(false);
    });
  }
  async function ensurePermission(handle, mode) {
    mode = mode || 'readwrite';
    if (!handle.queryPermission) return true;
    if (await handle.queryPermission({ mode }) === 'granted') return true;
    return (await handle.requestPermission({ mode })) === 'granted';
  }
  async function save() {
    const btnSave = $('eb-save'), status = $('eb-status');
    if (btnSave) btnSave.disabled = true;
    try {
      if ('showOpenFilePicker' in window) {
        let handle = await getStoredHandle();
        if (handle && !(await ensurePermission(handle))) handle = null;
        if (!handle) {
          const picked = await window.showOpenFilePicker({
            types: [{ description: 'HTML', accept: { 'text/html': ['.html', '.htm'] } }]
          });
          handle = picked[0];
          await setStoredHandle(handle);
        }
        const w = await handle.createWritable();
        await w.write(serializeDoc());
        await w.close();
        log = { ops: [], head: 0 };
        persistLog(); updateStatus();
        if (status) status.classList.add('saved');
        if (btnSave) {
          btnSave.textContent = 'saved ✓';
          setTimeout(() => {
            btnSave.textContent = 'save';
            if (status) status.classList.remove('saved');
          }, 1400);
        }
      } else {
        downloadCurrent();
        alert('Your browser does not support direct file write. The current state was downloaded — replace the source file to persist. Local op log is preserved.');
      }
    } catch (e) {
      if (e && e.name === 'AbortError') { /* user cancelled */ }
      else { console.error(e); alert('Save failed: ' + (e.message || e)); }
    } finally {
      if (btnSave) btnSave.disabled = false;
    }
  }
  function revert() {
    const n = log.ops.length;
    if (n === 0) { if (!confirm('No local ops. Reload anyway?')) return; }
    else if (!confirm('Discard ' + n + ' op' + (n === 1 ? '' : 's') + ' and reload from disk?')) return;
    localStorage.removeItem(LOG_KEY);
    location.reload();
  }

  // ── design-system slide (optional) ────────────────────────────
  const COLOR_TOKENS = [
    { token: '--bg', label: 'bg', desc: 'page background' },
    { token: '--fg', label: 'fg', desc: 'main text' },
    { token: '--dim', label: 'dim', desc: 'secondary text' },
    { token: '--line', label: 'line', desc: 'borders / dividers' },
    { token: '--accent', label: 'accent', desc: 'primary highlight' },
    { token: '--accent2', label: 'accent2', desc: 'success / code' },
    { token: '--warn', label: 'warn', desc: 'amber callouts' },
    { token: '--code', label: 'code', desc: 'code block bg' }
  ];
  const TYPE_TOKENS = [
    { token: '--t-mega', label: 'mega', desc: 'hero', min: 24, max: 80 },
    { token: '--t-h1', label: 'h1', desc: 'heading', min: 14, max: 48 },
    { token: '--t-h2', label: 'h2', desc: 'subheading', min: 10, max: 32 },
    { token: '--t-h3', label: 'h3', desc: 'section heading', min: 9, max: 24 },
    { token: '--t-body', label: 'body', desc: 'p / li', min: 9, max: 22 },
    { token: '--t-small', label: 'small', desc: 'small text', min: 8, max: 18 },
    { token: '--t-caption', label: 'caption', desc: 'captions', min: 8, max: 16 }
  ];

  function normalizeHex(s) {
    if (!s) return null;
    s = s.trim();
    if (/^#([0-9a-fA-F]{3})$/.test(s)) {
      const m = s.slice(1);
      return '#' + m[0] + m[0] + m[1] + m[1] + m[2] + m[2];
    }
    if (/^#([0-9a-fA-F]{6})$/.test(s)) return s.toLowerCase();
    return null;
  }
  function computedToHex(token) {
    const v = currentThemeValue(token);
    const n = normalizeHex(v);
    if (n) return n;
    const m = v.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (m) {
      const h = x => (+x).toString(16).padStart(2, '0');
      return '#' + h(m[1]) + h(m[2]) + h(m[3]);
    }
    return '#000000';
  }
  function pxToNum(v) {
    if (!v) return NaN;
    const m = ('' + v).match(/(-?\d+(?:\.\d+)?)/);
    return m ? +m[1] : NaN;
  }
  function buildColorRow(spec) {
    const row = document.createElement('div');
    row.className = 'ds-row';
    row.dataset.dsToken = spec.token;
    const hex = computedToHex(spec.token);
    row.innerHTML =
      '<span class="ds-name" title="' + spec.desc + '">' + spec.label + '</span>' +
      '<span style="display:flex;align-items:center;gap:8px">' +
        '<input type="color" class="ds-swatch" data-ds-color="' + spec.token + '" value="' + hex + '">' +
        '<span class="ds-name" style="color:var(--lh-fg)">' + spec.token + '</span>' +
      '</span>' +
      '<input type="text" class="ds-hex" data-ds-hex="' + spec.token + '" value="' + hex + '" spellcheck="false">' +
      '<button class="ds-reset" data-ds-reset="' + spec.token + '" title="reset to base">reset</button>';
    return row;
  }
  function buildTypeRow(spec) {
    const row = document.createElement('div');
    row.className = 'ds-type-row';
    row.dataset.dsToken = spec.token;
    const px = pxToNum(currentThemeValue(spec.token));
    row.innerHTML =
      '<span class="ds-name" title="' + spec.desc + '">' + spec.label + '</span>' +
      '<span class="ds-type-sample" style="font-size:var(' + spec.token + ')">The quick brown fox</span>' +
      '<input type="number" class="ds-num" data-ds-num="' + spec.token + '" min="' + spec.min + '" max="' + spec.max + '" step="0.5" value="' + px + '">' +
      '<button class="ds-reset" data-ds-reset="' + spec.token + '" title="reset to base">reset</button>';
    return row;
  }
  function initDesignSystem() {
    const dsSlide = document.querySelector('.ds-slide');
    const colorWrap = $('ds-colors');
    const typeWrap = $('ds-type');
    if (!dsSlide || !colorWrap || !typeWrap) return false;
    COLOR_TOKENS.forEach(s => colorWrap.appendChild(buildColorRow(s)));
    TYPE_TOKENS.forEach(s => typeWrap.appendChild(buildTypeRow(s)));

    function onChangeColor(token, newHex) {
      const before = document.documentElement.style.getPropertyValue(token).trim();
      if (before === newHex) return;
      setThemeRaw(token, newHex);
      recordThemeChange(token, before, newHex);
    }
    function onChangeNum(token, newPx) {
      const before = document.documentElement.style.getPropertyValue(token).trim();
      const after = newPx + 'px';
      if (before === after) return;
      setThemeRaw(token, after);
      recordThemeChange(token, before, after);
    }
    function onReset(token) {
      const before = document.documentElement.style.getPropertyValue(token).trim();
      if (!before) return;
      setThemeRaw(token, '');
      recordThemeChange(token, before, '');
    }
    document.addEventListener('input', e => {
      const t = e.target;
      if (!t.dataset) return;
      if (t.dataset.dsColor) onChangeColor(t.dataset.dsColor, t.value);
      else if (t.dataset.dsHex) {
        const norm = normalizeHex(t.value);
        if (norm) { t.style.borderColor = ''; onChangeColor(t.dataset.dsHex, norm); }
        else t.style.borderColor = 'var(--lh-warn)';
      } else if (t.dataset.dsNum) {
        const v = +t.value;
        if (isFinite(v) && v > 0) onChangeNum(t.dataset.dsNum, v);
      }
    });
    document.addEventListener('click', e => {
      const t = e.target;
      if (t.dataset && t.dataset.dsReset) onReset(t.dataset.dsReset);
    });
    return true;
  }
  function refreshThemeUI() {
    document.querySelectorAll('[data-ds-color]').forEach(el => {
      const v = computedToHex(el.dataset.dsColor);
      if (el.value !== v) el.value = v;
    });
    document.querySelectorAll('[data-ds-hex]').forEach(el => {
      const v = computedToHex(el.dataset.dsHex);
      if (el.value !== v) { el.value = v; el.style.borderColor = ''; }
    });
    document.querySelectorAll('[data-ds-num]').forEach(el => {
      const v = pxToNum(currentThemeValue(el.dataset.dsNum));
      if (+el.value !== v) el.value = v;
    });
  }
  function refreshRawOverrides() {
    const pre = $('ds-raw');
    if (!pre) return;
    const m = inlineThemeMap();
    const keys = Object.keys(m);
    if (keys.length === 0) {
      pre.innerHTML = '<span class="empty">no overrides · matches base design system</span>';
      return;
    }
    pre.textContent = ':root{\n' + keys.map(k => '  ' + k + ': ' + m[k] + ';').join('\n') + '\n}';
  }

  // ── wire up DOM listeners ─────────────────────────────────────
  function wireToolbar() {
    $('eb-toggle').onclick = () => applyEditableAttr(!isEditing());
    $('eb-undo').onclick = undo;
    $('eb-redo').onclick = redo;
    $('eb-save').onclick = save;
    $('eb-download').onclick = downloadCurrent;
    $('eb-revert').onclick = revert;
    const histPanel = $('eb-hist-panel');
    $('eb-history').onclick = () => {
      histPanel.classList.toggle('open');
      if (histPanel.classList.contains('open')) renderHistory();
    };
    const closeBtn = $('eb-hp-close');
    if (closeBtn) closeBtn.onclick = () => histPanel.classList.remove('open');
  }
  function wireGlobalEvents() {
    document.addEventListener('focusin', e => {
      if (e.target.isContentEditable) startPending(e.target);
    });
    document.addEventListener('focusout', e => {
      if (e.target.isContentEditable) flushPending();
    });
    document.addEventListener('input', e => {
      if (suppressInput) return;
      if (!e.target.isContentEditable) return;
      updatePending(e.target);
      bumpIdle();
    });
    document.addEventListener('keydown', e => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault(); undo();
      } else if (meta && ((e.shiftKey && (e.key === 'z' || e.key === 'Z')) || e.key === 'y' || e.key === 'Y')) {
        e.preventDefault(); redo();
      }
    });
    window.addEventListener('beforeunload', e => {
      if (log.head > 0) { e.preventDefault(); e.returnValue = ''; }
    });
  }

  // ── boot ──────────────────────────────────────────────────────
  function boot() {
    if (!hasToolbar()) return; // no-op on pages without the snippet
    wireToolbar();
    wireGlobalEvents();
    loadLog();
    replayLog();
    initDesignSystem();
    refreshThemeUI();
    refreshRawOverrides();
    updateStatus();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // ── public API ────────────────────────────────────────────────
  window.LiveHTML = {
    enable() { applyEditableAttr(true); },
    disable() { applyEditableAttr(false); },
    undo() { undo(); },
    redo() { redo(); },
    save() { return save(); },
    getLog() { return JSON.parse(JSON.stringify(log)); },
    revert() { revert(); }
  };
})();
