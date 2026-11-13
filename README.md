# Vendor Discussion Portal — Live Chat (Cloudflare)

Aplikasi live chat untuk diskusi pengadaan vendor dan Procurement. Ini adalah build full-stack: UI, API, database, penyimpanan file, dan realtime WebSocket berada dalam satu aplikasi Cloudflare Worker.

## Fitur

- Registrasi vendor mandiri; akun langsung aktif.
- Procurement/Admin dapat membuat project dan topik diskusi.
- Semua vendor yang login dapat masuk ke project berstatus **Open** tanpa approval project.
- Chat realtime menggunakan WebSocket melalui Cloudflare Durable Objects.
- Pesan dan riwayat disimpan di Cloudflare D1.
- Alias vendor dibuat otomatis per project (`Vendor 01`, `Vendor 02`, dst.).
- Vendor hanya melihat alias vendor lain; Procurement dapat melihat identitas vendor.
- Pesan langsung tayang tanpa approval awal.
- Procurement dapat menyembunyikan, menghapus, dan memulihkan pesan.
- Project Closed: vendor tidak dapat membuka histori; Procurement tetap dapat mengakses arsip.
- Topik Closed: vendor masih dapat membaca percakapan tetapi tidak dapat mengirim pesan.
- Lampiran vendor bersifat privat ke Procurement; lampiran Procurement dibagikan ke peserta project.
- Procurement dapat mengunggah salinan sanitasi untuk dipublikasikan; file asli vendor tetap privat.
- Akun vendor dapat diblokir oleh Super Admin; sesi dan koneksi WebSocket aktif dicabut.
- Widget Live Chat Procurement tersedia di kanan bawah khusus Vendor yang login, dengan antrean, agen, riwayat, notifikasi, dan percakapan realtime.
- Super Admin dapat mengelola kategori project dari menu Pengaturan, termasuk ubah nama, aktif/nonaktif, urutan, dan hapus dengan kategori pengganti bila sedang dipakai.
- Last Login mencatat login berhasil dan ditampilkan dalam WIB di daftar pengguna.
- Workspace Procurement berisi topik yang sudah memiliki pesan, diurutkan berdasarkan aktivitas chat terbaru.

## Arsitektur

| Komponen | Fungsi |
|---|---|
| Cloudflare Workers Static Assets | Hosting `public/index.html` dan aset UI |
| Cloudflare Workers | API, autentikasi, otorisasi, validasi |
| Cloudflare D1 | User, session, project, topic, message, file metadata, audit log |
| Cloudflare Durable Objects | Koneksi WebSocket per topik dan broadcast realtime |
| Cloudflare R2 | Penyimpanan lampiran |

Cloudflare Static Assets dan Worker API di-deploy sebagai satu unit. Untuk aplikasi full-stack baru, Cloudflare merekomendasikan Workers Static Assets; Durable Objects digunakan untuk koneksi WebSocket yang berumur panjang.

## Persiapan

- Akun Cloudflare.
- Node.js 20 atau lebih baru.
- npm.
- Wrangler CLI (dipasang dari `package.json`).

## Deploy pertama kali

### 1. Install dan login

```bash
npm install
npx wrangler login
```

### 2. Buat database D1

```bash
npx wrangler d1 create vdp-livechat-db
```

Salin `database_id` dari output perintah, lalu buka `wrangler.jsonc` dan ganti:

```json
"database_id": "REPLACE_WITH_D1_DATABASE_ID"
```

dengan ID D1 yang sebenarnya.

### 3. Buat bucket R2

```bash
npx wrangler r2 bucket create vdp-livechat-files
```

Nama bucket harus sama dengan `bucket_name` pada `wrangler.jsonc`.

### 4. Jalankan database migration

```bash
npx wrangler d1 migrations apply vdp-livechat-db --remote
```

Perintah ini menerapkan seluruh migration di folder `migrations/`, termasuk tabel kategori dan Live Chat Procurement pada `0002_change_requests_15_18.sql`.

### 5. Simpan setup secret

Buat secret acak yang panjang (minimal 32 karakter), lalu jalankan:

```bash
npx wrangler secret put SETUP_SECRET
```

Masukkan secret tersebut saat diminta. Jangan menaruh secret ini di `public/index.html`, repository Git, atau file konfigurasi yang di-commit.

### 6. Deploy Worker + UI

```bash
npx wrangler deploy
```

Setelah selesai, Wrangler menampilkan URL `*.workers.dev`.

## Deploy melalui Cloudflare Dashboard

Project ini menggunakan **Workers**, bukan sekadar upload HTML statis ke Pages, karena realtime chat membutuhkan backend API, D1, R2, dan Durable Objects.

