#!/usr/bin/env python3
"""Server collection Super Band: login + penyimpanan lagu. Hanya butuh Python 3 bawaan Ubuntu.

Perintah:
  superband_server.py serve                  jalankan server (dipakai systemd)
  superband_server.py passwd <username>      buat / ganti akun (password ditanya)
  superband_server.py import-git <folder>    salin collection dari clone repo Super-Band-Library

Konfigurasi lewat environment:
  SB_DATA   folder data            (default /var/lib/super-band)
  SB_PORT   port                   (default 8787)
  SB_HOST   alamat bind            (default 127.0.0.1; pakai 0.0.0.0 di dalam container)
  SB_ORIGIN origin tambahan yang boleh mengakses API, dipisah koma (mis. https://zenaki.github.io)
  SB_MAX_MB ukuran maksimum satu file dalam MB (default 300)
"""
import getpass
import hashlib
import hmac
import json
import os
import re
import secrets
import shutil
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote

DATA = os.environ.get('SB_DATA', '/var/lib/super-band')
PORT = int(os.environ.get('SB_PORT', '8787'))
HOST = os.environ.get('SB_HOST', '127.0.0.1')
ORIGINS = [o.strip().rstrip('/') for o in os.environ.get('SB_ORIGIN', '').split(',') if o.strip()]
MAX_BYTES = int(os.environ.get('SB_MAX_MB', '300')) * 1024 * 1024
SESSION_DAYS = 180
SONGS = os.path.join(DATA, 'songs')
LOCK = threading.RLock()
ID_RE = re.compile(r'^[A-Za-z0-9_-]{3,80}$')
FILE_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,99}$')
FAILS = {}  # ip -> [waktu gagal login]


def read_json(name, default):
    try:
        with open(os.path.join(DATA, name), encoding='utf-8') as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def write_json(name, value):
    path = os.path.join(DATA, name)
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(value, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def hash_password(password, salt=None):
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=2 ** 15, r=8, p=1, maxmem=128 * 1024 * 1024, dklen=32)
    return {'salt': salt.hex(), 'hash': digest.hex()}


def check_password(password, rec):
    digest = hashlib.scrypt(password.encode(), salt=bytes.fromhex(rec['salt']), n=2 ** 15, r=8, p=1, maxmem=128 * 1024 * 1024, dklen=32)
    return hmac.compare_digest(digest.hex(), rec['hash'])


def song_label(artist, title):
    artist = (artist or '').strip()
    title = (title or 'Untitled').strip()
    return f'{artist} - {title}' if artist and artist.lower() != 'unknown' else title


def safe_dir(label):
    clean = re.sub(r'[\\/:*?"<>|#%{}^~\[\]`\x00-\x1f]+', ' ', label)
    clean = re.sub(r'\s+', ' ', clean).strip(' .')
    return clean[:90].strip() or 'Untitled'


def unique_dir(label, index, own_id):
    used = {s['dir'].lower() for s in index if s['id'] != own_id}
    base = safe_dir(label)
    name, n = base, 2
    while name.lower() in used:
        name = f'{base} ({n})'
        n += 1
    return name


def load_index():
    return read_json('index.json', {'songs': []})['songs']


def save_index(songs):
    write_json('index.json', {'v': 1, 'songs': songs})


def summary(entry, folder):
    meta = entry.get('song', {}).get('meta', {})
    return {
        'id': entry['id'],
        'dir': folder,
        'source': entry.get('source', 'import'),
        'title': meta.get('title', 'Untitled'),
        'artist': meta.get('artist', 'Unknown'),
        'addedAt': entry.get('addedAt', int(time.time() * 1000)),
        'files': entry.get('files', []),
    }


def put_entry(entry):
    """Simpan entry.json + perbarui index. Mengembalikan nama folder lagu."""
    with LOCK:
        index = load_index()
        old = next((s for s in index if s['id'] == entry['id']), None)
        folder = old['dir'] if old else unique_dir(song_label(entry.get('song', {}).get('meta', {}).get('artist'), entry.get('song', {}).get('meta', {}).get('title')), index, entry['id'])
        path = os.path.join(SONGS, folder)
        os.makedirs(path, exist_ok=True)
        tmp = os.path.join(path, 'entry.json.tmp')
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(entry, f, ensure_ascii=False)
        os.replace(tmp, os.path.join(path, 'entry.json'))
        keep = {f['name'] for f in entry.get('files', [])} | {'entry.json'}
        for name in os.listdir(path):
            if name not in keep and not name.endswith('.tmp'):
                os.remove(os.path.join(path, name))
        index = [summary(entry, folder)] + [s for s in index if s['id'] != entry['id']]
        save_index(index)
        return folder


