// ═══════════════════════════════════════════════════════════════
// MACAN MEDIA PLAYER — about.js
// Handles the About overlay: version display, update checker,
// and repository link.
//
// Update check flow:
//   1. User clicks CHECK UPDATE.
//   2. Fetch version.json from the GitHub raw URL.
//   3. Compare remote version against local APP_VERSION.
//   4. Display result inline — no automatic action is taken.
// ═══════════════════════════════════════════════════════════════
'use strict';

(function AboutModule() {

  // ── App metadata ────────────────────────────────────────────
  // Increment APP_VERSION with each release.
  const APP_VERSION   = '8.8.0';
  const APP_BUILD     = 'build.2026.02';
  const REPO_URL      = 'https://github.com/danx123/macan-media-player';
  const VERSION_JSON  = 'https://raw.githubusercontent.com/danx123/macan-media-player/main/version.json';

  // ── Element refs ────────────────────────────────────────────
  const overlay       = document.getElementById('about-overlay');
  const btnOpen       = document.getElementById('btn-about');
  const btnClose      = document.getElementById('about-close');
  const btnCheck      = document.getElementById('about-check-update');
  const statusEl      = document.getElementById('about-update-status');
  const progressWrap  = document.getElementById('about-update-progress');
  const progressBar   = document.getElementById('about-update-bar');
  const verNumEl      = document.getElementById('about-ver-num');
  const footerBuildEl = document.getElementById('about-footer-build');
  const repoLink      = document.getElementById('about-repo-link');

  if (!overlay || !btnOpen) return; // Guard: elements must exist

  // ── Initial population ──────────────────────────────────────
  if (verNumEl)      verNumEl.textContent      = `v${APP_VERSION}`;
  if (footerBuildEl) footerBuildEl.textContent  = APP_BUILD;
  if (repoLink) {
    repoLink.href = REPO_URL;
    // Open in default browser via pywebview if available, else new tab
    repoLink.addEventListener('click', e => {
      e.preventDefault();
      if (typeof pywebview !== 'undefined' && pywebview.api?.open_url) {
        pywebview.api.open_url(REPO_URL).catch(() => {});
      } else {
        window.open(REPO_URL, '_blank', 'noopener');
      }
    });
  }

  // ── Open / Close ────────────────────────────────────────────
  function openAbout() {
    overlay.classList.add('active');
    _resetUpdateUI();
  }

  function closeAbout() {
    overlay.classList.remove('active');
  }

  btnOpen.addEventListener('click', openAbout);
  if (btnClose) btnClose.addEventListener('click', closeAbout);
  overlay.addEventListener('click', e => {
    if (e.target === overlay) closeAbout();
  });

  // Close on Escape key
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && overlay.classList.contains('active')) closeAbout();
  });

  // ── Update checker ──────────────────────────────────────────
  function _setStatus(msg, cls = '') {
    if (!statusEl) return;
    statusEl.textContent = msg;
    statusEl.className   = 'about-update-status' + (cls ? ` ${cls}` : '');
  }

  function _setProgress(pct, visible = true) {
    if (!progressWrap || !progressBar) return;
    progressWrap.style.display = visible ? '' : 'none';
    progressBar.style.width    = `${Math.min(100, Math.max(0, pct))}%`;
  }

  function _resetUpdateUI() {
    _setStatus('Click CHECK UPDATE to check for the latest release.');
    _setProgress(0, false);
    if (btnCheck) {
      btnCheck.disabled = false;
      btnCheck.classList.remove('spinning');
    }
  }

  /**
   * Parse a semver string like "1.2.3" into a comparable integer.
   * Supports up to 3 numeric segments; non-numeric releases are treated as 0.
   */
  function _semverToInt(ver) {
    if (!ver || typeof ver !== 'string') return 0;
    const parts = ver.replace(/^v/i, '').split('.').slice(0, 3);
    return parts.reduce((acc, p, i) => acc + (parseInt(p, 10) || 0) * Math.pow(1000, 2 - i), 0);
  }

  async function checkForUpdate() {
    if (!btnCheck) return;

    // Disable button and show spinner
    btnCheck.disabled = true;
    btnCheck.classList.add('spinning');
    _setStatus('Checking for updates…');
    _setProgress(30, true);

    try {
      const res = await fetch(`${VERSION_JSON}?_=${Date.now()}`, {
        method:  'GET',
        headers: { 'Accept': 'application/json' },
        // Short timeout — we don't want to hang the UI
        signal:  AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined,
      });

      if (!res.ok) {
        throw new Error(`Server responded with HTTP ${res.status}`);
      }

      _setProgress(70, true);

      const data = await res.json();
      const remoteVersion = (data.version || '').trim();
      const releaseNotes  = (data.notes   || '').trim();
      const downloadUrl   = (data.download || REPO_URL).trim();

      if (!remoteVersion) {
        throw new Error('version.json did not contain a valid version field.');
      }

      _setProgress(100, true);

      const localInt  = _semverToInt(APP_VERSION);
      const remoteInt = _semverToInt(remoteVersion);

      if (remoteInt > localInt) {
        // Update available
        _setStatus(
          `✦ Update available: v${remoteVersion}${releaseNotes ? ' — ' + releaseNotes : ''}. ` +
          `Visit the repository to download.`,
          'update-avail'
        );
        // Offer a direct link if a download URL was provided
        if (downloadUrl && repoLink) {
          repoLink.href = downloadUrl;
        }
      } else if (remoteInt === localInt) {
        _setStatus(`✓ You are running the latest version (v${APP_VERSION}).`, 'up-to-date');
      } else {
        // Local is newer than remote — development/pre-release build
        _setStatus(
          `✓ You are running a pre-release build (v${APP_VERSION} › remote v${remoteVersion}).`,
          'up-to-date'
        );
      }

    } catch (err) {
      const isTimeout = err.name === 'TimeoutError' || err.name === 'AbortError';
      const msg = isTimeout
        ? 'Connection timed out. Check your internet connection and try again.'
        : `Unable to reach update server: ${err.message}`;
      _setStatus(msg, 'error-state');
      console.warn('[About] Update check failed:', err);
    } finally {
      // Re-enable button; leave progress bar visible for 1 s then hide
      btnCheck.disabled = false;
      btnCheck.classList.remove('spinning');
      setTimeout(() => _setProgress(0, false), 1200);
    }
  }

  if (btnCheck) {
    btnCheck.addEventListener('click', checkForUpdate);
  }

})();
