// ═══════════════════════════════════════════════════════════════
// MACAN MEDIA PLAYER — 10-BAND EQUALIZER MODULE
// ═══════════════════════════════════════════════════════════════

class Equalizer10Band {
  constructor(audioContext) {
    this.audioContext = audioContext;
    this.bands = [];
    this.input = audioContext.createGain();
    this.output = audioContext.createGain();
    
    // 10-Band Frequencies (Hz)
    this.frequencies = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
    this.bandNames = ["31Hz", "62Hz", "125Hz", "250Hz", "500Hz", "1kHz", "2kHz", "4kHz", "8kHz", "16kHz"];
    
    // Preset configurations
    this.presets = {
      "Flat":        [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      "Acoustic":    [4, 4, 3, 1, 2, 2, 3, 4, 3, 2],
      "Bass Boost":  [9, 7, 5, 2, 0, 0, 0, 0, 0, 0],
      "Bass Cut":    [-4, -3, -1, 0, 0, 0, 0, 0, 1, 2],
      "Classical":   [5, 4, 3, 2, -1, -1, 0, 2, 3, 4],
      "Dance":       [4, 6, 2, 0, 0, -2, -2, -2, 4, 4],
      "Electronic":  [5, 4, 1, 0, -2, 2, 1, 2, 5, 6],
      "Hip-Hop":     [6, 5, 1, 2, -1, -1, 1, -2, 2, 3],
      "Jazz":        [4, 3, 1, 2, -2, -2, 0, 2, 4, 5],
      "Metal":       [5, 4, 4, 2, 0, -2, 2, 4, 5, 6],
      "Pop":         [-2, -1, 2, 4, 5, 4, 2, 0, -1, -1],
      "R&B":         [3, 7, 5, 1, -2, -1, 2, 3, 3, 4],
      "Rock":        [5, 4, 3, 1, -1, -1, 1, 3, 4, 5],
      "Small Speakers": [6, 5, 4, 3, 2, 0, -2, -3, -4, -5],
      "Spoken Word": [-2, -1, 0, 1, 5, 5, 4, 2, 0, -3],
      "Treble Boost": [0, 0, 0, 0, 0, 1, 3, 5, 7, 9],
      "Vocal":       [-2, -3, -2, 1, 4, 5, 4, 2, 0, -1]
    };
    
    this.loadCustomPreset();
    this.createFilters();
  }
  
  createFilters() {
    let prevNode = this.input;
    
    this.frequencies.forEach((freq, index) => {
      const filter = this.audioContext.createBiquadFilter();
      
      if (index === 0) {
        filter.type = 'lowshelf';
      } else if (index === this.frequencies.length - 1) {
        filter.type = 'highshelf';
      } else {
        filter.type = 'peaking';
        filter.Q.value = 1.0;
      }
      
      filter.frequency.value = freq;
      filter.gain.value = 0;
      
      prevNode.connect(filter);
      prevNode = filter;
      
      this.bands.push(filter);
    });
    
    prevNode.connect(this.output);
  }
  
  connect(destination) {
    this.output.connect(destination);
  }
  
  setBandGain(index, gainDB) {
    if (index >= 0 && index < this.bands.length) {
      this.bands[index].gain.value = gainDB;
    }
  }
  
  getBandGain(index) {
    if (index >= 0 && index < this.bands.length) {
      return this.bands[index].gain.value;
    }
    return 0;
  }
  
  applyPreset(presetName) {
    const values = this.presets[presetName];
    if (values) {
      values.forEach((gain, index) => {
        this.setBandGain(index, gain);
      });
      return values;
    }
    return null;
  }
  
  getCurrentValues() {
    return this.bands.map(filter => filter.gain.value);
  }
  
  setAllBands(values) {
    if (values && values.length === this.bands.length) {
      values.forEach((gain, index) => {
        this.setBandGain(index, gain);
      });
    }
  }
  
  reset() {
    this.applyPreset("Flat");
  }
  
  saveCustomPreset(values) {
    this.presets["Custom"] = values;
    localStorage.setItem('macan_eq_custom', JSON.stringify(values));
  }
  
  loadCustomPreset() {
    const saved = localStorage.getItem('macan_eq_custom');
    if (saved) {
      try {
        this.presets["Custom"] = JSON.parse(saved);
      } catch (e) {
        this.presets["Custom"] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
      }
    } else {
      this.presets["Custom"] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    }
  }
}

class EqualizerUI {
  constructor(equalizer) {
    this.eq = equalizer;
    this.isOpen = false;
    this.container = null;
    this.sliders = [];
    this.valueLabels = [];
    this.currentPreset = "Flat";
    
    this.createUI();
  }
  