class Handler(BaseHTTPRequestHandler):
    server_version = 'SuperBand/1'
    protocol_version = 'HTTP/1.1'

    def log_message(self, fmt, *args):
        sys.stderr.write('%s %s\n' % (self.client(), fmt % args))

    def client(self):
        fwd = (self.headers.get('X-Forwarded-For') or '').split(',')[0].strip()
        return self.headers.get('X-Real-IP') or fwd or self.client_address[0]

    # ---- respons

    def cors(self):
        origin = (self.headers.get('Origin') or '').rstrip('/')
        if origin and origin in ORIGINS:
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')
            self.send_header('Access-Control-Allow-Headers', 'Authorization, Content-Type')
            self.send_header('Access-Control-Allow-Methods', 'GET, PUT, POST, DELETE, OPTIONS')
            self.send_header('Access-Control-Max-Age', '86400')

    def reply(self, status, body=None, ctype='application/json'):
        data = b'' if body is None else (body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False).encode())
        self.send_response(status)
        self.cors()
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(data)

    def fail(self, status, message):
        self.reply(status, {'error': message})

    def body_json(self):
        length = int(self.headers.get('Content-Length') or 0)
        if length > 20 * 1024 * 1024:
            raise ValueError('terlalu besar')
        return json.loads(self.rfile.read(length) or b'{}')

    def user(self):
        auth = self.headers.get('Authorization') or ''
        if not auth.startswith('Bearer '):
            return None
        key = hashlib.sha256(auth[7:].encode()).hexdigest()
        with LOCK:
            sessions = read_json('sessions.json', {})
            s = sessions.get(key)
            if not s or s['exp'] < time.time():
                return None
            return s['user']

    def route(self):
        path = unquote(self.path.split('?')[0])
        i = path.find('/api/')
        return [p for p in path[i + 5:].split('/') if p] if i >= 0 else None

    # ---- method

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.send_header('Content-Length', '0')
        self.end_headers()

    def do_GET(self):
        self.handle_api('GET')

    def do_POST(self):
        self.handle_api('POST')

    def do_PUT(self):
        self.handle_api('PUT')

    def do_DELETE(self):
        self.handle_api('DELETE')

    def handle_api(self, method):
        try:
            parts = self.route()
            if parts is None:
                return self.fail(404, 'tidak ditemukan')
            if parts == ['ping'] and method == 'GET':
                return self.reply(200, {'ok': True, 'app': 'super-band'})
            if parts == ['login'] and method == 'POST':
                return self.login()
            who = self.user()
            if not who:
                return self.fail(401, 'Sesi login habis. Login lagi.')
            if parts == ['logout'] and method == 'POST':
                return self.logout()
            if parts == ['index'] and method == 'GET':
                with LOCK:
                    return self.reply(200, {'songs': load_index()})
            if len(parts) >= 2 and parts[0] == 'songs' and ID_RE.match(parts[1]):
                return self.song(method, parts[1], parts[2:])
            return self.fail(404, 'tidak ditemukan')
        except (ValueError, KeyError) as err:
            self.fail(400, f'Permintaan tidak valid: {err}')
        except BrokenPipeError:
            pass

    def login(self):
        ip = self.client()
        now = time.time()
        with LOCK:
            recent = [t for t in FAILS.get(ip, []) if now - t < 900]
            FAILS[ip] = recent
        if len(recent) >= 8:
            return self.fail(429, 'Terlalu banyak percobaan login. Coba lagi 15 menit lagi.')
        data = self.body_json()
        name = str(data.get('username', '')).strip().lower()
        users = read_json('users.json', {})
        rec = users.get(name)
        ok = bool(rec) and check_password(str(data.get('password', '')), rec)
        if not rec:
            check_password('x', hash_password('y'))  # samakan waktu respons
        if not ok:
            with LOCK:
                FAILS.setdefault(ip, []).append(now)
            time.sleep(1)
            return self.fail(401, 'Username atau password salah.')
        token = secrets.token_urlsafe(32)
        with LOCK:
            sessions = {k: v for k, v in read_json('sessions.json', {}).items() if v['exp'] > now}
            sessions[hashlib.sha256(token.encode()).hexdigest()] = {'user': name, 'exp': now + SESSION_DAYS * 86400}
            write_json('sessions.json', sessions)
        self.reply(200, {'token': token, 'username': name})

    def logout(self):
        key = hashlib.sha256((self.headers.get('Authorization') or '')[7:].encode()).hexdigest()
        with LOCK:
            sessions = read_json('sessions.json', {})
            sessions.pop(key, None)
            write_json('sessions.json', sessions)
        self.reply(200, {'ok': True})

    def song(self, method, song_id, rest):
        with LOCK:
            found = next((s for s in load_index() if s['id'] == song_id), None)
        if rest == [] and method == 'PUT':
            entry = self.body_json()
            if entry.get('id') != song_id:
                return self.fail(400, 'id tidak cocok')
            for f in entry.get('files', []):
                if not FILE_RE.match(f.get('name', '')):
                    return self.fail(400, f"nama file tidak valid: {f.get('name')}")
            for key in ('cloud', 'remote'):
                entry.pop(key, None)
            return self.reply(200, {'dir': put_entry(entry)})
        if not found:
            return self.fail(404, 'Lagu ini tidak ada di collection.')
        folder = os.path.join(SONGS, found['dir'])
        if rest == [] and method == 'GET':
            with open(os.path.join(folder, 'entry.json'), 'rb') as f:
                return self.reply(200, f.read())
        if rest == [] and method == 'DELETE':
            with LOCK:
                shutil.rmtree(folder, ignore_errors=True)
                save_index([s for s in load_index() if s['id'] != song_id])
            return self.reply(200, {'ok': True})
        if len(rest) == 2 and rest[0] == 'files' and FILE_RE.match(rest[1]):
            path = os.path.join(folder, rest[1])
            if method == 'GET':
                return self.send_file(path)
            if method == 'PUT':
                if rest[1] not in {f['name'] for f in found.get('files', [])}:
                    return self.fail(400, 'file ini tidak terdaftar di lagu tersebut')
                return self.receive_file(path)
        self.fail(404, 'tidak ditemukan')

    def send_file(self, path):
        try:
            size = os.path.getsize(path)
            f = open(path, 'rb')
        except OSError:
            return self.fail(404, 'File belum ada di collection.')
        with f:
            self.send_response(200)
            self.cors()
            self.send_header('Content-Type', 'application/octet-stream')
            self.send_header('Content-Length', str(size))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            shutil.copyfileobj(f, self.wfile, 256 * 1024)

    def receive_file(self, path):
        length = int(self.headers.get('Content-Length') or -1)
        if length < 0:
            return self.fail(411, 'Content-Length wajib ada')
        if length > MAX_BYTES:
            return self.fail(413, f'File lebih besar dari batas {MAX_BYTES // 1024 // 1024} MB.')
        tmp = path + '.tmp'
        left = length
        with open(tmp, 'wb') as out:
            while left > 0:
                chunk = self.rfile.read(min(left, 256 * 1024))
                if not chunk:
                    break
                out.write(chunk)
                left -= len(chunk)
        if left:
            os.remove(tmp)
            return self.fail(400, 'upload terputus')
        os.replace(tmp, path)
        self.reply(200, {'ok': True, 'size': length})


