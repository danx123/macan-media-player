// ═══════════════════════════════════════════════════════════════
// MACAN MEDIA PLAYER — PLUGIN LOADER CONFIG  (Patch 12)
//
// To add a new plugin:
//   1. Drop your plugin .js file into assets/plugins/
//   2. Add ONE line here: 'plugins/your-plugin.js'
//
// That's it. No other file needs to be touched.
// Plugins load in the order listed below.
// ═══════════════════════════════════════════════════════════════

(function loadPlugins() {
  const PLUGINS = [
    // ── Add plugin paths here ──────────────────────────────
    // 'plugins/sleep-timer.js',
    // 'plugins/lastfm-scrobbler.js',
    // 'plugins/discord-rpc.js',
    // 'plugins/theme-switcher.js',
    // ───────────────────────────────────────────────────────
  ];

  if (!window.MacanBridge) {
    console.error('[PluginLoader] MacanBridge not found — plugin-bridge.js must load first');
    return;
  }

  PLUGINS.forEach(src => {
    const script    = document.createElement('script');
    script.src      = src;
    script.async    = false; // preserve load order
    script.onerror  = () => console.warn(`[PluginLoader] Failed to load plugin: ${src}`);
    document.head.appendChild(script);
  });

  if (PLUGINS.length > 0) {
    console.log(`[PluginLoader] Loading ${PLUGINS.length} plugin(s)…`);
  } else {
    console.log('[PluginLoader] No plugins configured.');
  }
})();
