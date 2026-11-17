#!/usr/bin/env bash
# Pasang Super Band di VPS Ubuntu: hosting game + server collection pribadi.
#
#   curl -fsSL https://raw.githubusercontent.com/zenaki/Super-Band/main/server/install.sh -o install.sh
#   sudo bash install.sh
#
# Aman dijalankan ulang (untuk update atau ganti password).
# Opsi lewat environment:
#   SB_PREFIX=/super-band     alamat game di domain kamu (https://domain/super-band/). Isi "/" untuk subdomain khusus.
#   SB_USER=nama SB_PASSWORD=rahasia   akun collection tanpa ditanya
#   SB_NGINX_SITE=/etc/nginx/sites-enabled/xxx   file server block yang otomatis diberi baris include
#   SB_ORIGIN=https://zenaki.github.io          origin lain yang boleh memakai collection ini
set -euo pipefail

[ "$(id -u)" = 0 ] || { echo "Jalankan dengan sudo: sudo bash install.sh"; exit 1; }

REPO="${SB_REPO:-https://github.com/zenaki/Super-Band.git}"
APP=/opt/super-band/app
DATA=/var/lib/super-band
PORT="${SB_PORT:-8787}"
PREFIX="${SB_PREFIX:-/super-band}"
PREFIX="/${PREFIX#/}"; PREFIX="${PREFIX%/}"          # "/super-band" atau "" untuk root
ORIGIN="${SB_ORIGIN:-https://zenaki.github.io}"
MAX_MB="${SB_MAX_MB:-300}"

