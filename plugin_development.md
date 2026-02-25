# Plugin Development Guide — Macan Media Player

This guide covers everything you need to build a plugin for Macan Media Player using the Plugin Bridge Adapter introduced in Patch 12.

---

## Table of Contents

- [Overview](#overview)
- [Quick Start](#quick-start)
- [Plugin Anatomy](#plugin-anatomy)
- [Registration Descriptor](#registration-descriptor)
- [Hook Events](#hook-events)
- [Bridge API Reference](#bridge-api-reference)
- [Python Integration](#python-integration)
- [Overlay System](#overlay-system)
- [Navigation Menu](#navigation-menu)
- [Style Injection](#style-injection)
- [Toast Notifications](#toast-notifications)
- [Data Persistence](#data-persistence)
- [Design Guidelines](#design-guidelines)
- [Worked Example: Sleep Timer](#worked-example-sleep-timer)
- [Troubleshooting](#troubleshooting)

---

## Overview

The Plugin Bridge Adapter (`plugin-bridge.js`) is an architectural layer that lets you add new features to Macan Media Player **without modifying any existing file**. A plugin is a single self-contained JavaScript file that:

- Registers itself with `MacanBridge.register(descriptor)`
- Subscribes to playback events via `MacanBridge.on()`
- Reads player state via `MacanBridge.api`
- Optionally calls Python via `MacanBridge.py()`
- Optionally provides a UI panel via the overlay factory
- Optionally adds a navigation menu item

The bridge handles CSS injection, overlay creation, menu injection, and Python routing on your behalf. You write feature logic; the bridge handles integration.

**What plugins can do:**
- React to playback events (track changes, play, pause, seek, queue updates)
- Read current player state (track, position, playlist, volume)
- Display modal panels with custom UI
- Show toast notifications and update the status bar
- Call Python for file system access, network requests, or any custom backend logic
- Inject scoped CSS without touching `style.css`
- Add navigation menu items without touching `nav-menu.js`

**What plugins cannot do:**
- Modify Core HTML structure (`index.html`)
- Override Core CSS selectors
- Call destructive Python API methods directly (`clear_playlist`, `close_app`, etc.)
- Emit bridge events (only `script.js` emits; plugins only subscribe)

---

## Quick Start

**Step 1** — Create your plugin file at `assets/plugins/my-plugin.js`:

```javascript
MacanBridge.register({
  id:      'my-plugin',
  name:    'My Plugin',
  version: '1.0.0',

  on: {
    'track:load': (track) => {
      console.log('[my-plugin] Now playing:', track.name);
    },
  },

  init() {
    console.log('[my-plugin] Initialized');
  },
});
```

**Step 2** — Add one line to `assets/plugins.config.js`:

```javascript
const PLUGINS = [
  'plugins/my-plugin.js',
];
```

That is all. Restart the application. Your plugin is active.

---

## Plugin Anatomy

A well-structured plugin file has three sections:

```javascript
// ── 1. Registration ──────────────────────────────────────────
// Declares the plugin to the bridge. Runs immediately at load time.
MacanBridge.register({
  id: 'my-plugin',
  name: 'My Plugin',
  version: '1.0.0',
  on:     { /* hook subscriptions */ },
  menu:   { /* nav menu item */ },
  styles: `/* scoped CSS */`,
  init()  { MyPlugin._buildUI(); },
});

// ── 2. Module ────────────────────────────────────────────────
// Self-contained logic. Can be an IIFE, a plain object, or a class.
// Avoid polluting window with multiple globals.
const MyPlugin = (() => {
  // private state
  let _overlay;

  function _buildUI() {
    _overlay = MacanBridge.api.createOverlay('my-plugin', {
      html: '<div>Hello from my plugin</div>',
    });
  }

  function open() {
    _overlay.classList.add('active');
  }

  return { open };
})();
```

---

## Registration Descriptor

All fields passed to `MacanBridge.register()`:

```javascript
MacanBridge.register({
  // ── Required ─────────────────────────────────────────────
  id:      string,   // Unique kebab-case identifier. Used as prefix for
                     // overlay IDs, CSS classes, and menu item IDs.
                     // Example: 'lastfm-scrobbler'

  name:    string,   // Human-readable display name.
                     // Example: 'Last.fm Scrobbler'

  // ── Optional ─────────────────────────────────────────────
  version: string,   // Semantic version string. Default: '1.0.0'

  on: {              // Hook subscriptions. Each key is an event name,
                     // each value is a handler function.
    'track:load':   (track)   => { },
    'player:play':  (payload) => { },
    // … see Hook Events section for full list
  },

  menu: {            // Navigation menu item. Omit if no menu item needed.
    label:  string,  // Menu item text. Conventionally ALL CAPS.
    icon:   string,  // SVG string. Recommended: 16×16 viewBox.
    order:  number,  // Sort order. Default 500. Higher = lower in list.
                     // Core items use orders < 100. Use 200+ for plugins.
    action: fn,      // Called when the user clicks the menu item.
    danger: boolean, // Optional. Renders in red if true.
  },

  styles: string,    // CSS string. Injected once as a <style> tag.
                     // All selectors must be scoped with .plg-{id}- prefix.

  init: fn,          // Called once immediately after registration.
                     // Use to build UI elements and attach event listeners.
});
```

---

## Hook Events

These events are emitted by `script.js` at strategic points. Subscribe in the `on` field of your descriptor or via `MacanBridge.on()` after registration.

| Event | Payload | When |
|---|---|---|
| `track:load` | `track` | A track has been loaded (index set, metadata available). Fires before playback starts. |
| `player:play` | `{ track, currentTime }` | Playback has started or resumed. |
| `player:pause` | `{ track, currentTime }` | Playback has paused. Includes pauses triggered by the bridge's own `doFadeOut`. |
| `player:seek` | `{ currentTime, duration, percent }` | Position update. Throttled to once per second to avoid excessive handler calls. |
| `player:end` | `{ track }` | Track finished playing naturally (not triggered for skip or repeat-one restart). |
| `art:load` | `{ src, track }` | Album art has been successfully loaded into the `<img>` element. |
| `art:clear` | `null` | Album art has been cleared (queue was cleared or a track with no art loaded). |
| `queue:clear` | `null` | The queue has been fully cleared. |
| `queue:add` | `{ tracks[] }` | Tracks have been added to the queue (from file picker, folder scan, or named playlist load). The full current playlist is included. |

**Subscribing outside of registration:**

```javascript
// Returns an unsubscribe function
const unsub = MacanBridge.on('track:load', (track) => {
  console.log('Track changed:', track.name);
});

// Later, to stop listening:
unsub();
```

**Exception isolation:** If your handler throws, the bridge catches the exception, logs it with your plugin ID, and continues notifying other subscribers. A broken handler will not crash the player or affect other plugins.

---

## Bridge API Reference

`MacanBridge.api` provides the safe interface to player state and utilities.

### Playback state (synchronous)

```javascript
MacanBridge.api.getCurrentTrack()
// Returns: track object or null if nothing is loaded.
// Track shape: { path, url, name, artist, album, ext, duration,
//               is_video, cover_art, replaygain_db, … }

MacanBridge.api.getPlaylist()
// Returns: shallow copy of the current queue as an array.

MacanBridge.api.getCurrentTime()
// Returns: number — current playback position in seconds.

MacanBridge.api.getDuration()
// Returns: number — total duration of the current track in seconds.

MacanBridge.api.isPlaying()
// Returns: boolean

MacanBridge.api.isShuffle()
// Returns: boolean

MacanBridge.api.getRepeatMode()
// Returns: 'none' | 'all' | 'one'

MacanBridge.api.getVolume()
// Returns: number 0–100 (current volume slider value)
```

### Python read methods (asynchronous)

These call the Python backend. All return Promises.

```javascript
// Fetch cover art as a base64 data: URL for a given file path.
// Returns: string (data URL) or null
const art = await MacanBridge.api.getCoverArt('/path/to/file.mp3');

// Get the named playlist registry.
// Returns: object — { playlistName: trackCount, … }
const registry = await MacanBridge.api.getPlaylistRegistry();

// Get the full application settings object.
// Returns: object
const settings = await MacanBridge.api.getSettings();
```

### UI utilities

```javascript
// Update the player status bar text (bottom of the main panel).
MacanBridge.api.setStatus('MY PLUGIN — ACTIVE');

// Show a toast notification (bottom-center, fades in and out).
// duration: milliseconds. Default: 3000.
MacanBridge.api.showToast('OPERATION COMPLETE', 4000);

// Format a number of seconds as M:SS.
// Returns: string, e.g. '3:47'
const formatted = MacanBridge.api.formatTime(227);
```

### Overlay factory

```javascript
// Create and return a modal overlay element (appended to document.body).
// If an overlay for this pluginId already exists, the existing element
// is returned without creating a duplicate.
const overlay = MacanBridge.api.createOverlay('my-plugin', {
  html: '<div class="plg-my-plugin-content">…</div>',
});

// Show the overlay
overlay.classList.add('active');

// Hide the overlay
overlay.classList.remove('active');
```

The overlay has:
- ID: `plg-{pluginId}-overlay`
- Class: `plg-overlay` (styled by bridge base CSS)
- Inner panel class: `plg-panel plg-{pluginId}-panel`
- Auto-close on backdrop click
- Auto-close on Escape key

### Nav menu item

```javascript
// Register a menu item at any time (deferred until the menu list is ready).
MacanBridge.api.registerMenuItem({
  label:  'MY PLUGIN',
  icon:   '<svg>…</svg>',
  order:  300,
  action: () => MyPlugin.open(),
});
```

---

## Python Integration

For features that require Python — file system access, network requests, external process communication, or anything that cannot be done in the browser sandbox — the bridge provides a generic routing mechanism.

### JavaScript side

```javascript
// MacanBridge.py(pluginId, action, payload) → Promise<{ ok, result|error }>
const response = await MacanBridge.py('my-plugin', 'fetch_data', {
  query: 'Linkin Park',
});

if (response.ok) {
  console.log(response.result);
} else {
  console.error('Python error:', response.error);
}
```

`MacanBridge.py()` calls `pywebview.api.plugin_request(pluginId, action, payload)` on the Python backend. If `pywebview` is not available (development outside the pywebview environment), the call is silently skipped and returns `null`.

### Python side

Register your handler in `main.py`, after the `api = MacanMediaAPI()` instance is created and before `webview.start()`:

```python
def my_fetch_handler(payload: dict) -> dict:
    query = payload.get('query', '')
    # do something with query…
    return {'results': ['Track A', 'Track B']}

api.register_plugin_handler('my-plugin', 'fetch_data', my_fetch_handler)
```

The handler receives the payload dict from JS and must return a JSON-serializable value. Exceptions are caught by `plugin_request()` and returned as `{ 'ok': False, 'error': '…' }`.

**Response envelope:**

```javascript
// On success
{ ok: true, result: <your return value> }

// On error (no handler registered, or handler raised an exception)
{ ok: false, error: 'No handler registered for "my-plugin:fetch_data"' }
```

### Routing key

The routing key is `{plugin_id}:{action}`. It must match exactly between the JS `py()` call and the Python `register_plugin_handler()` call. Keys are case-sensitive.

---

## Overlay System

Overlays follow the standard Macan panel pattern: fixed-position fullscreen backdrop with a centered floating panel. Base styles are provided by the bridge; your plugin only needs to style the panel content.

```javascript
// Minimal overlay
const overlay = MacanBridge.api.createOverlay('my-plugin');
const panel   = overlay.querySelector('.plg-my-plugin-panel');
panel.innerHTML = '<p>Content here</p>';
overlay.classList.add('active');

// With initial HTML
const overlay = MacanBridge.api.createOverlay('my-plugin', {
  html: `
    <div class="plg-my-plugin-header">
      <span class="plg-my-plugin-title">MY PLUGIN</span>
      <button id="plg-my-plugin-close">✕</button>
    </div>
    <div class="plg-my-plugin-body">
      <!-- content -->
    </div>
  `,
});

// Wire close button
overlay.querySelector('#plg-my-plugin-close')
  .addEventListener('click', () => overlay.classList.remove('active'));
```

**Base classes available from the bridge:**

| Class | Element | Applied by |
|---|---|---|
| `.plg-overlay` | Outer backdrop div | Bridge automatically |
| `.plg-panel` | Inner panel div | Bridge automatically |
| `.plg-overlay.active` | Visible state | Your `classList.add('active')` |

**Panel sizing defaults:**
- `min-width: 340px`
- `max-width: 92vw`
- `max-height: 88vh`
- `overflow-y: auto`
- Dark background matching core UI

Override sizing in your plugin CSS:

```css
.plg-my-plugin-panel {
  width: 520px;
  max-height: 70vh;
}
```

---

## Navigation Menu

Menu items are injected before the EXIT separator at the bottom of the navigation panel. They cannot be inserted into specific positions within the Core item list — only ordered among other plugin items.

```javascript
MacanBridge.api.registerMenuItem({
  label:  'MY FEATURE',          // ALL CAPS convention
  icon:   `<svg width="16" height="16" viewBox="0 0 24 24"
             fill="none" stroke="currentColor" stroke-width="2">
             <circle cx="12" cy="12" r="10"/>
           </svg>`,
  order:  200,                   // plugin items: use 100–999
  action: () => MyFeature.open(),
  danger: false,                 // set true for destructive actions (red text)
});
```

Plugin items are visually distinguished from Core items by a small `PLUGIN` badge in accent yellow. This helps users identify which menu items come from the default application and which from installed plugins.

---

## Style Injection

Plugin styles are injected as a `<style data-plugin="my-plugin">` tag in `<head>`. They are applied once at registration time and persist for the lifetime of the page.

**Mandatory convention:** All selectors must begin with `.plg-{plugin-id}-`:

```javascript
MacanBridge.register({
  id: 'my-plugin',
  styles: `
    /* Panel layout */
    .plg-my-plugin-panel {
      padding: 28px;
    }

    /* Title */
    .plg-my-plugin-title {
      font-family: 'Space Mono', monospace;
      font-size: 0.7rem;
      letter-spacing: 3px;
      color: rgba(255,255,255,0.5);
    }

    /* Use Core accent color (Dynamic Aura aware) */
    .plg-my-plugin-button:hover {
      border-color: var(--accent);
      color: var(--accent);
    }

    /* Glow effect using accent */
    .plg-my-plugin-active {
      box-shadow: 0 0 12px var(--accent-glow);
    }
  `,
});
```

**Using accent color variables:**

The Core stylesheet defines three CSS custom properties that update when Dynamic Aura extracts a color from the album art:

| Variable | Value |
|---|---|
| `var(--accent)` | Primary accent hex color (default `#E8FF00`) |
| `var(--accent-dim)` | Accent at 14% alpha — suitable for subtle highlights |
| `var(--accent-glow)` | Accent at 28% alpha — suitable for glow effects |

Use these in your plugin CSS for accent colors and your plugin will automatically participate in the Dynamic Aura system.

---

## Toast Notifications

The bridge provides a single shared toast element at `#macan-bridge-toast`. Multiple calls before the previous toast expires restart the timer.

```javascript
// Default duration: 3000ms
MacanBridge.api.showToast('OPERATION COMPLETE');

// Custom duration
MacanBridge.api.showToast('SYNCING WITH LAST.FM...', 5000);

// Short confirmation
MacanBridge.api.showToast('SAVED', 1500);
```

Toast text is rendered in `Space Mono` monospace, uppercase-friendly. Keep messages short — the toast is single-line and will overflow if too long. Conventionally use ALL CAPS to match the player's typographic style.

---

## Data Persistence

Plugins should store persistent data in `localStorage` with a namespaced key.

**Key naming convention:** `macan_plg_{plugin_id}_{key_name}`

```javascript
const STORAGE_KEY = 'macan_plg_my_plugin_prefs';

function savePrefs(prefs) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch (e) {
    console.warn('[my-plugin] Failed to save prefs:', e);
  }
}

function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch {
    return {};
  }
}
```

Always wrap `localStorage` access in try/catch — storage may be unavailable or full.

`localStorage` is stored in the WebView2 persistent profile directory (`WebView2Profile/`) and survives application restarts. It is not cleared by the asset hash cache-busting mechanism, which only clears HTTP cache directories.

---

## Design Guidelines

**Typography** — Use `font-family: 'Space Mono', monospace` for labels, values, and headings to match the Core aesthetic. Regular body text can use system sans-serif. Letter spacing of `1px`–`3px` on small uppercase labels is idiomatic.

**Color palette** — Dark backgrounds: `#030303` (deepest), `#0c0c0c` (panel), `rgba(255,255,255,0.04)` (subtle surface). Text: `rgba(255,255,255,0.85)` (primary), `rgba(255,255,255,0.4)` (secondary), `rgba(255,255,255,0.2)` (muted). Use `var(--accent)` for interactive highlights.

**Border style** — `1px solid rgba(232,255,0,0.15)` for panel borders. `1px solid rgba(255,255,255,0.08)` for internal dividers.

**Border radius** — `10px` for panels, `6px` for buttons and inputs, `3px` for small elements.

**Button style** — Follow the pattern from the Sleep Timer example: `rgba(255,255,255,0.04)` background, `rgba(255,255,255,0.08)` border, accent-colored hover state.

**Spacing** — `28px` panel padding, `8px` element gap, `20px` section spacing.

**CSS scoping** — Every selector must begin with `.plg-{plugin-id}-`. Never target Core selectors (`.pl-item`, `#progress-bar`, etc.) from a plugin stylesheet.

**Error handling** — All async calls should have try/catch. All `localStorage` access should have try/catch. Never let an exception propagate to the bridge's handler dispatch loop (the bridge catches it, but an unhandled state is a bug in your plugin).

**Idempotent init** — Your `init()` function may theoretically be called more than once if the page reloads. Guard against duplicate overlay creation with the `createOverlay()` call's built-in deduplication.

---

## Worked Example: Sleep Timer

The Sleep Timer plugin (`assets/plugins/sleep-timer.js`) is the reference implementation. It demonstrates every bridge capability in a single file. Here is an annotated walkthrough of its key design decisions.

### Registration

```javascript
MacanBridge.register({
  id:      'sleep-timer',
  name:    'Sleep Timer',
  version: '1.0.0',

  menu: {
    label: 'SLEEP TIMER',
    order: 200,
    icon:  '<svg>…clock SVG…</svg>',
    action: () => SleepTimer.open(),
  },

  styles: `/* all selectors begin with .plg-st- or .plg-sleep-timer- */`,

  on: {
    // The player:pause event fires for ALL pauses, including the one
    // the timer itself triggers. The _source flag distinguishes these:
    // when the timer fires, it sets _source = 'timer' before calling
    // togglePlayPause(), so the handler knows to skip self-cancellation.
    'player:pause': () => {
      if (SleepTimer._source === 'timer') return;
      if (SleepTimer._timerId) {
        SleepTimer.cancel();
        MacanBridge.api.showToast('SLEEP TIMER CANCELLED');
      }
    },
  },

  init() { SleepTimer._buildUI(); },
});
```

### The `_source` flag pattern

When a plugin triggers a player action that will itself cause a hook event to fire, it needs a way to distinguish its own event from a user-initiated one. The Sleep Timer uses a `_source` flag:

```javascript
// Inside the countdown interval, when time expires:
_source = 'timer';              // mark as self-triggered
togglePlayPause();              // this causes player:pause to fire
// The player:pause handler sees _source === 'timer' and skips cancellation
```

This pattern is useful any time a plugin drives a state change that generates an event the plugin also subscribes to.

### Overlay construction

```javascript
function _buildUI() {
  _overlay = MacanBridge.api.createOverlay('sleep-timer', {
    html: `
      <div class="plg-st-title">⏱ SLEEP TIMER</div>
      <div class="plg-st-countdown inactive" id="plg-st-countdown">--:--</div>
      <div class="plg-st-presets" id="plg-st-presets"></div>
      <button class="plg-st-cancel" id="plg-st-cancel">✕ CANCEL TIMER</button>
      <div class="plg-st-status" id="plg-st-status">SELECT A DURATION</div>
    `,
  });
  // Wire up events after overlay exists in DOM
  _cancelBtn = _overlay.querySelector('#plg-st-cancel');
  _cancelBtn.addEventListener('click', () => { cancel(); MacanBridge.api.showToast('CANCELLED'); });
}
```

Note that all element IDs within the overlay use the `plg-st-` prefix to avoid any chance of collision with Core element IDs.

### Accessing the Core `togglePlayPause` function

The Sleep Timer calls `togglePlayPause()` directly because it is a global function in `script.js`. This is intentional: `togglePlayPause()` applies the fade-out correctly, whereas calling `activePlayer().pause()` directly would bypass the fade. Always prefer calling the high-level Core function over the low-level method when one exists.

---

## Troubleshooting

**Plugin not loading**
- Verify the path in `plugins.config.js` matches the actual file location exactly (case-sensitive on some systems).
- Check the browser console (enable `debug=True` in `main.py`) for `[PluginLoader]` error messages.
- Verify `plugin-bridge.js` loads without error before your plugin.

**`MacanBridge is not defined`**
- Your plugin file is loading before `plugin-bridge.js`. Check the script order in `index.html`. `plugin-bridge.js` must be the first `<script>` tag in the scripts block.

**Hook handler not firing**
- Verify the event name is spelled exactly as listed in the Hook Events table. Event names are case-sensitive.
- Use `MacanBridge._listPlugins()` in the browser console to verify your plugin is registered and the hooks are listed.

**Overlay not displaying**
- Verify you are calling `overlay.classList.add('active')` and not setting `display` or `visibility` directly.
- Check that the `plg-overlay` class is applied — it sets `position: fixed; inset: 0; z-index: 950`.

**CSS not applying**
- Verify your styles field is a string (not a template literal with unresolved expressions).
- Verify all your selectors begin with the correct `.plg-{id}-` prefix.
- Check for typos in class names between your HTML and your CSS.

**`MacanBridge.py()` returning `null`**
- Verify pywebview is available (`typeof pywebview !== 'undefined'`). Outside the pywebview environment, `py()` silently returns `null`.
- Verify `api.register_plugin_handler(id, action, fn)` is called in `main.py` before `webview.start()`.
- Verify the `plugin_id` and `action` strings match exactly between the JS call and the Python registration.

**Debugging tips**
- Open DevTools: set `debug=True` in `main.py` and press F12 (or right-click → Inspect).
- List all registered plugins: `MacanBridge._listPlugins()` in the console.
- Inspect bridge listeners: `MacanBridge` is available in the console as `window.MacanBridge`.
- Check for style injection: search for `<style data-plugin="your-id">` in the Elements panel.
