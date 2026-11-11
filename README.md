# Super Band

Rhythm game 5-fret guitar ala Guitar Hero / Clone Hero / Rock Band yang jalan langsung di browser, di HP (portrait maupun landscape) dan di desktop. Tanpa install, tanpa server, tanpa build step.

**Main di sini:** https://zenaki.github.io/Super-Band/

## Fitur

- **Highway 3D** dengan 5 lane, chord, sustain, HOPO, tap note, open note, dan **Super mode** (skor dobel).
- **3 lagu original bawaan**. Musiknya di-generate di device oleh synth internal, jadi repo ini tidak menyimpan file audio sama sekali.
  - *Senja Terakhir* (ballad, level 1)
  - *Neon Runway* (rock, level 2)
  - *Gamelan Riot* (riff cepat bernuansa pelog, level 4)
- **Import chart Clone Hero**: `.zip`, `.sng`, atau `notes.chart` / `notes.mid` + `song.ini` + audio. Part Lead Guitar, Co-op, Rhythm, Bass, dan Keys didukung, lengkap dengan multi-stem (stem instrumen di-mute saat miss).
- **Auto-chart dari audio**: pilih MP3/M4A/WAV/OGG, pilih instrumen yang dijadikan frets (semua, gitar/melodi, bass, drum, vokal), lalu chart 4 difficulty dibuat otomatis. Pemisahan instrumennya filter ringan tanpa model AI, jadi hasilnya kasar.
- **Chart editor** di browser: pasang note, sustain, HOPO/tap, phrase Super, record sambil lagu jalan, undo/redo, lalu export ke `.chart` atau `.zip` yang bisa dibuka Clone Hero.
- 4 difficulty (Easy, Medium, Hard, Expert), mode latihan 75% dan 50%, bintang, skor terbaik per lagu.
- Input **touch**, **keyboard**, **gamepad**, dan **guitar controller** (mode strum).
- **Kalibrasi audio** untuk headphone Bluetooth.

## Cara main

| Input | Lane 1-5 | Super | Pause |
| --- | --- | --- | --- |
| Touch | tap 5 tombol fret di bawah | tombol Super atau tap highway | tombol di kanan atas |
| Keyboard | `A S D F G` atau `1 2 3 4 5` | `Space` | `Esc` |
| Gamepad | `LT LB RB RT A` | `X` / `Y` | `Start` |
| Guitar controller | 5 fret + strum bar | `Select` | `Start` |

- Tekan lane tepat saat note menyentuh garis. Note berekor ditahan sampai habis.
- Makin pas timing-nya makin besar poinnya: **Perfect** 100, **Great** 75, **Cool** 50 per note.
- Tiap 10 combo multiplier naik, maksimal x4.
- Note tosca berbintang mengisi meter Super. Setelah setengah penuh, aktifkan untuk skor x2.
- Untuk guitar controller: Settings, lalu pilih cara main **Strum** dan layout **Guitar controller**.
- Timing terasa meleset? Settings, lalu **Kalibrasi audio**.

Di iPhone, pakai Share lalu **Add to Home Screen** supaya layar penuh dan data lagu lebih awet.

## Lagu sendiri

Semua lagu yang di-import disimpan di browser (IndexedDB) pada device itu saja dan tidak di-upload ke mana pun. Pakai hanya lagu yang memang kamu punya haknya.

### Stem dari pemisah instrumen

Untuk auto-chart yang jauh lebih akurat, pisahkan dulu lagunya di mvsep, Demucs, UVR, atau sejenisnya. Lalu di **Tambah lagu → Auto-chart**, pilih semua filenya sekaligus:

- lagu lengkap (nama bebas, misalnya `Headhunt.mp3`)
- file stem, dengan nama yang mengandung `guitar`, `bass`, `drums`, `vocals`, `piano`, atau `other` (misalnya `headhunt_bs6stem_mt_0_guitar.mp3`)

Pilih stem yang mau dijadikan frets. Kalau semua stem ikut di-upload, instrumen yang kamu mainkan di-mute saat miss.

Format audio tergantung browser. MP3 dan M4A paling aman. OGG/Opus butuh iOS 18.4 atau lebih baru.

## Development

Project ini murni static: HTML, CSS, dan ES modules.

```bash
# jalankan lokal
python3 -m http.server 8080
# buka http://localhost:8080

# unit test (Node 20+)
npm test

# render lagu bawaan ke WAV untuk dicek
node tools/render-song.mjs neon-runway out.wav
```

Tambahkan `?bot=1` di URL untuk mode demo (dimainkan otomatis, skor tidak disimpan).

### Struktur

```
index.html, css/            UI
js/main.js                  navigasi screen + alur main
js/core/                    chart model, engine skor, parser .chart/.mid/.zip/.sng
js/audio/                   synth, song builder, player, auto-chart
js/songs/                   definisi lagu bawaan (notasi teks)
js/game/                    highway renderer, input, session
js/editor/                  chart editor
js/store/                   settings, skor, library (IndexedDB)
tests/                      unit test
```

### Menambah lagu bawaan

Buat file baru di `js/songs/` lalu daftarkan di `js/songs/index.js`. Part gitar ditulis per bar dengan token `nada:durasi` (1 step = 1/16 not):

```
e3:2          note tunggal
E2:4          power chord (huruf besar)
[a2 e3 a3]:8  chord bebas
-:4           diam
E2.:2  e4~:8  e3^:2    palm mute, sustain + vibrato, aksen
```

Chart untuk 4 difficulty dibuat otomatis dari part gitar tersebut.

## Deployment

Default deployment pakai **GitHub Pages** dari branch `main` (root). Setiap push ke `main` langsung ter-deploy.

## Lisensi font

Shrikhand dan Barlow Semi Condensed, keduanya SIL Open Font License 1.1 (lihat `assets/fonts/`).
