# Recipe: add a named theme

Named themes live in a `<script type="application/json" id="themes">` block. The editor treats this block as the source of truth for selectable themes. There is no registration API — you edit the JSON by hand and reload.

## Steps

### 1. Add (or extend) the registry

Place once, anywhere in the body:

```html
<script type="application/json" id="themes">
{
  "dark": {
    "--bg": "#0d1117",
    "--fg": "#e6edf3",
    "--accent": "#7aa2f7",
    "--dim": "#7d8590"
  },
  "paper": {
    "--bg": "#fbf7ee",
    "--fg": "#1a1a1a",
    "--accent": "#a14a3a",
    "--dim": "#7a6f5e"
  }
}
</script>
```

Each top-level key is a theme name. Each value is a partial map of CSS-variable overrides. Tokens you don't list fall through to the base CSS.

### 2. Reload

The editor picks up the registry on init. The theme picker (rendered into the design-system slide if present, or accessible via the toolbar) now lists `dark` and `paper`.

### 3. Switch

Two ways:

- **UI**: open the theme picker dropdown, choose the theme. The editor commits a `theme-switch` op (one undo step), swaps the contents of `<style id="theme-overrides">`, and sets `<html data-active-theme="dark">`.
- **API**: `LiveHTML.switchTheme('dark')` from the console or any script. Same effect.

### 4. Save

Save bakes the active overrides into the rendered `<style id="theme-overrides">` block in the file on disk and persists `data-active-theme` on `<html>`. Anyone opening the file later sees the same theme — and can switch to a different one without re-applying the registry, because the registry is part of the source.

## Notes

- **The registry is hand-edited, by design.** The editor never writes to `#themes`. If you want to "save the current overrides as a new named theme `night`", copy the contents of `<style id="theme-overrides">` into the registry under a new key by hand. We considered an editor-driven "save as theme" affordance and decided the round-trip wasn't worth the complexity — adding a theme is a once-per-week action at most.
- **Selectors keyed on `data-active-theme`.** You can write CSS like `html[data-active-theme="dark"] .figure { mix-blend-mode: screen; }`. The pointer is part of the public contract.
- **Removing a theme** that's currently active leaves overrides in place but unreachable from the picker. Switch to a different theme first, then delete.
