// Collection pribadi di repo GitHub private.
//
// - Lagu disimpan di repo private milik user (songs/<id>/entry.json + file audio, plus songs/index.json).
// - Login pakai username + password: token GitHub dienkripsi dengan password (PBKDF2 + AES-GCM)
//   dan disimpan sebagai vault/<username>.json di repo game ini, supaya bisa dibuka dari device mana pun.
//   Yang tersimpan di repo publik hanya hasil enkripsi; tanpa password token-nya tidak bisa dibaca.

export const GAME_REPO = 'zenaki/Super-Band';
const API = 'https://api.github.com';
const SESSION_KEY = 'superband.cloud.v1';
const PBKDF2_ITER = 600000;
const MAX_FILE = 95 * 1024 * 1024; // batas GitHub 100 MB per file

// ---------------------------------------------------------------------
// kripto

const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (bytes) => {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(s);
};
const unb64 = (str) => Uint8Array.from(atob(str.replace(/\s/g, '')), (c) => c.charCodeAt(0));

async function deriveKey(password, salt, iter) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function sealVault(username, password, secret) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(`${username.toLowerCase()}\n${password}`, salt, PBKDF2_ITER);
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(secret))));
  return { v: 1, kdf: 'PBKDF2-SHA256', iter: PBKDF2_ITER, salt: b64(salt), iv: b64(iv), data: b64(data) };
}

export async function openVault(username, password, vault) {
  const key = await deriveKey(`${username.toLowerCase()}\n${password}`, unb64(vault.salt), vault.iter);
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(vault.iv) }, key, unb64(vault.data));
    return JSON.parse(dec.decode(plain));
  } catch (err) {
    throw new Error('Username atau password salah.');
  }
}

// ---------------------------------------------------------------------
// GitHub API

export class GitHub {
  constructor(token) {
    this.token = token;
  }

  async req(path, opts = {}) {
    const res = await fetch(path.startsWith('http') ? path : API + path, {
      ...opts,
      headers: {
        Accept: opts.accept || 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      },
      cache: 'no-store',
    });
    if (!res.ok) {
      let msg = '';
      try {
        msg = (await res.json()).message || '';
      } catch (err) {
        /* bukan json */
      }
      const e = new Error(explain(res.status, msg));
      e.status = res.status;
      throw e;
    }
    return res;
  }

  async json(path, opts) {
    return (await this.req(path, opts)).json();
  }

  async user() {
    return this.json('/user');
  }

  async repo(full) {
    return this.json(`/repos/${full}`);
  }

  // isi file sebagai Uint8Array, atau null kalau tidak ada
  async read(full, path) {
    try {
      const res = await this.req(`/repos/${full}/contents/${encodePath(path)}`, { accept: 'application/vnd.github.raw+json' });
      return new Uint8Array(await res.arrayBuffer());
    } catch (err) {
      if (err.status === 404) return null;
      throw err;
    }
  }

  async readJson(full, path) {
    const bytes = await this.read(full, path);
    return bytes ? JSON.parse(dec.decode(bytes)) : null;
  }

