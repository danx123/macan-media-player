# Contributing to Macan Media Player

Thank you for your interest in contributing to Macan Media Player. This document describes the contribution process, coding conventions, and architectural boundaries you should understand before submitting changes.

---

## Table of Contents

- [Project Philosophy](#project-philosophy)
- [What We Welcome](#what-we-welcome)
- [Getting Started](#getting-started)
- [Branching and Commit Conventions](#branching-and-commit-conventions)
- [Architectural Boundaries](#architectural-boundaries)
- [Coding Standards](#coding-standards)
- [Testing Before Submitting](#testing-before-submitting)
- [Pull Request Guidelines](#pull-request-guidelines)
- [Reporting Bugs](#reporting-bugs)
- [Requesting Features](#requesting-features)

---

## Project Philosophy

Macan Media Player is built around a principle of **architectural stability**. The core application — its audio engine, playback controls, playlist management, equalizer, and primary UI — is considered stable and is not modified lightly. Every change to a shared file carries the risk of a cascading side effect in an unrelated area, a pattern observed repeatedly during development.

For this reason, the project distinguishes between two categories of work:

**Core** — The existing `script.js`, `style.css`, `index.html`, and all named module files (`equalizer.js`, `radio-tv.js`, `lyrics.js`, etc.). Core changes require a strong justification, careful review, and thorough testing across all affected areas.

**Extension** — New functionality implemented as self-contained plugins through the Plugin Bridge Adapter (`plugin-bridge.js`). This is the preferred path for adding new features. Plugins do not require modifying any Core file.

When in doubt, build a plugin.

---

## What We Welcome

**Bug fixes** — Reproducible defects in existing functionality. Please include a clear description of the symptom, the root cause if known, and a minimal reproduction case.

**Plugin contributions** — New features implemented through the Plugin Bridge Adapter. A well-written plugin that ships as a single `.js` file in `assets/plugins/` is the ideal form of a feature contribution.

**Documentation improvements** — Corrections, clarifications, and additions to any document in the repository.

**Performance improvements** — Measurable optimizations that do not alter user-visible behavior or architectural structure.

**Platform compatibility fixes** — Corrections for behavior that differs between operating systems or WebView2 versions, provided the fix does not break the primary Windows build.

**What we do not accept** — Refactors of working Core code without a concrete problem statement, changes that add external runtime dependencies to `main.py` without discussion, and modifications that break the existing module isolation pattern.

---

## Getting Started

### Prerequisites

- Python 3.10 or later
- Windows 10 or later (primary development platform; WebView2 Runtime must be installed)
- Microsoft Edge WebView2 Runtime (included with Windows 11; available separately for Windows 10)
- Node.js (optional — only required for running JavaScript syntax checks locally)

### Install Python dependencies

```bash
pip install pywebview mutagen requests Pillow
```

### Run the application

```bash
python main.py
```

The application window opens full-screen. Development builds use `debug=False` in `webview.start()`. To enable the WebView2 DevTools panel, temporarily change this to `debug=True` in `main.py` before running.

### Project layout

```
macan-media-player/
├── main.py                   Python backend + WebView2 entry point
├── assets/
│   ├── index.html            Application shell (do not modify lightly)
│   ├── index.live.html       Auto-generated cache-busted copy (do not commit)
│   ├── style.css             Global stylesheet (Core — do not modify lightly)
│   ├── script.js             Primary JS module (Core — do not modify lightly)
│   ├── plugin-bridge.js      Plugin Bridge Adapter
│   ├── plugins.config.js     Plugin loader manifest
│   ├── equalizer.js          10-band EQ module
│   ├── radio-tv.js           Online radio and TV module
│   ├── lyrics.js             Lyrics display module
│   ├── smart-playlist.js     Smart Playlist module
│   ├── settings.js           Settings module
│   ├── listen-stats.js       Listen Statistics module
│   ├── achievements.js       Achievement System module
│   ├── user-profile.js       User Profile module
│   ├── nav-menu.js           Navigation menu module
│   ├── about.js              About panel module
│   ├── converter.js          Audio converter module
│   └── plugins/              Plugin files (one .js file per plugin)
│       └── sleep-timer.js    Example plugin
└── core/
	├── converter.py          Engine for convert audio/video
    └── video_utils.py        Video thumbnail utility
```

---

## Branching and Commit Conventions

### Branch naming

```
fix/short-description          Bug fixes
feature/short-description      New features or plugins
docs/short-description         Documentation only
perf/short-description         Performance improvements
```

### Commit message format

```
type: short imperative summary (max 72 chars)

Optional body explaining WHY, not WHAT. Wrap at 80 characters.
Reference issues with: Closes #123
```

Types: `fix`, `feat`, `docs`, `perf`, `refactor`, `test`, `chore`

Examples:

```
fix: restore SMTC metadata after track switch while minimized
feat: add sleep timer plugin
docs: add plugin development guide
perf: throttle onTimeUpdate SMTC sync to 1s interval
```

---

## Architectural Boundaries

### The Core is frozen

The following files should not be modified unless absolutely necessary:

- `script.js` — The primary application logic. If you need a hook point that does not yet exist, propose adding a `MacanBridge.emit()` call rather than adding feature logic inline.
- `index.html` — The application shell. New features should not require new overlay markup here; use `MacanBridge.api.createOverlay()` instead.
- `style.css` — Global styles. Plugin styles should be injected via the `styles` field in `MacanBridge.register()`.
- `nav-menu.js` — Navigation menu. New menu items should be registered via `MacanBridge.api.registerMenuItem()`.
- All named feature modules (`equalizer.js`, `radio-tv.js`, etc.) — These are complete and stable. Do not modify them to accommodate new features.

### The Plugin Bridge is the extension point

Any new feature that is not a bug fix in existing Core behavior should be implemented as a plugin. See [plugin_development.md](plugin_development.md) for the full guide.

### Python API additions

Adding a method to `MacanMediaAPI` in `main.py` is acceptable when a plugin requires Python-side functionality. Follow the existing pattern: the method should be a clean, focused function with a clear docstring, appropriate error handling, and no side effects on unrelated state. Methods that are only useful to a specific plugin should be implemented as a `plugin_request` handler registered via `api.register_plugin_handler()` rather than as a public method on the class.

---

## Coding Standards

### Python

- Follow PEP 8. Line length: 100 characters maximum.
- Type hints on all new public methods.
- Docstrings on all public methods using the existing style (one-line summary, blank line, extended description if needed).
- Catch specific exceptions, not bare `except:`. Log errors with a `[MACAN]` prefix.
- Thread safety: acquire `self._settings_lock` before reading or writing `self.settings`. pywebview calls each JS→Python bridge method on its own thread.

### JavaScript

- `'use strict'` is implied by the existing module pattern. Do not add it redundantly.
- Use `const` and `let`; never `var`.
- Prefer named functions over anonymous arrow functions for anything that will appear in stack traces.
- Optional chaining (`?.`) when accessing bridge or module globals that may not be present: `window.MacanBridge?.emit(...)`.
- Plugin CSS class names must be prefixed with `plg-{plugin-id}-` to avoid conflicts with Core styles.
- Plugin localStorage keys must be prefixed with `macan_plg_{plugin_id}_` to avoid conflicts with Core keys.

### CSS

- All plugin styles must be scoped with a unique `.plg-{plugin-id}-` prefix.
- Do not override Core CSS selectors from a plugin stylesheet.
- Use CSS custom properties (`var(--accent)`, `var(--accent-dim)`, `var(--accent-glow)`) for accent colors so the Dynamic Aura system applies automatically.

---

## Testing Before Submitting

There is no automated test suite. All verification is manual. Before submitting a pull request, test the following:

**Playback fundamentals** — Load a folder of mixed audio and video files. Verify play, pause, next, previous, seek, shuffle, and repeat all function correctly. Verify the fade-in and fade-out transitions are smooth on play and pause.

**Your change specifically** — Test every user-visible behavior affected by your change. If you fixed a bug, verify the original symptom is gone. If you added a plugin, test every interaction path including edge cases (no tracks loaded, track with no album art, etc.).

**Regression across unrelated areas** — After any change to `script.js`, test the equalizer, seekbar, minimize/restore, SMTC hardware keys, and the Smart Playlist panel. These are the areas most frequently affected by side effects.

**JavaScript syntax** — If Node.js is available:
```bash
node --check assets/script.js
node --check assets/plugin-bridge.js
node --check assets/plugins/your-plugin.js
```

**Python syntax:**
```bash
python -c "import ast; ast.parse(open('main.py').read()); print('OK')"
```

---

## Pull Request Guidelines

- One logical change per pull request. Do not bundle a bug fix with a new feature.
- Fill in the pull request description completely: what changed, why, how it was tested.
- Reference any related issue numbers.
- Do not commit `assets/index.live.html` — this file is auto-generated at startup and should be in `.gitignore`.
- Do not commit personal data directories (`WebView2Profile/`, `*.db`, `AlbumArtCache/`).

---

## Reporting Bugs

Open a GitHub issue with the following information:

- Operating system and Windows version
- A clear description of the symptom
- Steps to reproduce, as minimal as possible
- Expected behavior vs. actual behavior
- Any error messages visible in the console (enable `debug=True` in `main.py` to open DevTools)

---

## Requesting Features

Open a GitHub issue with the label `feature request`. Describe the use case, not just the implementation. If the feature can be implemented as a plugin without modifying any Core file, note that — such requests are more likely to be accepted and can often be implemented by the requester directly by following [plugin_development.md](plugin_development.md).
