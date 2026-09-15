(function() {
    const PLUGIN_ID = 'track-diary';

    // Variabel untuk menyimpan data lagu yang sedang aktif saat ini
    let currentTrackPath = null;
    let notepadContainer = null;
    let textareaEl = null;
    let titleEl = null;

    // Kunci penyimpanan posisi kotak catatan (persist lintas restart app,
    // sama seperti mekanisme localStorage yang sudah dipakai buat catatan lagu)
    const POSITION_STORAGE_KEY = 'macan_plg_notepad_position';

    // State drag — pakai Pointer Events biar konsisten buat mouse & touch/stylus
    let isDragging = false;
    let dragOffsetX = 0;
    let dragOffsetY = 0;

    // ── 1. Fungsi bantu: posisi & drag ──────────────────────────

    // Pastikan kotak catatan gak kegeser sampai keluar layar (misal window
    // di-resize lebih kecil sejak terakhir disimpan)
    function clampPosition(left, top) {
        const el = notepadContainer;
        const maxLeft = Math.max(0, window.innerWidth - el.offsetWidth);
        const maxTop  = Math.max(0, window.innerHeight - el.offsetHeight);
        return {
            left: Math.min(Math.max(0, left), maxLeft),
            top:  Math.min(Math.max(0, top), maxTop),
        };
    }

    function saveCurrentPosition() {
        const rect = notepadContainer.getBoundingClientRect();
        try {
            localStorage.setItem(POSITION_STORAGE_KEY, JSON.stringify({
                left: rect.left,
                top: rect.top,
            }));
        } catch (e) {
            // localStorage penuh/diblokir — bukan fatal, cuma posisi gak kesimpen
            console.warn('[Buku Harian Lagu] Gagal menyimpan posisi:', e);
        }
    }

    // Terapkan posisi tersimpan (kalau ada) saat app baru dibuka.
    // Kalau belum pernah digeser sebelumnya, biarkan pakai posisi default
    // dari CSS (pojok kanan bawah via bottom/right).
    function restoreSavedPosition() {
        let saved = null;
        try {
            const raw = localStorage.getItem(POSITION_STORAGE_KEY);
            if (raw) saved = JSON.parse(raw);
        } catch (e) {
            saved = null;
        }
        if (!saved || typeof saved.left !== 'number' || typeof saved.top !== 'number') return;

        const { left, top } = clampPosition(saved.left, saved.top);
        notepadContainer.style.left   = `${left}px`;
        notepadContainer.style.top    = `${top}px`;
        notepadContainer.style.right  = 'auto';
        notepadContainer.style.bottom = 'auto';
    }

    function onPointerDown(e) {
        // Cuma tombol kiri mouse / sentuhan utama yang boleh mulai drag
        if (e.button !== undefined && e.button !== 0) return;

        isDragging = true;
        const rect = notepadContainer.getBoundingClientRect();

        // Begitu drag dimulai, lepas dari bottom/right dan pindah ke left/top
        // supaya perhitungan posisi selama drag konsisten
        notepadContainer.style.left   = `${rect.left}px`;
        notepadContainer.style.top    = `${rect.top}px`;
        notepadContainer.style.right  = 'auto';
        notepadContainer.style.bottom = 'auto';

        dragOffsetX = e.clientX - rect.left;
        dragOffsetY = e.clientY - rect.top;

        notepadContainer.classList.add('plg-dragging');
        titleEl.setPointerCapture?.(e.pointerId);

        e.preventDefault();
    }

    function onPointerMove(e) {
        if (!isDragging) return;
        const { left, top } = clampPosition(e.clientX - dragOffsetX, e.clientY - dragOffsetY);
        notepadContainer.style.left = `${left}px`;
        notepadContainer.style.top  = `${top}px`;
    }

    function onPointerUp(e) {
        if (!isDragging) return;
        isDragging = false;
        notepadContainer.classList.remove('plg-dragging');
        titleEl.releasePointerCapture?.(e.pointerId);
        saveCurrentPosition();
    }

    // ── 2. Daftarkan Plugin ke Ekosistem Macan ──
    window.MacanBridge?.register({
        id: PLUGIN_ID,
        name: 'Buku Harian Lagu (Track Notepad)',
        version: '1.0.0',

        // Menyuntikkan gaya tampilan (CSS) untuk kotak catatan di pojok kanan bawah
        styles: `
            #plg-notepad-container {
                position: fixed;
                bottom: 24px;
                right: 24px;
                width: 260px;
                background: rgba(24, 24, 27, 0.93);
                border: 1px solid rgba(255, 255, 255, 0.1);
                border-radius: 10px;
                padding: 12px;
                z-index: 9999;
                box-shadow: 0 8px 24px rgba(0,0,0,0.5);
                backdrop-filter: blur(8px);
                font-family: 'Inter', sans-serif;
            }
            .plg-notepad-title {
                font-family: 'Space Mono', monospace;
                font-size: 0.65rem;
                letter-spacing: 2px;
                color: var(--accent, #E8FF00);
                margin-bottom: 8px;
                font-weight: bold;
                cursor: move;
                user-select: none;
            }
            #plg-notepad-container.plg-dragging {
                transition: none;
                opacity: 0.85;
            }
            #plg-notepad-textarea {
                width: 100%;
                height: 80px;
                background: rgba(0, 0, 0, 0.3);
                border: 1px solid rgba(255, 255, 255, 0.05);
                border-radius: 6px;
                color: #f5f5f5;
                font-size: 0.8rem;
                padding: 8px;
                resize: none;
                outline: none;
                box-sizing: border-box;
            }
            #plg-notepad-textarea:focus {
                border-color: var(--accent, #E8FF00);
            }
            #plg-notepad-textarea::placeholder {
                color: rgba(255,255,255,0.2);
                font-style: italic;
            }
        `,

        // ── 3. Dengarkan Sinyal Perubahan Lagu ──
        on: {
            'track:load': (track) => {
                // Simpan lokasi file lagu saat ini sebagai Kunci Utama penyimpanan
                currentTrackPath = track.path;
                
                if (textareaEl) {
                    // Ambil catatan lama dari memori berdasarkan lokasi file lagu
                    const STORAGE_KEY = `macan_plg_notepad_${currentTrackPath}`;
                    const catatanLama = localStorage.getItem(STORAGE_KEY) || '';
                    
                    // Masukkan catatan lama (jika ada) ke dalam kotak teks
                    textareaEl.value = catatanLama;
                    textareaEl.disabled = false;
                    textareaEl.placeholder = "Tulis memo/memori untuk lagu ini...";
                }
            }
        },

        // ── 4. Fungsi Inisialisasi Tampilan Saat Aplikasi Dibuka ──
        init() {
            console.log('[Buku Harian Lagu] Memasang kotak catatan ke layar...');

            // Membuat elemen kotak teks secara dinamis di HTML
            notepadContainer = document.createElement('div');
            notepadContainer.id = 'plg-notepad-container';
            notepadContainer.innerHTML = `
                <div class="plg-notepad-title">📝 TRACK DIARY</div>
                <textarea id="plg-notepad-textarea" placeholder="Play a song to start writing...." disabled></textarea>
            `;

            // Tempelkan ke badan utama aplikasi
            document.body.appendChild(notepadContainer);
            textareaEl = document.getElementById('plg-notepad-textarea');
            titleEl = notepadContainer.querySelector('.plg-notepad-title');

            // Kalau kotak ini pernah digeser sebelumnya, pasang lagi di posisi
            // terakhir. Kalau belum, biarkan default (pojok kanan bawah).
            restoreSavedPosition();

            // Judul jadi "pegangan" buat geser kotaknya — bukan seluruh kotak,
            // biar area teks tetap bisa di-drag-select isinya secara normal.
            titleEl.addEventListener('pointerdown', onPointerDown);
            window.addEventListener('pointermove', onPointerMove);
            window.addEventListener('pointerup', onPointerUp);

            // Kalau window di-resize, pastikan kotak gak "kepental" keluar layar
            window.addEventListener('resize', () => {
                if (isDragging) return;
                const rect = notepadContainer.getBoundingClientRect();
                const { left, top } = clampPosition(rect.left, rect.top);
                if (left !== rect.left || top !== rect.top) {
                    notepadContainer.style.left   = `${left}px`;
                    notepadContainer.style.top    = `${top}px`;
                    notepadContainer.style.right  = 'auto';
                    notepadContainer.style.bottom = 'auto';
                }
            });

            // Dengarkan setiap kali pengguna mengetik di dalam kotak teks (Auto-Save)
            textareaEl.addEventListener('input', () => {
                if (!currentTrackPath) return;

                const STORAGE_KEY = `macan_plg_notepad_${currentTrackPath}`;
                const teksBaru = textareaEl.value;

                // Simpan tulisan secara real-time ke memori lokal komputer
                if (teksBaru.trim() === '') {
                    localStorage.removeItem(STORAGE_KEY); // Hapus kunci jika teks dikosongkan
                } else {
                    localStorage.setItem(STORAGE_KEY, teksBaru);
                }
            });
        }
    });
})();
