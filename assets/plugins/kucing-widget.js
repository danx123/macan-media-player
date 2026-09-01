// Memanfaatkan sistem MacanBridge resmi agar aman dari error global
MacanBridge.register({
    id: 'kucing-widget',
    name: 'Widget Kucing Responsif',
    version: '1.0.0',

    // 1. Berlangganan event musik dari inti Macan secara otomatis
    on: {
        'player:play': () => {
            // Ketika tombol PLAY diklik atau musik berjalan
            const kucing = document.getElementById('plg-kucing-img');
            if (kucing) {
                kucing.src = "plugins/kucing-joget.gif";
                kucing.style.animation = "plg-kucing-bounce 0.5s infinite linear";
            }
        },
        'player:pause': () => {
            // Ketika musik di-PAUSE atau lagu habis
            const kucing = document.getElementById('plg-kucing-img');
            if (kucing) {
                kucing.src = "plugins/kucing-diam.png";
                kucing.style.animation = "none";
            }
        }
    },

    // 2. Menyuntikkan gaya CSS terisolasi (wajib diawali dengan .plg-{id}-)
    styles: `
        #plg-kucing-container {
            position: fixed;
            bottom: 120px;
            left: 24px;
            z-index: 9999;
            cursor: move !important;
            user-select: none !important;
            -webkit-user-select: none !important;
            pointer-events: auto !important; /* WAJIB diubah dari none: butuh nangkap mousedown buat drag */
            background: transparent !important;
        }
        #plg-kucing-img {
            width: 110px;
            height: auto;
            background: transparent !important;
            pointer-events: none !important; /* Cegah gambar ikut ter-drag bawaan browser (ghost image) */
        }
        @keyframes plg-kucing-bounce {
            0%, 100% { transform: translateY(0) scale(1); }
            50% { transform: translateY(-6px) scale(1.03); }
        }
    `,

    // 3. Fungsi inisialisasi yang otomatis berjalan saat Macan dinyalakan
    init() {
        console.log('[kucing-widget] Memasang widget kucing ke DOM...');
        
        // Membuat elemen kontainer widget kucing secara aman
        const container = document.createElement('div');
        container.id = 'plg-kucing-container';
        
        // Memasang gambar default (diam) saat pertama kali aplikasi dibuka
        container.innerHTML = `<img src="plugins/kucing-diam.png" id="plg-kucing-img" draggable="false">`;
        
        // Memasukkan widget langsung ke dalam body utama aplikasi
        document.body.appendChild(container);

        // ── Posisi tersimpan (opsional) ──────────────────────────────
        // Ikut konvensi penamaan key di dokumentasi: macan_plg_{id}_{key}
        const STORAGE_KEY = 'macan_plg_kucing-widget_position';

        function savePosition(left, top) {
            try {
                localStorage.setItem(STORAGE_KEY, JSON.stringify({ left, top }));
            } catch (e) {
                console.warn('[kucing-widget] Gagal simpan posisi:', e);
            }
        }

        function loadPosition() {
            try {
                return JSON.parse(localStorage.getItem(STORAGE_KEY));
            } catch {
                return null;
            }
        }

        // Terapkan posisi tersimpan kalau ada, sebelum drag pertama kali
        const saved = loadPosition();
        if (saved && typeof saved.left === 'number' && typeof saved.top === 'number') {
            container.style.left = saved.left + 'px';
            container.style.top = saved.top + 'px';
            container.style.bottom = 'auto';
            container.style.right = 'auto';
        }

        // ── Logika drag & drop ───────────────────────────────────────
        let isDragging = false;
        let offsetX = 0;
        let offsetY = 0;

        container.addEventListener('mousedown', (e) => {
            isDragging = true;

            // Ambil posisi absolut komponen di layar saat ini
            const rect = container.getBoundingClientRect();
            offsetX = e.clientX - rect.left;
            offsetY = e.clientY - rect.top;

            // Pindah dari sistem bottom-left (CSS default) ke top-left dinamis
            container.style.top = rect.top + 'px';
            container.style.left = rect.left + 'px';
            container.style.bottom = 'auto';
            container.style.right = 'auto';

            e.preventDefault(); // Cegah seleksi teks/gesture bawaan browser
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;

            const newX = e.clientX - offsetX;
            const newY = e.clientY - offsetY;

            container.style.left = newX + 'px';
            container.style.top = newY + 'px';
        });

        document.addEventListener('mouseup', () => {
            if (!isDragging) return;
            isDragging = false;

            // Simpan posisi terakhir biar tetap di situ setelah restart/reload
            const rect = container.getBoundingClientRect();
            savePosition(rect.left, rect.top);
        });
    }
});