  // Satu commit berisi banyak perubahan. changes: [{ path, data: Uint8Array|string|null }] (null = hapus)
  async commit(full, message, changes, onProgress) {
    let ref = await this.ref(full);
    if (!ref) {
      // Repo kosong: Git Data API (blob/tree) ditolak GitHub dengan 409 sampai ada commit pertama.
      // Contents API boleh dipakai di repo kosong, jadi buat README dulu lewat situ.
      await this.req(`/repos/${full}/contents/README.md`, {
        method: 'PUT',
        body: JSON.stringify({ message: 'init collection', content: b64(enc.encode('# Super Band collection\n\nIsi repo ini dikelola oleh game Super Band.\n')) }),
      });
      ref = await this.ref(full);
      if (!ref) throw new Error('Repo collection belum bisa diinisialisasi, coba lagi sebentar.');
    }
    const tree = [];
    let done = 0;
    for (const ch of changes) {
      if (ch.data === null) {
        tree.push({ path: ch.path, mode: '100644', type: 'blob', sha: null });
      } else if (ch.sha) {
        // file yang sudah ada di repo, cukup dipindah tanpa upload ulang
        tree.push({ path: ch.path, mode: '100644', type: 'blob', sha: ch.sha });
      } else {
        const bytes = typeof ch.data === 'string' ? enc.encode(ch.data) : ch.data;
        if (bytes.length > MAX_FILE) throw new Error(`File ${ch.path.split('/').pop()} lebih dari 95 MB, GitHub tidak menerima file sebesar itu.`);
        const blob = await this.json(`/repos/${full}/git/blobs`, { method: 'POST', body: JSON.stringify({ content: b64(bytes), encoding: 'base64' }) });
        tree.push({ path: ch.path, mode: '100644', type: 'blob', sha: blob.sha });
      }
      done++;
      if (onProgress) onProgress(done / (changes.length + 1), ch.path.split('/').pop());
    }
    for (let attempt = 0; ; attempt++) {
      try {
        await this.writeCommit(full, message, tree, ref);
        break;
      } catch (err) {
        // ada commit lain yang masuk duluan: ulangi di atas commit terbaru (blob tidak di-upload ulang)
        if (attempt >= 3 || !(err.status === 422 || err.status === 409)) throw err;
        ref = await this.ref(full);
      }
    }
    if (onProgress) onProgress(1);
  }

  async writeCommit(full, message, tree, ref) {
    const body = { tree };
    if (ref) body.base_tree = ref.tree;
    const newTree = await this.json(`/repos/${full}/git/trees`, { method: 'POST', body: JSON.stringify(body) });
    const commit = await this.json(`/repos/${full}/git/commits`, {
      method: 'POST',
      body: JSON.stringify({ message, tree: newTree.sha, parents: ref ? [ref.commit] : [] }),
    });
    if (ref) {
      await this.req(`/repos/${full}/git/refs/heads/${ref.branch}`, { method: 'PATCH', body: JSON.stringify({ sha: commit.sha }) });
    } else {
      await this.req(`/repos/${full}/git/refs`, { method: 'POST', body: JSON.stringify({ ref: 'refs/heads/main', sha: commit.sha }) });
    }
  }

  // semua file di repo: [{ path, sha }]
  async files(full) {
    const ref = await this.ref(full);
    if (!ref) return [];
    const t = await this.json(`/repos/${full}/git/trees/${ref.tree}?recursive=1`);
    return t.tree.filter((x) => x.type === 'blob').map((x) => ({ path: x.path, sha: x.sha }));
  }

  async ref(full) {
    const info = await this.repo(full);
    const branch = info.default_branch || 'main';
    try {
      const r = await this.json(`/repos/${full}/git/ref/heads/${branch}`);
      const c = await this.json(`/repos/${full}/git/commits/${r.object.sha}`);
      return { branch, commit: r.object.sha, tree: c.tree.sha };
    } catch (err) {
      if (err.status === 404 || err.status === 409) return null; // repo masih kosong
      throw err;
    }
  }
}

function encodePath(p) {
  return p.split('/').map(encodeURIComponent).join('/');
}

function explain(status, msg) {
  if (status === 401) return 'Token GitHub tidak valid atau sudah kedaluwarsa.';
  if (status === 403 && /rate limit/i.test(msg)) return 'Batas akses GitHub tercapai, coba lagi beberapa menit lagi.';
  if (status === 403) return `Token tidak punya izin untuk aksi ini (${msg || 'forbidden'}). Pastikan izin Contents: Read and write.`;
  if (status === 404) return 'Repo atau file tidak ditemukan. Cek nama repo dan izin token.';
  if (status === 422) return `GitHub menolak permintaan: ${msg}`;
  return `GitHub error ${status}${msg ? `: ${msg}` : ''}`;
}

// ---------------------------------------------------------------------
// sesi login

function loadSession() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY)) || null;
  } catch (err) {
    return null;
  }
}

let writeLock = Promise.resolve();
// semua perubahan ke repo collection dijalankan satu per satu supaya commit tidak saling tabrak
function exclusive(fn) {
  const run = writeLock.then(fn, fn);
  writeLock = run.catch(() => {});
  return run;
}