def cmd_passwd(name):
    name = name.strip().lower()
    if not re.match(r'^[a-z0-9_-]{3,32}$', name):
        sys.exit('Username 3-32 karakter: huruf, angka, - atau _.')
    pw = os.environ.get('SB_PASSWORD') or getpass.getpass('Password baru: ')
    if not os.environ.get('SB_PASSWORD') and pw != getpass.getpass('Ulangi password: '):
        sys.exit('Kedua password tidak sama.')
    if len(pw) < 8:
        sys.exit('Password minimal 8 karakter.')
    os.makedirs(SONGS, exist_ok=True)
    users = read_json('users.json', {})
    users[name] = hash_password(pw)
    write_json('users.json', users)
    write_json('sessions.json', {k: v for k, v in read_json('sessions.json', {}).items() if v['user'] != name})
    print(f'Akun "{name}" tersimpan.')


def cmd_import_git(src):
    """Salin lagu dari clone repo collection GitHub (folder songs/ + index.json, file besar terpotong .partNNN)."""
    index = read_json_path(os.path.join(src, 'songs', 'index.json')).get('songs', [])
    os.makedirs(SONGS, exist_ok=True)
    done = 0
    for s in index:
        folder = os.path.join(src, 'songs', s.get('dir') or s['id'])
        entry = read_json_path(os.path.join(folder, 'entry.json'))
        if not entry:
            print('lewati (entry.json tidak ada):', s.get('title'))
            continue
        entry['files'] = [{'name': f['name'], 'size': f['size']} for f in s.get('files', [])]
        dest = os.path.join(SONGS, put_entry(entry))
        for f in s.get('files', []):
            out = os.path.join(dest, f['name'])
            with open(out, 'wb') as w:
                if f.get('parts'):
                    for k in range(f['parts']):
                        with open(os.path.join(folder, f"{f['name']}.part{k + 1:03d}"), 'rb') as r:
                            shutil.copyfileobj(r, w)
                else:
                    with open(os.path.join(folder, f['name']), 'rb') as r:
                        shutil.copyfileobj(r, w)
        done += 1
        print('ok:', song_label(s.get('artist'), s.get('title')))
    print(f'{done} lagu disalin ke {SONGS}')


def read_json_path(path):
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'serve'
    if cmd == 'passwd' and len(sys.argv) == 3:
        return cmd_passwd(sys.argv[2])
    if cmd == 'import-git' and len(sys.argv) == 3:
        return cmd_import_git(sys.argv[2])
    if cmd != 'serve':
        sys.exit(__doc__)
    os.makedirs(SONGS, exist_ok=True)
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    httpd.daemon_threads = True
    print(f'Super Band collection di {HOST}:{PORT}, data {DATA}', flush=True)
    httpd.serve_forever()


if __name__ == '__main__':
    main()
