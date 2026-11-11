# Changelog

Semua perubahan penting di project ini dicatat di file ini.
Format mengikuti [Keep a Changelog](https://keepachangelog.com/) dan versi mengikuti [Semantic Versioning](https://semver.org/).

## [1.3.0] - 2026-11-11

### Added

- **Upload multi-file untuk satu lagu** di Auto-chart: pilih sekaligus lagu lengkap dan file stem hasil pemisah (mvsep, Demucs, UVR, dan sejenisnya). Jenis stem dikenali dari nama file: `guitar`, `bass`, `drums`, `vocals`, `piano`, `other`.
- Frets dibuat langsung dari file stem yang dipilih, tempo tetap dari lagu lengkap.
- Kalau stem yang di-upload lengkap (4 stem atau lebih, atau ada `other`), yang diputar saat main adalah stem-stemnya, dan instrumen yang dimainkan di-mute saat miss.
- Tanpa file lagu lengkap pun bisa: yang diputar gabungan semua stem.

## [1.2.0] - 2026-11-11

### Added

- **Pisah instrumen** di Auto-chart: setelah memilih file audio, pilih frets dibuat dari Semua instrumen, Gitar / melodi, Bass, Drum, atau Vokal.
- Tombol **Dengarkan hasil pisah** untuk memutar 12 detik hasil pemisahan sebelum chart dibuat.
- Pemisahan memakai filter ringan (bunyi bertahan vs pukulan, posisi tengah vs samping stereo, rentang frekuensi), jadi jalan di HP tanpa download model. Hasilnya kasar, bukan stem bersih.

### Changed

- Tempo selalu dihitung dari lagu lengkap, sedangkan note dan lane diambil dari instrumen yang dipilih.
- Judul lagu hasil auto-chart diberi keterangan instrumennya, misalnya "Headhunt (Gitar / melodi)".

## [1.1.0] - 2026-11-11

### Added

- Penilaian timing per note: **Perfect**, **Great**, **Cool**, dan **Miss**, muncul di tengah highway.
- **Combo counter** besar di bawah tulisan penilaian, plus poin yang baru didapat (`+200`).
- Rincian jumlah Perfect / Great / Cool / Miss di layar hasil.

### Changed

- Skor per note sekarang tergantung timing: Perfect 100, Great 75, Cool 50 (sebelumnya rata 50). Skor lama tetap tersimpan tapi tidak sebanding dengan skor baru.

## [1.0.1] - 2026-11-11

### Fixed

- Suara lagu pelan-pelan menghilang di lagu tanpa stem gitar terpisah (auto-chart dan import satu file audio). Efek "redam saat miss" membaca volume yang sedang turun, jadi tiap miss beruntun volumenya makin kecil sampai habis.

### Changed

- Auto-chart: lane sekarang ditentukan dari estimasi nada tiap onset (harmonic summation + pelacakan kontur), bukan dari spectral centroid. Arah naik-turun note lebih mengikuti melodi. Lagu yang sudah di-auto-chart sebelumnya perlu dibuat ulang supaya ikut berubah.

## [1.0.0] - 2026-11-11

Rilis pertama.

### Added

- Gameplay 5-fret guitar dengan highway perspektif: note, chord, sustain, HOPO, tap note, open note.
- Scoring: streak, multiplier sampai x4, Super mode (x2), rating bintang, deteksi full combo.
- Dua cara main: **Tap** (touch, keyboard, gamepad) dan **Strum** (guitar controller) dengan aturan HOPO/tap dan anchoring.
- Tiga lagu original bawaan yang di-generate oleh synth internal: Senja Terakhir, Neon Runway, Gamelan Riot. Masing-masing punya chart Easy, Medium, Hard, Expert.
- Stem gitar terpisah yang di-mute saat miss.
- Import chart Clone Hero: `.zip`, `.sng`, `notes.chart`, `notes.mid`, `song.ini`, multi-stem audio, album art.
- Auto-chart dari file audio: deteksi onset, estimasi tempo dan fase, mapping kontur nada ke lane, sustain, phrase Super.
- Chart editor: note, sustain, jenis note, phrase Super, snap grid, waveform, record, undo/redo, salin antar difficulty, export `.chart` / `.zip`.
- Mode latihan 75% dan 50%.
- Settings: kecepatan note, toleransi timing, lefty flip, volume, remap tombol keyboard, layout gamepad.
- Kalibrasi audio offset dengan tap mengikuti bunyi klik.
- Skor terbaik per lagu, part, dan difficulty.
- Layout portrait dan landscape, nomor versi di kanan atas, manifest untuk Add to Home Screen.
- Unit test untuk chart model, engine, parser format, synth, dan auto-chart.
