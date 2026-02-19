// assets/converter.js
// Macan Media Player — Converter Panel
//
// UI layer for the converter feature.
// All conversion logic lives in core/converter.py (Python).
// This file handles:
//   - Panel open/close
//   - File list management (add, remove, clear)
//   - Options per mode (audio / video / extract audio)
//   - Progress display per file (pushed from Python via evaluate_js)
//   - Batch queue visualization

'use strict';

// ─── GLOBALS ─────────────────────────────────────────────────────────────────

const CONVERTER_JOB_ID = () => `cvt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

const ConverterState = {
  isOpen:      false,
  mode:        'audio',       // 'audio' | 'video' | 'extract_audio'
  files:       [],            // [{ path, name, status, progress }]
  outputDir:   '',
  activeJobId: null,
  formats:     {},            // populated from Python on first open
};

// ─── PANEL TEMPLATE ──────────────────────────────────────────────────────────

function _buildConverterHTML() {
  return `
<div id="converter-overlay" class="converter-overlay" role="dialog" aria-modal="true" aria-label="Converter">
  <div class="converter-panel">

    <!-- Header -->
    <div class="converter-header">
      <div class="converter-header-left">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/>
          <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
        </svg>
        <span>CONVERTER</span>
      </div>
      <button class="converter-close-btn" id="converter-close" title="Close">✕</button>
    </div>

    <!-- Mode Tabs -->
    <div class="converter-tabs">
      <button class="converter-tab active" data-mode="audio">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>
        </svg>
        Audio
      </button>
      <button class="converter-tab" data-mode="video">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"/>
          <line x1="7" y1="2" x2="7" y2="22"/><line x1="17" y1="2" x2="17" y2="22"/>
          <line x1="2" y1="12" x2="22" y2="12"/>
        </svg>
        Video
      </button>
      <button class="converter-tab" data-mode="extract_audio">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="16 16 12 20 8 16"/><line x1="12" y1="20" x2="12" y2="4"/>
          <path d="M20 12V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h14"/>
        </svg>
        Extract Audio
      </button>
    </div>

    <!-- Body -->
    <div class="converter-body">

      <!-- File List Section -->
      <div class="converter-section">
        <div class="converter-section-header">
          <span class="converter-section-title">INPUT FILES</span>
          <div class="converter-file-actions">
            <button class="converter-btn-sm" id="cvt-add-files">+ Add Files</button>
            <button class="converter-btn-sm cvt-danger" id="cvt-clear-files">Clear</button>
          </div>
        </div>
        <div class="converter-file-list" id="cvt-file-list">
          <div class="converter-file-empty" id="cvt-file-empty">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
            </svg>
            <span>No files added yet.<br>Click <b>+ Add Files</b> to begin.</span>
          </div>
        </div>
      </div>

      <!-- Options Section -->
      <div class="converter-section">
        <div class="converter-section-title">OPTIONS</div>
        <div class="converter-options" id="cvt-options">

          <!-- AUDIO options -->
          <div class="cvt-opts" id="cvt-opts-audio">
            <div class="cvt-opt-row">
              <label>Format</label>
              <select id="cvt-audio-format" class="cvt-select">
                <option value="mp3">MP3</option>
                <option value="wav">WAV</option>
                <option value="aac">AAC</option>
                <option value="flac">FLAC</option>
                <option value="ogg">OGG</option>
                <option value="m4a">M4A</option>
              </select>
            </div>
            <div class="cvt-opt-row">
              <label>Bitrate</label>
              <select id="cvt-audio-bitrate" class="cvt-select">
                <option value="96k">96 kbps</option>
                <option value="128k">128 kbps</option>
                <option value="192k" selected>192 kbps</option>
                <option value="256k">256 kbps</option>
                <option value="320k">320 kbps</option>
              </select>
            </div>
          </div>

          <!-- VIDEO options -->
          <div class="cvt-opts" id="cvt-opts-video" style="display:none">
            <div class="cvt-opt-row">
              <label>Format</label>
              <select id="cvt-video-format" class="cvt-select">
                <option value="mp4">MP4</option>
                <option value="mkv">MKV</option>
                <option value="avi">AVI</option>
                <option value="mov">MOV</option>
                <option value="webm">WEBM</option>
              </select>
            </div>
            <div class="cvt-opt-row">
              <label>Resolution</label>
              <select id="cvt-video-res" class="cvt-select">
                <option value="original" selected>Original</option>
                <option value="360p">360p</option>
                <option value="480p">480p</option>
                <option value="720p">720p</option>
                <option value="1080p">1080p</option>
                <option value="2k">2K</option>
                <option value="4k">4K</option>
              </select>
            </div>
            <div class="cvt-opt-row">
              <label>Quality</label>
              <select id="cvt-video-quality" class="cvt-select">
                <option value="high">High</option>
                <option value="medium" selected>Medium</option>
                <option value="low">Low</option>
              </select>
            </div>
            <!-- Advanced toggle -->
            <div class="cvt-opt-row cvt-advanced-toggle-row">
              <label class="cvt-checkbox-label">
                <input type="checkbox" id="cvt-video-advanced"> Advanced Options
              </label>
              <label class="cvt-checkbox-label">
                <input type="checkbox" id="cvt-video-gpu"> NVIDIA NVENC
              </label>
            </div>
            <!-- Advanced panel -->
            <div class="cvt-advanced-panel" id="cvt-advanced-panel" style="display:none">
              <div class="cvt-opt-row">
                <label>Video Encoder</label>
                <select id="cvt-v-encoder" class="cvt-select">
                  <option value="libx264">libx264 (H.264)</option>
                  <option value="libx265">libx265 (H.265)</option>
                  <option value="copy">Copy (no re-encode)</option>
                </select>
              </div>
              <div class="cvt-opt-row">
                <label>Video Bitrate</label>
                <select id="cvt-v-bitrate" class="cvt-select" style="flex:0.5">
                  <option value="auto" selected>Auto</option>
                  <option value="1000k">1000k</option>
                  <option value="2500k">2500k</option>
                  <option value="5000k">5000k</option>
                  <option value="8000k">8000k</option>
                </select>
                <label style="margin-left:12px">FPS</label>
                <select id="cvt-v-fps" class="cvt-select" style="flex:0.5">
                  <option value="original" selected>Original</option>
                  <option value="24">24</option>
                  <option value="30">30</option>
                  <option value="60">60</option>
                </select>
              </div>
              <div class="cvt-opt-row">
                <label>Audio Encoder</label>
                <select id="cvt-a-encoder" class="cvt-select">
                  <option value="aac" selected>AAC</option>
                  <option value="libmp3lame">MP3</option>
                  <option value="ac3">AC3</option>
                  <option value="copy">Copy</option>
                </select>
              </div>
              <div class="cvt-opt-row">
                <label>Audio Bitrate</label>
                <select id="cvt-a-bitrate" class="cvt-select">
                  <option value="original" selected>Original</option>
                  <option value="128k">128k</option>
                  <option value="192k">192k</option>
                  <option value="256k">256k</option>
                  <option value="320k">320k</option>
                </select>
              </div>
              <div class="cvt-opt-row">
                <label>Channels</label>
                <select id="cvt-a-channels" class="cvt-select">
                  <option value="original" selected>Original</option>
                  <option value="1">Mono</option>
                  <option value="2">Stereo</option>
                </select>
                <label style="margin-left:12px">Sample Rate</label>
                <select id="cvt-a-samplerate" class="cvt-select">
                  <option value="original" selected>Original</option>
                  <option value="44100">44100 Hz</option>
                  <option value="48000">48000 Hz</option>
                </select>
              </div>
              <div class="cvt-opt-row">
                <label>Custom Flags</label>
                <input type="text" id="cvt-custom-flags" class="cvt-input"
                       placeholder="-profile:v high -level 4.1">
              </div>
            </div>
          </div>

          <!-- EXTRACT AUDIO options -->
          <div class="cvt-opts" id="cvt-opts-extract" style="display:none">
            <div class="cvt-opt-row">
              <label>Output Format</label>
              <select id="cvt-extract-format" class="cvt-select">
                <option value="mp3" selected>MP3</option>
                <option value="wav">WAV</option>
                <option value="aac">AAC</option>
                <option value="flac">FLAC</option>
                <option value="m4a">M4A</option>
              </select>
            </div>
            <div class="cvt-opt-row">
              <label>Bitrate</label>
              <select id="cvt-extract-bitrate" class="cvt-select">
                <option value="128k">128 kbps</option>
                <option value="192k" selected>192 kbps</option>
                <option value="256k">256 kbps</option>
                <option value="320k">320 kbps</option>
              </select>
            </div>
          </div>

        </div>
      </div>

      <!-- Output folder -->
      <div class="converter-section">
        <div class="converter-section-title">OUTPUT FOLDER</div>
        <div class="cvt-folder-row">
          <span class="cvt-folder-path" id="cvt-output-path">Not selected</span>
          <button class="converter-btn-sm" id="cvt-browse-output">Browse…</button>
        </div>
      </div>

    </div>

    <!-- Footer -->
    <div class="converter-footer">
      <div class="cvt-overall-progress" id="cvt-overall-progress" style="display:none">
        <div class="cvt-overall-label" id="cvt-overall-label">Converting 1 of 3…</div>
        <div class="cvt-progress-track">
          <div class="cvt-progress-fill" id="cvt-progress-fill" style="width:0%"></div>
        </div>
        <div class="cvt-progress-pct" id="cvt-progress-pct">0%</div>
      </div>
      <div class="converter-footer-actions">
        <button class="cvt-btn-cancel" id="cvt-cancel-btn" style="display:none">
          ⏹ Cancel
        </button>
        <button class="cvt-btn-open-folder" id="cvt-open-folder-btn" style="display:none">
          📂 Open Folder
        </button>
        <button class="cvt-btn-start" id="cvt-start-btn">
          ▶ START CONVERSION
        </button>
      </div>
    </div>

  </div>