export const cloud = {
  session: loadSession(), // { username, token, repo }
  index: null, // daftar lagu di collection
  gh: null,

  get loggedIn() {
    return !!(this.session && this.session.token);
  },

  client() {
    if (!this.gh || this.gh.token !== this.session.token) this.gh = new GitHub(this.session.token);
    return this.gh;
  },

  saveSession(s) {
    this.session = s;
    this.index = null;
    try {
      if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
      else localStorage.removeItem(SESSION_KEY);
    } catch (err) {
      /* private mode */
    }
  },

  logout() {
    this.saveSession(null);
  },

  // Setup pertama: cek token & repo, simpan vault terenkripsi ke repo game.
  async setup({ username, password, token, repo }) {
    if (!/^[a-z0-9_-]{3,32}$/i.test(username)) throw new Error('Username 3–32 karakter: huruf, angka, - atau _.');
    if (password.length < 12) throw new Error('Password minimal 12 karakter, karena file login-nya bisa dilihat publik dalam bentuk terenkripsi.');
    repo = repo.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, '');
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Nama repo harus dalam format pemilik/nama-repo.');
    const gh = new GitHub(token.trim());
    const info = await gh.repo(repo);
    if (!info.private) throw new Error(`Repo ${repo} masih public. Jadikan private dulu supaya collection kamu tidak bisa dilihat orang.`);
    if (info.permissions && !info.permissions.push) throw new Error(`Token tidak punya izin menulis ke ${repo}.`);
    const vault = await sealVault(username, password, { token: token.trim(), repo });
    const path = `vault/${username.toLowerCase()}.json`;
    await gh.commit(GAME_REPO, `chore: login collection ${username}`, [{ path, data: `${JSON.stringify(vault, null, 2)}\n` }]);
    this.saveSession({ username, token: token.trim(), repo });
    return { repo };
  },

  // Login dari device mana pun: ambil vault publik lalu buka dengan password.
  async login(username, password) {
    const name = username.trim().toLowerCase();
    if (!name) throw new Error('Isi username dulu.');
    let vault = null;
    try {
      const res = await fetch(`vault/${encodeURIComponent(name)}.json`, { cache: 'no-store' });
      if (res.ok) vault = await res.json();
    } catch (err) {
      /* coba lewat API */
    }
    if (!vault) {
      // GitHub Pages butuh 1–2 menit untuk update; API langsung terbaca
      const res = await fetch(`${API}/repos/${GAME_REPO}/contents/vault/${encodeURIComponent(name)}.json`, {
        headers: { Accept: 'application/vnd.github.raw+json' },
        cache: 'no-store',
      });
      if (res.ok) vault = await res.json();
    }
    if (!vault) throw new Error('Username atau password salah.');
    const secret = await openVault(name, password, vault);
    this.saveSession({ username: name, token: secret.token, repo: secret.repo });
    await this.client().repo(secret.repo); // pastikan token masih berlaku
  },

  async fetchIndex(force = false) {
    if (!this.loggedIn) return [];
    if (this.index && !force) return this.index;
    const data = await this.client().readJson(this.session.repo, 'songs/index.json');
    this.index = (data && data.songs) || [];
    if (this.index.some((x) => !x.dir)) await exclusive(() => this.migrateDirs());
    return this.index;
  },

  // Collection versi 1.6.x memakai id sebagai nama folder. Pindahkan ke "Artis - Judul".
  async migrateDirs() {
    const gh = this.client();
    const fresh = await gh.readJson(this.session.repo, 'songs/index.json');
    this.index = (fresh && fresh.songs) || [];
    if (!this.index.some((x) => !x.dir)) return;
    const all = await gh.files(this.session.repo);
    const changes = [];
    const next = [];
    for (const s of this.index) {
      if (s.dir) {
        next.push(s);
        continue;
      }
      const dir = uniqueDir(songLabel(s.artist, s.title), next.concat(this.index.filter((x) => x.dir)));
      for (const f of all.filter((x) => x.path.startsWith(`songs/${s.id}/`))) {
        changes.push({ path: `songs/${dir}/${f.path.slice(`songs/${s.id}/`.length)}`, sha: f.sha });
        changes.push({ path: f.path, data: null });
      }
      next.push({ ...s, dir });
    }
    changes.push({ path: 'songs/index.json', data: indexJson(next) });
    await gh.commit(this.session.repo, 'rapikan nama folder lagu', changes);
    this.index = next;
  },

  dirOf(id) {
    const s = (this.index || []).find((x) => x.id === id);
    return s && s.dir ? s.dir : id;
  },

  async fetchEntry(id) {
    await this.fetchIndex();
    return this.client().readJson(this.session.repo, `songs/${this.dirOf(id)}/entry.json`);
  },

  async fetchFile(id, name) {
    await this.fetchIndex();
    return this.client().read(this.session.repo, `songs/${this.dirOf(id)}/${name}`);
  },

  summary(entry, dir) {
    return {
      id: entry.id,
      dir,
      source: entry.source,
      title: entry.song.meta.title,
      artist: entry.song.meta.artist,
      addedAt: entry.addedAt,
      files: entry.files || [],
    };
  },

  // files: [{ name, blob }] yang ikut di-upload (null = pakai yang sudah ada di collection)
  upload(entry, files, onProgress) {
    return exclusive(() => this.uploadNow(entry, files, onProgress));
  },

  async uploadNow(entry, files, onProgress) {
    const index = await this.fetchIndex(true);
    const existing = index.find((s) => s.id === entry.id);
    const others = index.filter((s) => s.id !== entry.id);
    const dir = existing && existing.dir ? existing.dir : uniqueDir(songLabel(entry.song.meta.artist, entry.song.meta.title), others);
    const changes = [];
    const meta = { ...entry };
    delete meta.cloud;
    delete meta.remote;
    changes.push({ path: `songs/${dir}/entry.json`, data: JSON.stringify(meta) });
    for (const f of files || []) changes.push({ path: `songs/${dir}/${f.name}`, data: new Uint8Array(await f.blob.arrayBuffer()) });
    const next = [this.summary(entry, dir), ...others];
    changes.push({ path: 'songs/index.json', data: indexJson(next) });
    const label = songLabel(entry.song.meta.artist, entry.song.meta.title);
    await this.client().commit(this.session.repo, `${existing ? 'ubah' : 'tambah'} lagu: ${label}`, changes, onProgress);
    this.index = next;
  },

  remove(entry) {
    return exclusive(() => this.removeNow(entry));
  },

  async removeNow(entry) {
    const index = await this.fetchIndex(true);
    const found = index.find((s) => s.id === entry.id);
    if (!found) return;
    const dir = found.dir || found.id;
    const changes = [{ path: `songs/${dir}/entry.json`, data: null }];
    for (const f of found.files || []) changes.push({ path: `songs/${dir}/${f.name}`, data: null });
    const next = index.filter((s) => s.id !== entry.id);
    changes.push({ path: 'songs/index.json', data: indexJson(next) });
    await this.client().commit(this.session.repo, `hapus lagu: ${songLabel(found.artist, found.title)}`, changes);
    this.index = next;
  },

};

// ---------------------------------------------------------------------
// nama folder di repo collection

export function songLabel(artist, title) {
  const a = (artist || '').trim();
  const t = (title || 'Untitled').trim();
  return a && a.toLowerCase() !== 'unknown' ? `${a} - ${t}` : t;
}

export function safeDir(label) {
  const clean = label
    .replace(/[\\/:*?"<>|#%{}^~[\]`]+/g, ' ')
    .replace(/[\u0000-\u001f]+/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '');
  return clean.slice(0, 90).trim() || 'Untitled';
}

function uniqueDir(label, taken) {
  const used = new Set(taken.map((x) => (x.dir || x.id).toLowerCase()));
  const base = safeDir(label);
  let dir = base;
  for (let n = 2; used.has(dir.toLowerCase()); n++) dir = `${base} (${n})`;
  return dir;
}

function indexJson(songs) {
  return `${JSON.stringify({ v: 2, songs }, null, 1)}\n`;
}