echo "==> Paket yang dibutuhkan"
export DEBIAN_FRONTEND=noninteractive
need=()
command -v git >/dev/null || need+=(git)
command -v python3 >/dev/null || need+=(python3)
command -v nginx >/dev/null || need+=(nginx)
if [ ${#need[@]} -gt 0 ]; then apt-get update -qq && apt-get install -y -qq "${need[@]}"; fi

echo "==> User sistem dan folder"
id superband >/dev/null 2>&1 || useradd --system --home-dir "$DATA" --shell /usr/sbin/nologin superband
mkdir -p /opt/super-band "$DATA/songs"
chown -R superband:superband /opt/super-band "$DATA"
chmod 750 "$DATA"

echo "==> Kode game"
if [ -d "$APP/.git" ]; then
  sudo -u superband git -C "$APP" pull --ff-only -q
else
  sudo -u superband git clone -q "$REPO" "$APP"
fi

echo "==> Akun collection"
if [ ! -s "$DATA/users.json" ] || [ -n "${SB_USER:-}" ]; then
  if [ -z "${SB_USER:-}" ]; then read -rp "Username: " SB_USER; fi
  sudo -u superband env SB_DATA="$DATA" SB_PASSWORD="${SB_PASSWORD:-}" python3 "$APP/server/superband_server.py" passwd "$SB_USER"
else
  echo "Akun sudah ada. Ganti password: sudo -u superband SB_DATA=$DATA python3 $APP/server/superband_server.py passwd <username>"
fi

echo "==> Service"
cat > /etc/systemd/system/superband-collection.service <<UNIT
[Unit]
Description=Super Band collection server
After=network.target

[Service]
User=superband
Group=superband
Environment=SB_DATA=$DATA
Environment=SB_PORT=$PORT
Environment=SB_ORIGIN=$ORIGIN
Environment=SB_MAX_MB=$MAX_MB
ExecStart=/usr/bin/python3 $APP/server/superband_server.py serve
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DATA

[Install]
WantedBy=multi-user.target
UNIT

# update otomatis: tarik main tiap 2 menit, restart server kalau kodenya berubah
cat > /usr/local/bin/superband-update <<UPD
#!/usr/bin/env bash
set -e
before=\$(sudo -u superband git -C $APP rev-parse HEAD)
sudo -u superband git -C $APP pull --ff-only -q || exit 0
after=\$(sudo -u superband git -C $APP rev-parse HEAD)
if [ "\$before" != "\$after" ] && ! sudo -u superband git -C $APP diff --quiet "\$before" "\$after" -- server/superband_server.py; then
  systemctl restart superband-collection
fi
UPD
chmod +x /usr/local/bin/superband-update
cat > /etc/systemd/system/superband-update.service <<UNIT
[Unit]
Description=Update Super Band dari GitHub

[Service]
Type=oneshot
ExecStart=/usr/local/bin/superband-update
UNIT
cat > /etc/systemd/system/superband-update.timer <<UNIT
[Unit]
Description=Update Super Band tiap 2 menit

[Timer]
OnBootSec=1min
OnUnitActiveSec=2min

[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable -q --now superband-collection superband-update.timer
systemctl restart superband-collection

echo "==> nginx"
SNIPPET=/etc/nginx/snippets/super-band.conf
mkdir -p /etc/nginx/snippets
cat > "$SNIPPET" <<NGX
# Super Band: game statis + API collection. Dipasang di dalam sebuah server { } lewat:
#   include snippets/super-band.conf;
location ~ ^$PREFIX/(\\.git|server|tests|tools|node_modules)(/|\$) { return 404; }
location $PREFIX/api/ {
    proxy_pass http://127.0.0.1:$PORT;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header Host \$host;
    proxy_http_version 1.1;
    proxy_request_buffering off;
    proxy_read_timeout 900s;
    proxy_send_timeout 900s;
    client_max_body_size ${MAX_MB}m;
}
NGX
if [ -n "$PREFIX" ]; then
  cat >> "$SNIPPET" <<NGX
location = $PREFIX { return 301 $PREFIX/; }
location $PREFIX/ {
    alias $APP/;
    index index.html;
    add_header Cache-Control "no-cache";
}
NGX
else
  cat >> "$SNIPPET" <<NGX
location / {
    root $APP;
    index index.html;
    add_header Cache-Control "no-cache";
}
NGX
fi

included() { grep -rqsE '^\s*include\s+snippets/super-band\.conf;' /etc/nginx/sites-enabled /etc/nginx/conf.d 2>/dev/null; }
if ! included && [ -n "${SB_NGINX_SITE:-}" ]; then
  site=$(readlink -f "$SB_NGINX_SITE")
  cp "$site" "$site.bak-superband"
  # sisipkan setelah baris server_name pertama
  awk '!done && /^[[:space:]]*server_name[[:space:]]/ { print; print "    include snippets/super-band.conf;"; done=1; next } { print }' "$site.bak-superband" > "$site"
  if nginx -t 2>/dev/null; then echo "Baris include ditambahkan ke $site (backup: $site.bak-superband)"; else cp "$site.bak-superband" "$site"; echo "nginx -t gagal, $site dikembalikan seperti semula."; fi
fi

if included && nginx -t 2>/dev/null; then
  systemctl reload nginx
  NGINX_OK=1
else
  NGINX_OK=0
fi

echo
echo "================ SELESAI ================"
sleep 1
if curl -fsS "http://127.0.0.1:$PORT/api/ping" >/dev/null 2>&1; then echo "Server collection : jalan di 127.0.0.1:$PORT"; else echo "Server collection : BELUM jalan, cek: journalctl -u superband-collection -n 30"; fi
echo "Data lagu         : $DATA/songs"
echo "Kode game         : $APP (update otomatis tiap 2 menit dari GitHub)"
if [ "$NGINX_OK" = 1 ]; then
  echo "nginx             : aktif. Buka https://DOMAIN-KAMU$PREFIX/"
else
  echo "nginx             : tinggal satu langkah manual."
  echo
  echo "  1. Buka file server block domain kamu, salah satu dari:"
  ls /etc/nginx/sites-enabled/ 2>/dev/null | sed 's/^/       \/etc\/nginx\/sites-enabled\//'
  echo "  2. Di dalam blok  server { ... }  yang listen 443, tambahkan baris:"
  echo "       include snippets/super-band.conf;"
  echo "  3. sudo nginx -t && sudo systemctl reload nginx"
  echo "  Lalu buka https://DOMAIN-KAMU$PREFIX/"
fi