</div>`;
}

// ─── INJECT CSS ───────────────────────────────────────────────────────────────

function _injectConverterCSS() {
  if (document.getElementById('converter-css')) return;
  const style = document.createElement('style');
  style.id = 'converter-css';
  style.textContent = `
/* ── Converter Overlay ──────────────────────────────────────────────────── */
.converter-overlay {
  position: fixed;
  inset: 0;
  z-index: 9100;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0,0,0,0.72);
  backdrop-filter: blur(6px);
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.22s ease;
}
.converter-overlay.cv-open {
  opacity: 1;
  pointer-events: all;
}

/* ── Panel ───────────────────────────────────────────────────────────────── */
.converter-panel {
  width: min(820px, 96vw);
  max-height: 88vh;
  display: flex;
  flex-direction: column;
  background: #161616;
  border: 1px solid #2e2e2e;
  border-radius: 10px;
  overflow: hidden;
  box-shadow: 0 24px 64px rgba(0,0,0,0.7);
  transform: translateY(18px) scale(0.97);
  transition: transform 0.22s ease;
}
.converter-overlay.cv-open .converter-panel {
  transform: translateY(0) scale(1);
}

/* ── Header ──────────────────────────────────────────────────────────────── */
.converter-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px;
  background: #1e1e1e;
  border-bottom: 1px solid #2a2a2a;
  flex-shrink: 0;
}
.converter-header-left {
  display: flex;
  align-items: center;
  gap: 9px;
  color: #c8ff00;
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  letter-spacing: 2px;
  font-weight: 600;
}
.converter-close-btn {
  background: none;
  border: none;
  color: #666;
  font-size: 15px;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 4px;
  transition: color 0.15s, background 0.15s;
}
.converter-close-btn:hover { color: #fff; background: #2e2e2e; }

/* ── Tabs ────────────────────────────────────────────────────────────────── */
.converter-tabs {
  display: flex;
  background: #1a1a1a;
  border-bottom: 1px solid #2a2a2a;
  flex-shrink: 0;
}
.converter-tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 18px;
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  color: #666;
  font-size: 11px;
  font-family: var(--font-mono, monospace);
  letter-spacing: 1px;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s;
}
.converter-tab:hover { color: #aaa; }
.converter-tab.active { color: #c8ff00; border-bottom-color: #c8ff00; }

/* ── Body ────────────────────────────────────────────────────────────────── */
.converter-body {
  flex: 1;
  overflow-y: auto;
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.converter-body::-webkit-scrollbar { width: 5px; }
.converter-body::-webkit-scrollbar-track { background: transparent; }
.converter-body::-webkit-scrollbar-thumb { background: #333; border-radius: 3px; }

/* ── Section ─────────────────────────────────────────────────────────────── */
.converter-section {
  background: #1c1c1c;
  border: 1px solid #272727;
  border-radius: 7px;
  padding: 12px 14px;
}
.converter-section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}
.converter-section-title {
  font-family: var(--font-mono, monospace);
  font-size: 9px;
  letter-spacing: 2px;
  color: #555;
  margin-bottom: 10px;
  display: block;
}
.converter-section-header .converter-section-title { margin-bottom: 0; }

/* ── File actions ────────────────────────────────────────────────────────── */
.converter-file-actions { display: flex; gap: 6px; }
.converter-btn-sm {
  padding: 4px 10px;
  font-size: 11px;
  font-family: var(--font-mono, monospace);
  background: #2a2a2a;
  border: 1px solid #383838;
  border-radius: 4px;
  color: #ccc;
  cursor: pointer;
  transition: background 0.15s;
}
.converter-btn-sm:hover { background: #333; color: #fff; }
.converter-btn-sm.cvt-danger:hover { background: #3a1a1a; color: #ff6b6b; border-color: #5a2a2a; }

/* ── File List ───────────────────────────────────────────────────────────── */
.converter-file-list {
  min-height: 100px;
  max-height: 200px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.converter-file-list::-webkit-scrollbar { width: 4px; }
.converter-file-list::-webkit-scrollbar-thumb { background: #333; border-radius: 3px; }
.converter-file-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 20px;
  color: #444;
  font-size: 11px;
  text-align: center;
  height: 100px;
}
.converter-file-empty svg { opacity: 0.4; }

/* ── File Item ───────────────────────────────────────────────────────────── */
.cvt-file-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  background: #212121;
  border: 1px solid #2d2d2d;
  border-radius: 5px;
  transition: border-color 0.15s;
}
.cvt-file-item.cvt-done   { border-color: #2a4a2a; }
.cvt-file-item.cvt-error  { border-color: #4a2a2a; }
.cvt-file-item.cvt-active { border-color: #3a4a1a; }

.cvt-file-icon { color: #555; flex-shrink: 0; }
.cvt-file-name {
  flex: 1;
  font-size: 11px;
  color: #ccc;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cvt-file-status {
  font-size: 10px;
  font-family: var(--font-mono, monospace);
  color: #555;
  flex-shrink: 0;
}
.cvt-file-item.cvt-done  .cvt-file-status { color: #7ec87e; }
.cvt-file-item.cvt-error .cvt-file-status { color: #e07070; }
.cvt-file-item.cvt-active .cvt-file-status { color: #c8ff00; }
.cvt-file-mini-bar {
  width: 60px;
  height: 3px;
  background: #2a2a2a;
  border-radius: 2px;
  flex-shrink: 0;
  overflow: hidden;
}
.cvt-file-mini-fill {
  height: 100%;
  background: #c8ff00;
  border-radius: 2px;
  transition: width 0.3s;
}
.cvt-file-remove {
  background: none;
  border: none;
  color: #444;
  cursor: pointer;
  padding: 2px 4px;
  font-size: 13px;
  flex-shrink: 0;
  transition: color 0.15s;
}
.cvt-file-remove:hover { color: #e07070; }

/* ── Options ─────────────────────────────────────────────────────────────── */
.converter-options { display: flex; flex-direction: column; }
.cvt-opt-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.cvt-opt-row label {
  font-size: 11px;
  color: #888;
  width: 110px;
  flex-shrink: 0;
  font-family: var(--font-mono, monospace);
  letter-spacing: 0.5px;
}
.cvt-select {
  flex: 1;
  padding: 5px 8px;
  background: #212121;
  border: 1px solid #333;
  border-radius: 4px;
  color: #ddd;
  font-size: 11px;
}
.cvt-select:focus { outline: none; border-color: #c8ff00; }
.cvt-input {
  flex: 1;
  padding: 5px 8px;
  background: #212121;
  border: 1px solid #333;
  border-radius: 4px;
  color: #ddd;
  font-size: 11px;
}
.cvt-input:focus { outline: none; border-color: #c8ff00; }
.cvt-checkbox-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: #aaa;
  cursor: pointer;
  width: auto;
}
.cvt-checkbox-label input[type=checkbox] { cursor: pointer; accent-color: #c8ff00; }
.cvt-advanced-toggle-row { margin-top: 2px; margin-bottom: 10px; gap: 20px; }
.cvt-advanced-panel {
  border-top: 1px solid #2a2a2a;
  padding-top: 10px;
  margin-top: 4px;
}

/* ── Folder row ──────────────────────────────────────────────────────────── */
.cvt-folder-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.cvt-folder-path {
  flex: 1;
  font-size: 11px;
  color: #666;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-family: var(--font-mono, monospace);
}
.cvt-folder-path.selected { color: #aaa; }

/* ── Footer ──────────────────────────────────────────────────────────────── */
.converter-footer {
  border-top: 1px solid #2a2a2a;
  padding: 14px 18px;
  background: #1a1a1a;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.cvt-overall-progress { display: flex; align-items: center; gap: 10px; }
.cvt-overall-label {
  font-size: 10px;
  font-family: var(--font-mono, monospace);
  color: #777;
  white-space: nowrap;
  min-width: 130px;
}
.cvt-progress-track {
  flex: 1;
  height: 4px;
  background: #2a2a2a;
  border-radius: 2px;
  overflow: hidden;
}
.cvt-progress-fill {
  height: 100%;
  background: #c8ff00;
  border-radius: 2px;
  transition: width 0.35s ease;
}
.cvt-progress-pct {
  font-size: 10px;
  font-family: var(--font-mono, monospace);
  color: #c8ff00;
  min-width: 32px;
  text-align: right;
}
.converter-footer-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.cvt-btn-start {
  padding: 9px 22px;
  background: #c8ff00;
  border: none;
  border-radius: 5px;
  color: #111;
  font-size: 11px;
  font-family: var(--font-mono, monospace);
  letter-spacing: 1.5px;
  font-weight: 700;
  cursor: pointer;
  transition: background 0.15s, transform 0.1s;
}
.cvt-btn-start:hover { background: #d8ff3a; }
.cvt-btn-start:active { transform: scale(0.97); }
.cvt-btn-start:disabled { background: #2a2a2a; color: #555; cursor: not-allowed; }
.cvt-btn-cancel {
  padding: 9px 18px;
  background: #2a1a1a;
  border: 1px solid #5a2a2a;
  border-radius: 5px;
  color: #e07070;
  font-size: 11px;
  font-family: var(--font-mono, monospace);
  letter-spacing: 1px;
  cursor: pointer;
  transition: background 0.15s;
}
.cvt-btn-cancel:hover { background: #3a1a1a; }
.cvt-btn-open-folder {
  padding: 9px 18px;
  background: #1e2a1e;
  border: 1px solid #2a4a2a;
  border-radius: 5px;
  color: #7ec87e;
  font-size: 11px;
  font-family: var(--font-mono, monospace);
  letter-spacing: 1px;
  cursor: pointer;
  transition: background 0.15s;
}
.cvt-btn-open-folder:hover { background: #253225; }
`;
  document.head.appendChild(style);
}

// ─── DOM HELPERS ──────────────────────────────────────────────────────────────

function _cvtEl(id) { return document.getElementById(id); }

function _renderFileList() {
  const list  = _cvtEl('cvt-file-list');
  const empty = _cvtEl('cvt-file-empty');

  // Guard: overlay belum di-inject ke DOM, skip
  if (!list || !empty) return;

  // Remove all items (keep empty placeholder)
  Array.from(list.querySelectorAll('.cvt-file-item')).forEach(el => el.remove());

  if (ConverterState.files.length === 0) {
    empty.style.display = 'flex';
    return;
  }
  empty.style.display = 'none';

  ConverterState.files.forEach((f, idx) => {
    const item = document.createElement('div');
    item.className = `cvt-file-item ${f.cssClass || ''}`;
    item.dataset.idx = idx;
    item.innerHTML = `
      <span class="cvt-file-icon">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/>
          <polyline points="13 2 13 9 20 9"/>
        </svg>
      </span>
      <span class="cvt-file-name" title="${f.path}">${f.name}</span>
      <div class="cvt-file-mini-bar">
        <div class="cvt-file-mini-fill" style="width:${f.progress || 0}%"></div>
      </div>
      <span class="cvt-file-status">${f.status || 'READY'}</span>
      <button class="cvt-file-remove" data-idx="${idx}" title="Remove">✕</button>
    `;
    list.appendChild(item);
  });

  // Remove buttons
  list.querySelectorAll('.cvt-file-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      const i = parseInt(btn.dataset.idx, 10);
      ConverterState.files.splice(i, 1);
      _renderFileList();
    });
  });
}

function _updateProgress(index, total, percent, status) {
  // Update overall bar
  const overallPct = Math.round(((index + percent / 100) / total) * 100);
  _cvtEl('cvt-progress-fill').style.width = overallPct + '%';
  _cvtEl('cvt-progress-pct').textContent   = overallPct + '%';
  _cvtEl('cvt-overall-label').textContent  = `Converting ${index + 1} of ${total}… ${status}`;

  // Update individual file row
  const f = ConverterState.files[index];
  if (f) {
    f.progress = percent;
    f.status   = percent + '%';
    f.cssClass = 'cvt-active';
    _renderFileList();
  }
}

function _setConverting(on) {
  _cvtEl('cvt-start-btn').disabled      = on;
  _cvtEl('cvt-cancel-btn').style.display     = on ? 'block' : 'none';
  _cvtEl('cvt-overall-progress').style.display = on ? 'flex' : 'none';
  if (on) _cvtEl('cvt-open-folder-btn').style.display = 'none';
}

// ─── MODE SWITCHING ───────────────────────────────────────────────────────────

function _switchMode(mode) {
  ConverterState.mode = mode;

  document.querySelectorAll('.converter-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.mode === mode);
  });

  document.querySelectorAll('.cvt-opts').forEach(el => { el.style.display = 'none'; });
  const map = { audio: 'cvt-opts-audio', video: 'cvt-opts-video', extract_audio: 'cvt-opts-extract' };
  const panel = _cvtEl(map[mode]);
  if (panel) panel.style.display = '';

  // Clear file list when switching mode
  ConverterState.files = [];
  _renderFileList();
}

// ─── ADD FILES ────────────────────────────────────────────────────────────────

async function _addFiles() {
  if (!window.pywebview) return;
  const modeMap = {
    audio:         'audio',
    video:         'video',
    extract_audio: 'video',
  };
  const result = await pywebview.api.converter_browse_files(modeMap[ConverterState.mode]);
  if (!result || !result.length) return;

  result.forEach(path => {
    const name = path.split(/[\\/]/).pop();
    // Avoid duplicates
    if (!ConverterState.files.find(f => f.path === path)) {
      ConverterState.files.push({ path, name, status: 'READY', progress: 0, cssClass: '' });
    }
  });
  _renderFileList();
}

// ─── GATHER OPTIONS ───────────────────────────────────────────────────────────

function _gatherOptions() {
  const mode = ConverterState.mode;
  if (mode === 'audio') {
    return {
      out_format: _cvtEl('cvt-audio-format').value,
      bitrate:    _cvtEl('cvt-audio-bitrate').value,
    };
  }
  if (mode === 'extract_audio') {
    return {
      out_format: _cvtEl('cvt-extract-format').value,
      bitrate:    _cvtEl('cvt-extract-bitrate').value,
    };
  }
  // video
  const adv = _cvtEl('cvt-video-advanced').checked;
  const base = {
    out_format:  _cvtEl('cvt-video-format').value,
    resolution:  _cvtEl('cvt-video-res').value,
    quality:     _cvtEl('cvt-video-quality').value,
    use_gpu:     _cvtEl('cvt-video-gpu').checked,
    advanced:    adv,
  };
  if (adv) {
    Object.assign(base, {
      v_encoder:    _cvtEl('cvt-v-encoder').value,
      v_bitrate:    _cvtEl('cvt-v-bitrate').value,
      fps:          _cvtEl('cvt-v-fps').value,
      a_encoder:    _cvtEl('cvt-a-encoder').value,
      a_bitrate:    _cvtEl('cvt-a-bitrate').value,
      a_channels:   _cvtEl('cvt-a-channels').value,
      a_samplerate: _cvtEl('cvt-a-samplerate').value,
      custom_flags: _cvtEl('cvt-custom-flags').value,
    });
  }
  return base;
}

// ─── START CONVERSION ─────────────────────────────────────────────────────────

async function _startConversion() {
  if (!window.pywebview) return;

  const files = ConverterState.files.map(f => f.path);
  if (!files.length) {
    alert('Please add at least one file before converting.');
    return;
  }
  if (!ConverterState.outputDir) {
    alert('Please select an output folder.');
    return;
  }

  // Reset statuses
  ConverterState.files.forEach(f => { f.status = 'QUEUED'; f.progress = 0; f.cssClass = ''; });
  _renderFileList();

  const jobId  = CONVERTER_JOB_ID();
  const options = _gatherOptions();
  ConverterState.activeJobId = jobId;

  _setConverting(true);
  _cvtEl('cvt-progress-fill').style.width = '0%';
  _cvtEl('cvt-progress-pct').textContent   = '0%';

  const result = await pywebview.api.converter_start(
    jobId, files, ConverterState.outputDir, ConverterState.mode, options
  );

  if (!result.ok) {
    _setConverting(false);
    alert(`Conversion error: ${result.error}`);
  }
}

// ─── CANCEL ───────────────────────────────────────────────────────────────────

async function _cancelConversion() {
  if (!ConverterState.activeJobId) return;
  await pywebview.api.converter_cancel(ConverterState.activeJobId);
  ConverterState.activeJobId = null;
  _setConverting(false);
  // Mark remaining queued items as cancelled
  ConverterState.files.forEach(f => {
    if (f.status === 'QUEUED' || f.cssClass === 'cvt-active') {
      f.status   = 'CANCELLED';
      f.cssClass = 'cvt-error';
    }
  });
  _renderFileList();
}

// ─── PYTHON → JS CALLBACKS ────────────────────────────────────────────────────
// These are called by Python via window.evaluate_js().

window.converterItemStart = function(jobId, index, total, filename) {
  if (jobId !== ConverterState.activeJobId) return;
  _cvtEl('cvt-overall-label').textContent = `Converting ${index + 1} of ${total}: ${filename}`;
  const f = ConverterState.files[index];
  if (f) { f.cssClass = 'cvt-active'; f.status = 'CONVERTING'; _renderFileList(); }
};

window.converterProgress = function(jobId, index, total, percent, status) {
  if (jobId !== ConverterState.activeJobId) return;
  _updateProgress(index, total, percent, status);
};

window.converterItemDone = function(jobId, index, total, success, filename, message) {
  if (jobId !== ConverterState.activeJobId) return;
  const f = ConverterState.files[index];
  if (f) {
    f.progress = success ? 100 : 0;
    f.status   = success ? '✓ DONE' : '✗ ERROR';
    f.cssClass = success ? 'cvt-done' : 'cvt-error';
    _renderFileList();
  }
};

window.converterDone = function(jobId, okCount, failCount) {
  if (jobId !== ConverterState.activeJobId) return;
  ConverterState.activeJobId = null;
  _setConverting(false);

  _cvtEl('cvt-progress-fill').style.width = '100%';
  _cvtEl('cvt-progress-pct').textContent   = '100%';
  _cvtEl('cvt-overall-label').textContent  =
    failCount > 0
      ? `Done — ${okCount} converted, ${failCount} failed.`
      : `All ${okCount} file(s) converted successfully!`;

  if (ConverterState.outputDir) {
    _cvtEl('cvt-open-folder-btn').style.display = 'block';
  }
};

// ─── PANEL OPEN / CLOSE ───────────────────────────────────────────────────────

function openConverter() {
  const overlay = _cvtEl('converter-overlay');
  if (!overlay) return;
  ConverterState.isOpen = true;
  overlay.classList.add('cv-open');
}

function closeConverter() {
  const overlay = _cvtEl('converter-overlay');
  if (!overlay) return;
  ConverterState.isOpen = false;
  overlay.classList.remove('cv-open');
}

// ─── INIT ─────────────────────────────────────────────────────────────────────

function initConverter() {
  _injectConverterCSS();

  // Inject panel HTML once
  if (!_cvtEl('converter-overlay')) {
    document.body.insertAdjacentHTML('beforeend', _buildConverterHTML());
  }

  // ── Tab switching ────────────────────────────────────────────────────────
  document.querySelectorAll('.converter-tab').forEach(tab => {
    tab.addEventListener('click', () => _switchMode(tab.dataset.mode));
  });

  // ── Close ────────────────────────────────────────────────────────────────
  _cvtEl('converter-close').addEventListener('click', closeConverter);
  _cvtEl('converter-overlay').addEventListener('click', e => {
    if (e.target === _cvtEl('converter-overlay')) closeConverter();
  });

  // ── File management ──────────────────────────────────────────────────────
  _cvtEl('cvt-add-files').addEventListener('click', _addFiles);
  _cvtEl('cvt-clear-files').addEventListener('click', () => {
    ConverterState.files = [];
    _renderFileList();
  });

  // ── Output folder ────────────────────────────────────────────────────────
  _cvtEl('cvt-browse-output').addEventListener('click', async () => {
    const folder = await pywebview.api.converter_browse_output_folder();
    if (folder) {
      ConverterState.outputDir = folder;
      const el = _cvtEl('cvt-output-path');
      el.textContent = folder;
      el.classList.add('selected');
    }
  });

  // ── Advanced video options ───────────────────────────────────────────────
  _cvtEl('cvt-video-advanced').addEventListener('change', e => {
    _cvtEl('cvt-advanced-panel').style.display = e.target.checked ? '' : 'none';
  });

  // ── Start / Cancel / Open folder ─────────────────────────────────────────
  _cvtEl('cvt-start-btn').addEventListener('click', _startConversion);
  _cvtEl('cvt-cancel-btn').addEventListener('click', _cancelConversion);
  _cvtEl('cvt-open-folder-btn').addEventListener('click', async () => {
    if (ConverterState.outputDir) {
      await pywebview.api.converter_open_folder(ConverterState.outputDir);
    }
  });

  // ── Block keyboard shortcuts while converter input is focused ────────────
  _cvtEl('converter-overlay').addEventListener('keydown', e => e.stopPropagation());
  _cvtEl('converter-overlay').addEventListener('keyup',   e => e.stopPropagation());
  _cvtEl('converter-overlay').addEventListener('keypress',e => e.stopPropagation());

  // ── Initial render ───────────────────────────────────────────────────────
  _renderFileList();
  _switchMode('audio');
}

// Auto-init when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initConverter);
} else {
  initConverter();
}