  createUI() {
    this.container = document.createElement('div');
    this.container.id = 'eq-overlay';
    this.container.className = 'eq-overlay';
    this.container.innerHTML = `
      <div class="eq-panel">
        <div class="eq-header">
          <h2>10-BAND EQUALIZER</h2>
          <button class="eq-close-btn" id="eq-close">✕</button>
        </div>
        
        <div class="eq-preset-row">
          <label>PRESET:</label>
          <select id="eq-preset-select" class="eq-select">
            <option value="Custom">Custom</option>
            ${Object.keys(this.eq.presets).filter(p => p !== 'Custom').sort().map(preset => 
              `<option value="${preset}">${preset}</option>`
            ).join('')}
          </select>
          <button class="eq-save-btn" id="eq-save-custom">SAVE TO CUSTOM</button>
        </div>
        
        <div class="eq-bands-container">
          ${this.eq.bandNames.map((name, i) => this.createBandHTML(name, i)).join('')}
        </div>
        
        <div class="eq-footer">
          <button class="eq-reset-btn" id="eq-reset">RESET TO FLAT</button>
        </div>
      </div>
    `;
    
    document.body.appendChild(this.container);
    this.attachEvents();
  }
  
  createBandHTML(bandName, index) {
    return `
      <div class="eq-band">
        <div class="eq-value" data-index="${index}">0.0</div>
        <input type="range" 
               class="eq-slider" 
               data-index="${index}"
               min="-120" 
               max="120" 
               value="0"
               step="1"
               orient="vertical">
        <div class="eq-label">${bandName}</div>
      </div>
    `;
  }
  
  attachEvents() {
    this.container.querySelector('#eq-close').addEventListener('click', () => this.close());
    this.container.addEventListener('click', (e) => {
      if (e.target === this.container) this.close();
    });
    
    const presetSelect = this.container.querySelector('#eq-preset-select');
    presetSelect.addEventListener('change', (e) => this.applyPreset(e.target.value));
    
    this.container.querySelector('#eq-save-custom').addEventListener('click', () => this.saveCustom());
    this.container.querySelector('#eq-reset').addEventListener('click', () => this.reset());
    
    const sliders = this.container.querySelectorAll('.eq-slider');
    const valueLabels = this.container.querySelectorAll('.eq-value');
    
    sliders.forEach((slider, index) => {
      this.sliders[index] = slider;
      this.valueLabels[index] = valueLabels[index];
      
      slider.addEventListener('input', (e) => {
        const value = parseFloat(e.target.value) / 10;
        this.eq.setBandGain(index, value);
        this.updateValueLabel(index, value);
        this.checkPresetMatch();
      });
    });
  }
  
  updateValueLabel(index, value) {
    const label = this.valueLabels[index];
    if (label) {
      const formatted = value >= 0 ? `+${value.toFixed(1)}` : value.toFixed(1);
      label.textContent = formatted;
    }
  }
  
  applyPreset(presetName) {
    const values = this.eq.applyPreset(presetName);
    if (values) {
      values.forEach((value, index) => {
        this.sliders[index].value = value * 10;
        this.updateValueLabel(index, value);
      });
      this.currentPreset = presetName;
      this.container.querySelector('#eq-preset-select').value = presetName;
    }
  }
  
  checkPresetMatch() {
    const currentValues = this.eq.getCurrentValues();
    let matched = null;
    
    for (const [name, values] of Object.entries(this.eq.presets)) {
      if (name === 'Custom') continue;
      const isMatch = values.every((val, i) => Math.abs(val - currentValues[i]) < 0.15);
      if (isMatch) {
        matched = name;
        break;
      }
    }
    
    const presetSelect = this.container.querySelector('#eq-preset-select');
    presetSelect.value = matched || 'Custom';
    this.currentPreset = matched || 'Custom';
  }
  
  saveCustom() {
    const values = this.eq.getCurrentValues();
    this.eq.saveCustomPreset(values);
    
    const btn = this.container.querySelector('#eq-save-custom');
    const originalText = btn.textContent;
    btn.textContent = '✓ SAVED';
    btn.style.backgroundColor = '#00ff41';
    btn.style.color = '#000';
    
    setTimeout(() => {
      btn.textContent = originalText;
      btn.style.backgroundColor = '';
      btn.style.color = '';
    }, 1500);
    
    this.currentPreset = 'Custom';
    this.container.querySelector('#eq-preset-select').value = 'Custom';
  }
  
  reset() {
    this.applyPreset('Flat');
  }
  
  open() {
    this.container.classList.add('active');
    this.isOpen = true;
  }
  
  close() {
    this.container.classList.remove('active');
    this.isOpen = false;
  }
  
  toggle() {
    this.isOpen ? this.close() : this.open();
  }
}