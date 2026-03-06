// ═══════════════════════════════════════════════════════════════
// MACAN MEDIA PLAYER — MACAN JOKES 🐯
// Easter egg module. Injects an "UNLOCK ALL" button into the
// Achievements panel and handles the multi-click joke sequence.
// ═══════════════════════════════════════════════════════════════

const MacanJokes = (() => {

  let _clickCount   = 0;
  let _jokeActive   = false;
  let _dialogEl     = null;
  let _progressEl   = null;

  // ── Dialog helpers ──────────────────────────────────────────
  function _removeDialog() {
    if (_dialogEl) { _dialogEl.remove(); _dialogEl = null; }
    if (_progressEl) { _progressEl.remove(); _progressEl = null; }
  }

  function _showDialog(html, buttons, opts = {}) {
    _removeDialog();
    const el = document.createElement('div');
    el.className = 'jk-backdrop';
    el.innerHTML = `
      <div class="jk-dialog ${opts.wide ? 'jk-dialog-wide' : ''}">
        <div class="jk-body">${html}</div>
        <div class="jk-btn-row">
          ${buttons.map(b =>
            `<button class="jk-btn ${b.accent ? 'jk-btn-accent' : ''}" data-key="${b.key}">${b.label}</button>`
          ).join('')}
        </div>
      </div>`;
    document.body.appendChild(el);
    _dialogEl = el;

    buttons.forEach(b => {
      el.querySelector(`[data-key="${b.key}"]`)?.addEventListener('click', () => {
        _removeDialog();
        if (b.action) b.action();
      });
    });

    // Animate in
    requestAnimationFrame(() => el.classList.add('jk-visible'));
    return el;
  }

  function _showProgressDialog(onDone) {
    _removeDialog();
    const el = document.createElement('div');
    el.className = 'jk-backdrop jk-visible';
    el.innerHTML = `
      <div class="jk-dialog jk-dialog-progress">
        <div class="jk-progress-title">⚙️ Unlocking all achievements...</div>
        <div class="jk-progress-track">
          <div class="jk-progress-bar" id="jk-bar"></div>
        </div>
        <div class="jk-progress-label" id="jk-pct">0%</div>
        <div class="jk-progress-msg" id="jk-msg">Initializing cheat engine... 🔧</div>
      </div>`;
    document.body.appendChild(el);
    _progressEl = el;

    const MESSAGES = [
      { at:  5,  msg: "Bypassing integrity checks... 🕵️" },
      { at: 15,  msg: "Injecting fake play history... 🎵" },
      { at: 28,  msg: "Forging 1000 listens... 👀" },
      { at: 40,  msg: "Bribing the achievement server... 💸" },
      { at: 55,  msg: "Photoshopping platinum badges... 🏆" },
      { at: 68,  msg: "Generating fake stats... 📊" },
      { at: 78,  msg: "Almost there... don't close! 🙏" },
      { at: 90,  msg: "Finalizing world domination... 😈" },
      { at: 98,  msg: "Just a moment... ⏳" },
    ];

    let pct     = 0;
    const bar   = el.querySelector('#jk-bar');
    const label = el.querySelector('#jk-pct');
    const msg   = el.querySelector('#jk-msg');

    // Random speed — starts fast, slows near 100
    function tick() {
      if (pct >= 100) {
        bar.style.width   = '100%';
        label.textContent = '100%';
        msg.textContent   = 'Done! ✅';
        setTimeout(() => {
          _removeDialog();
          onDone && onDone();
        }, 700);
        return;
      }
      const step = pct < 60 ? (Math.random() * 4 + 1) : (Math.random() * 1.2 + 0.2);
      pct = Math.min(100, pct + step);

      bar.style.width   = pct.toFixed(1) + '%';
      label.textContent = Math.floor(pct) + '%';

      const found = MESSAGES.filter(m => m.at <= pct && m.at > pct - step);
      if (found.length) msg.textContent = found[found.length - 1].msg;

      setTimeout(tick, 80 + Math.random() * 60);
    }
    tick();
  }

  // ── The joke sequence ───────────────────────────────────────
  function _handleClick() {
    if (_jokeActive) return;
    _clickCount++;

    if (_clickCount === 1) {
      // First click
      _jokeActive = true;
      _showDialog(
        `<div class="jk-emoji">😤</div>
         <div class="jk-title">Are you kidding me?</div>
         <div class="jk-desc">You really think it's that easy to unlock all achievements? <br>Each one means something. Come on.</div>`,
        [{ key: 'ok', label: 'Okay fine 😅', action: () => { _jokeActive = false; } }]
      );

    } else if (_clickCount === 2) {
      // Second click
      _jokeActive = true;
      _showDialog(
        `<div class="jk-emoji">🤨</div>
         <div class="jk-title">...Seriously?</div>
         <div class="jk-desc">You clicked it again. You <em>actually</em> clicked it again.<br>
         Bold move. I'm watching you. 👁️</div>`,
        [
          { key: 'yes', label: "I'm serious 😤", action: () => { _jokeActive = false; } },
          { key: 'no',  label: "My bad 🙈",       action: () => { _clickCount = 0; _jokeActive = false; } },
        ]
      );

    } else if (_clickCount >= 3) {
      // Third click — run the fake progress
      _clickCount = 0;
      _jokeActive = true;
      _showDialog(
        `<div class="jk-emoji">🤝</div>
         <div class="jk-title">Ah okay, wait a minute...</div>
         <div class="jk-desc">Fine. You want all achievements? Let's do this. <br>
         Starting the unlock sequence... don't close the app! 🚀</div>`,
        [{ key: 'go', label: "Let's GO! 🔥", accent: true, action: () => {
          _showProgressDialog(() => {
            // Final reveal
            _showDialog(
              `<div class="jk-emoji">😂</div>
               <div class="jk-title">Unfortunately...</div>
               <div class="jk-desc">
                 <strong>You have to earn everything the honest way.</strong> 🏆<br><br>
                 No shortcuts here. Open the app, load your favorite tracks,<br>
                 and <em>actually listen to them.</em> 🎧<br><br>
                 The achievements will come. Promise. 🐯
               </div>`,
              [
                {
                  key: 'ok', label: '😤 Fine, I\'ll do it properly',
                  accent: true,
                  action: () => { _jokeActive = false; }
                },
                {
                  key: 'play', label: '🎵 Play something now',
                  action: () => {
                    _jokeActive = false;
                    // Close achievements panel and start playing
                    document.getElementById('ach-close')?.click();
                    document.getElementById('btn-play')?.click();
                  }
                }
              ],
              { wide: true }
            );
          });
        }}]
      );
    }
  }

  // ── Inject the button into the achievements panel ───────────
  function _inject() {
    const panel = document.querySelector('.ach-panel');
    if (!panel || document.getElementById('jk-unlock-all-btn')) return;

    const btn = document.createElement('div');
    btn.className = 'jk-unlock-section';
    btn.innerHTML = `
      <button id="jk-unlock-all-btn" class="jk-unlock-btn" title="Unlock all achievements instantly... or can you? 😏">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
          <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
        </svg>
        UNLOCK ALL
      </button>`;

    // Insert above the footer
    const footer = panel.querySelector('.ach-footer');
    if (footer) {
      panel.insertBefore(btn, footer);
    } else {
      panel.appendChild(btn);
    }

    btn.querySelector('#jk-unlock-all-btn').addEventListener('click', _handleClick);
  }

  // ── Watch for achievements panel to open ────────────────────
  // Use MutationObserver since achievements is a dynamic overlay
  const _observer = new MutationObserver(() => {
    const overlay = document.getElementById('achievements-overlay');
    if (overlay && overlay.classList.contains('active')) {
      // Small delay so ach-grid is rendered first
      setTimeout(_inject, 120);
    }
  });

  const _achOverlay = document.getElementById('achievements-overlay');
  if (_achOverlay) {
    _observer.observe(_achOverlay, { attributes: true, attributeFilter: ['class'] });
  }

  // Also try injecting immediately in case panel is pre-rendered
  document.addEventListener('DOMContentLoaded', () => setTimeout(_inject, 200));

  return { inject: _inject };
})();

window.MacanJokes = MacanJokes;
