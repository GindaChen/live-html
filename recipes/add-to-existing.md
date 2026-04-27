# Recipe: add live-html to an existing HTML file

Bolt the editor onto a page you already have. Five minutes. No build step.

## Steps

### 1. Drop `editor.css` into `<head>`

Either link it:

```html
<link rel="stylesheet" href="editor.css">
```

…or, for the self-contained-file case, paste its contents inside an existing `<style>` block. The stylesheet defines the toolbar, history panel, and edit-mode outlines. It does not touch your page's own styles.

### 2. Paste `snippet.html` before `</body>`

`snippet.html` is the markup for the editor toolbar (top-right) and the history panel. Paste it verbatim immediately before `</body>`. It uses `position: fixed` and won't disturb your layout.

### 3. Drop `editor.js` after the snippet

```html
<script src="editor.js"></script>
```

…or paste it inline, same reasoning as step 1. The script auto-initializes on `DOMContentLoaded`. There is no `LiveHTML.init()` call to make for the basic flow.

By default the editor treats every `h1, h2, h3, h4, p, li, td, th, blockquote, figcaption` as editable. Override by setting `window.LIVE_HTML_EDITABLE_SEL` to a CSS selector before the script runs.

### 4. (Optional) define CSS custom properties for design tokens

If you want the theme picker to do anything useful, declare your design tokens as CSS variables on `:root`:

```css
:root {
  --bg: #0d1117;
  --fg: #e6edf3;
  --accent: #7aa2f7;
  --t-body: 16px;
  --t-h2: 28px;
}
```

The editor enumerates `:root` custom properties on first edit and surfaces them in the theme picker. No registration step.

### 5. (Optional) add a `.ds-slide` section to expose them as a design system

For decks and design-system viewers, drop the prebuilt `design-system.html` snippet as one of your slides (or any section). It auto-renders a swatch grid of all `:root` custom properties and a theme-picker dropdown populated from `<script type="application/json" id="themes">` (if present). Edits to swatches commit `theme` ops; selecting from the dropdown commits a `theme-switch` op.

### 6. Test the round trip

1. Open the file in a Chromium-based browser (File System Access API is required; Firefox does not yet ship the writable side).
2. Click "edit on" in the top-right toolbar.
3. Click any heading or paragraph and revise it. The history panel shows the op.
4. Click "save". The browser prompts once for permission to overwrite the original file. Grant it.
5. Reload. Your edit is in the file on disk. Op log is cleared.

## Common gotchas

- **Path identity assumes structure is stable between sessions.** If you hand-edit the source file to reorder slides, save (or discard) any in-flight in-browser edits *first*. A fresh save clears the op log so reordering can't desync replay.
- **Spaces in filenames** are fine for read but historically have been flaky for write across some File System Access permission flows. If saves silently fail, rename the file to remove spaces and retry.
- **Permission is per-handle.** Closing the tab drops the file handle; reopening will re-prompt for permission on the next save. We persist the handle in IndexedDB to minimize re-prompts but the browser may still ask.
- **localStorage is per-origin.** Two pages on `file://` share an origin (the empty origin). If you have two live-html pages open from `file://`, namespace the log key — set `window.LIVE_HTML_LOG_KEY` to a per-page slug before `editor.js` runs.
- **iframes don't get File System Access.** If your page is loaded inside an iframe, save will fail. Open the page top-level.
- **Firefox** does not ship `showSaveFilePicker` writes as of writing. The editor falls back to download-on-save (you get a `.html` file in your Downloads folder; you replace the original manually). Use Chromium for the smooth flow.