1. Buat repository GitHub dan push seluruh folder project ini.
2. Buka Cloudflare Dashboard → **Workers & Pages** → **Create application**.
3. Pilih opsi untuk menghubungkan repository Git (GitHub/GitLab), lalu pilih repository `vdp-livechat`.
4. Pastikan `wrangler.jsonc` berada di root repository. Gunakan build/deploy command `npm run deploy` jika diminta oleh konfigurasi build.
5. Buat D1 database bernama `vdp-livechat-db` melalui menu D1, lalu salin ID-nya ke `wrangler.jsonc`.
6. Buat R2 bucket bernama `vdp-livechat-files`.
7. Jalankan migration D1 dari terminal yang sudah login ke akun Cloudflare:

   ```bash
   npx wrangler d1 migrations apply vdp-livechat-db --remote
   ```

8. Pada Worker → **Settings → Variables and Secrets**, tambahkan `SETUP_SECRET` sebagai **Secret** (bukan plain text variable).
9. Deploy ulang Worker dari Dashboard atau push commit baru ke repository.

Binding D1, R2, Durable Objects, dan Static Assets sudah didefinisikan di `wrangler.jsonc`. Pastikan nama binding tersebut tidak diubah tanpa mengubah kode Worker.

## Setup akun pertama

1. Buka URL Worker yang sudah di-deploy.
2. Halaman **First-time setup** akan muncul jika database belum memiliki Super Admin.
3. Masukkan `SETUP_SECRET` yang sama dengan secret di Cloudflare.
4. Buat nama, username, dan password Super Admin (minimal 12 karakter).
5. Setelah akun dibuat, endpoint setup terkunci dan secret tidak dapat digunakan lagi untuk membuat admin pertama.

Super Admin kemudian dapat:
- Membuat akun Procurement dari menu **Pengguna**.
- Memblokir atau mengaktifkan kembali akun vendor.
- Mengelola kategori project dari menu **Pengaturan**.
- Membuat project dan topik.
- Memoderasi pesan.

Agen Procurement mengatur status ketersediaan dari menu **Live Chat**. Chat Vendor baru otomatis dialokasikan ke agen Online; antrean yang menunggu akan didistribusikan saat agen Online tersedia. Status agen yang tidak lagi mengirim heartbeat akan dianggap Offline.

Vendor mendaftar sendiri dari halaman **Daftar Vendor**.

## Development lokal

Salin `.dev.vars.example` menjadi `.dev.vars`, lalu ganti secret contoh dengan nilai lokal yang kuat.

```bash
npm install
npx wrangler d1 migrations apply vdp-livechat-db --local
npx wrangler dev
```

Buka URL lokal yang diberikan Wrangler. Untuk environment lokal, binding D1 dan R2 menggunakan resource lokal Wrangler. Untuk database produksi, gunakan migration `--remote`.

## Batasan dan catatan sebelum go-live

- Database produksi dimulai kosong. Akun demo dan data `localStorage` dari file HTML lama **tidak otomatis dimigrasikan**.
- Maksimal 3 lampiran per pesan, masing-masing maksimal 2 MB.
- Aplikasi belum memiliki antivirus/malware scanning untuk file. Untuk penggunaan produksi, batasi tipe file yang boleh diunggah dan tambahkan scanning sebelum mengizinkan unduhan.
- Salinan sanitasi harus disiapkan Procurement di luar aplikasi (hapus nama vendor, kontak, metadata, dan informasi rahasia), lalu unggah melalui tombol **Publikasikan salinan sanitasi**. File asli tetap privat.
- Password menggunakan PBKDF2-HMAC-SHA256 dan session disimpan sebagai hash token di D1; cookie session bersifat HttpOnly dan SameSite.
- Password recovery melalui email belum disediakan. Super Admin dapat menonaktifkan akun; reset password perlu ditambahkan sebagai fitur admin terpisah.
- Audit event tersimpan di D1, tetapi halaman ekspor/monitoring audit belum disertakan dalam build live-chat ini.
- Sebelum digunakan untuk pengadaan sungguhan, lakukan UAT, backup D1/R2, review keamanan, dan konfigurasi Cloudflare WAF/Rate Limiting sesuai kebijakan perusahaan.

## Struktur folder

```text
vdp-livechat/
├── migrations/
│   ├── 0001_init.sql
│   └── 0002_change_requests_15_18.sql
├── public/
│   ├── _headers
│   ├── app.js
│   ├── index.html
│   └── styles.css
├── src/
│   └── index.js
├── .dev.vars.example
├── .gitignore
├── package.json
└── wrangler.jsonc
```
