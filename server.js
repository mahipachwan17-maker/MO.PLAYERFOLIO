const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { DatabaseSync } = require('node:sqlite'); // built into Node, no extra install needed
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- Folders ----------
const DATA_DIR = process.env.DATA_DIR || __dirname;
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------- Database ----------
const db = new DatabaseSync(path.join(DATA_DIR, 'MO.PLAYERFOLIO.db'));
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'player',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER UNIQUE NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  name TEXT DEFAULT '',
  photo TEXT DEFAULT '',
  position TEXT DEFAULT '',
  age TEXT DEFAULT '',
  weight_kg TEXT DEFAULT '',
  height_cm TEXT DEFAULT '',
  foot TEXT DEFAULT '',
  jersey TEXT DEFAULT '',
  whatsapp TEXT DEFAULT '',
  whatsapp_msg TEXT DEFAULT 'Hello, I saw your profile and would like to connect.',
  instagram TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  email TEXT DEFAULT '',
  location TEXT DEFAULT '',
  cv_pdf TEXT DEFAULT '',
  highlights TEXT DEFAULT '',
  career TEXT DEFAULT '',
  achievements TEXT DEFAULT '',
  strengths TEXT DEFAULT '',
  template TEXT DEFAULT 'classic',
  FOREIGN KEY (user_id) REFERENCES users(id)
);
`);

// ---------- First admin ----------
// Pehli baar chalane par admin banta hai. Password turant badal lena.
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'ChangeMe123!';
if (!db.prepare('SELECT id FROM users WHERE role = ?').get('admin')) {
  db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
    .run(ADMIN_USER, bcrypt.hashSync(ADMIN_PASS, 10), 'admin');
  console.log('Admin created. Username:', ADMIN_USER);
}

// ---------- App setup ----------
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use('/static', express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOAD_DIR));
app.use(session({
  secret: process.env.SESSION_SECRET || 'change-this-secret-please',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 }
}));

// ---------- Upload handling ----------
const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, Date.now() + '-' + Math.round(Math.random() * 1e6) + ext);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const ok = ['.jpg', '.jpeg', '.png', '.webp', '.pdf'];
    if (ok.includes(ext)) cb(null, true);
    else cb(new Error('Only JPG, PNG, WEBP or PDF allowed'));
  }
});
const fileFields = upload.fields([{ name: 'photo', maxCount: 1 }, { name: 'cv_pdf', maxCount: 1 }]);

// ---------- Helpers ----------
const TEMPLATES = ['classic', 'bold', 'minimal', 'card'];

function makeSlug(text) {
  const base = (text || 'player').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'player';
  let slug = base, n = 1;
  while (db.prepare('SELECT id FROM profiles WHERE slug = ?').get(slug)) {
    n += 1;
    slug = base + '-' + n;
  }
  return slug;
}

function safeUrl(u) {
  u = (u || '').trim();
  return /^https?:\/\//i.test(u) ? u : '';
}

function youtubeEmbed(url) {
  if (!url) return '';
  const m = url.match(/(?:youtu\.be\/|v=|embed\/|shorts\/)([A-Za-z0-9_-]{11})/);
  return m ? 'https://www.youtube.com/embed/' + m[1] : '';
}

function instagramUrl(v) {
  v = (v || '').trim();
  if (!v) return '';
  if (/^https?:\/\//i.test(v)) return v;
  return 'https://instagram.com/' + v.replace('@', '');
}

function digits(v) {
  return (v || '').replace(/[^0-9]/g, '');
}

function lines(t) {
  return (t || '').split('\n').map((s) => s.trim()).filter(Boolean);
}

// Saare buttons ke links yahin ban jate hain
function buildLinks(p) {
  const waNum = digits(p.whatsapp);
  const tel = (p.phone || '').replace(/[^0-9+]/g, '');
  let map = '';
  if (p.location) {
    map = /^https?:\/\//i.test(p.location.trim())
      ? p.location.trim()
      : 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(p.location);
  }
  return {
    wa: waNum ? 'https://wa.me/' + waNum + '?text=' + encodeURIComponent(p.whatsapp_msg || '') : '',
    ig: instagramUrl(p.instagram),
    tel: tel ? 'tel:' + tel : '',
    mail: p.email ? 'mailto:' + p.email.trim() : '',
    map,
    cv: p.cv_pdf ? '/uploads/' + p.cv_pdf : '',
    yt: safeUrl(p.highlights)
  };
}

function requireLogin(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
  if (!u || !u.active) {
    req.session.destroy(() => res.redirect('/login?msg=deactivated'));
    return;
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user || req.session.user.role !== 'admin') return res.status(403).send('Admin only');
  next();
}

app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  next();
});

// Profile save ka common code (player aur admin dono use karte hain)
function saveProfile(userId, req) {
  const cur = db.prepare('SELECT * FROM profiles WHERE user_id = ?').get(userId);
  if (!cur) return false;
  const b = req.body;
  const photo = req.files && req.files.photo ? req.files.photo[0].filename : cur.photo;
  const cv = req.files && req.files.cv_pdf ? req.files.cv_pdf[0].filename : cur.cv_pdf;
  const tpl = TEMPLATES.includes(b.template) ? b.template : cur.template;
  db.prepare(`UPDATE profiles SET
    name=?, photo=?, position=?, age=?, weight_kg=?, height_cm=?, foot=?, jersey=?,
    whatsapp=?, whatsapp_msg=?, instagram=?, phone=?, email=?, location=?,
    cv_pdf=?, highlights=?, career=?, achievements=?, strengths=?, template=?
    WHERE user_id=?`).run(
    b.name || '', photo, b.position || '', b.age || '', b.weight_kg || '', b.height_cm || '', b.foot || '', b.jersey || '',
    b.whatsapp || '', b.whatsapp_msg || '', b.instagram || '', b.phone || '', b.email || '', b.location || '',
    cv, b.highlights || '', b.career || '', b.achievements || '', b.strengths || '', tpl,
    userId
  );
  return true;
}

// ---------- Public routes ----------
app.get('/', (req, res) => {
  if (req.session.user) {
    return res.redirect(req.session.user.role === 'admin' ? '/admin' : '/dashboard');
  }
  res.render('home');
});

app.get('/login', (req, res) => {
  res.render('login', { error: null, msg: req.query.msg || null });
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get((username || '').trim());
  if (!u || !bcrypt.compareSync(password || '', u.password_hash)) {
    return res.render('login', { error: 'Wrong username or password', msg: null });
  }
  if (!u.active) {
    return res.render('login', { error: 'This account is deactivated. Contact the admin.', msg: null });
  }
  req.session.user = { id: Number(u.id), username: u.username, role: u.role };
  res.redirect(u.role === 'admin' ? '/admin' : '/dashboard');
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// NFC tag mein ye link likhna hai: /p/player-ka-slug  (login ki zaroorat nahi, sirf dekh sakte hain)
app.get('/p/:slug', (req, res) => {
  const p = db.prepare(`
    SELECT profiles.*, users.active AS active FROM profiles
    JOIN users ON users.id = profiles.user_id
    WHERE profiles.slug = ?`).get(req.params.slug);
  if (!p) return res.status(404).render('notfound');
  if (!p.active) return res.status(410).render('inactive');
  const tpl = TEMPLATES.includes(p.template) ? p.template : 'classic';
  const L = buildLinks(p);
  res.render('profile_' + tpl, {
    p, L, lines,
    embed: youtubeEmbed(p.highlights),
    pageTitle: (p.name || 'Player') + ' | MO.PLAYERFOLIO'
  });
});

// ---------- Player routes ----------
app.get('/dashboard', requireLogin, (req, res) => {
  if (req.session.user.role === 'admin') return res.redirect('/admin');
  const p = db.prepare('SELECT * FROM profiles WHERE user_id = ?').get(req.session.user.id);
  res.render('dashboard', { p, templates: TEMPLATES, saved: req.query.saved === '1', error: req.query.error || null });
});

app.post('/dashboard', requireLogin, (req, res) => {
  if (req.session.user.role === 'admin') return res.redirect('/admin');
  fileFields(req, res, (err) => {
    if (err) return res.redirect('/dashboard?error=' + encodeURIComponent(err.message));
    saveProfile(req.session.user.id, req);
    res.redirect('/dashboard?saved=1');
  });
});

// ---------- Admin routes ----------
app.get('/admin', requireLogin, requireAdmin, (req, res) => {
  const players = db.prepare(`
    SELECT users.id, users.username, users.active, users.created_at, profiles.slug, profiles.name
    FROM users LEFT JOIN profiles ON profiles.user_id = users.id
    WHERE users.role = 'player' ORDER BY users.id DESC`).all();
  res.render('admin', { players, error: req.query.error || null, ok: req.query.ok || null });
});

app.post('/admin/create', requireLogin, requireAdmin, (req, res) => {
  const username = (req.body.username || '').trim();
  const password = req.body.password || '';
  const name = (req.body.name || '').trim();
  if (username.length < 3 || password.length < 6) {
    return res.redirect('/admin?error=' + encodeURIComponent('Username 3+ and password 6+ characters needed'));
  }
  if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) {
    return res.redirect('/admin?error=' + encodeURIComponent('Username already taken'));
  }
  const info = db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
    .run(username, bcrypt.hashSync(password, 10), 'player');
  db.prepare('INSERT INTO profiles (user_id, slug, name) VALUES (?, ?, ?)')
    .run(Number(info.lastInsertRowid), makeSlug(name || username), name);
  res.redirect('/admin?ok=' + encodeURIComponent('Player account created'));
});

app.post('/admin/toggle/:id', requireLogin, requireAdmin, (req, res) => {
  db.prepare("UPDATE users SET active = 1 - active WHERE id = ? AND role = 'player'").run(req.params.id);
  res.redirect('/admin?ok=' + encodeURIComponent('Account status changed'));
});

app.post('/admin/password/:id', requireLogin, requireAdmin, (req, res) => {
  const pw = req.body.password || '';
  if (pw.length < 6) return res.redirect('/admin?error=' + encodeURIComponent('Password must be 6+ characters'));
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ? AND role = 'player'")
    .run(bcrypt.hashSync(pw, 10), req.params.id);
  res.redirect('/admin?ok=' + encodeURIComponent('Password changed'));
});

app.post('/admin/delete/:id', requireLogin, requireAdmin, (req, res) => {
  const u = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'player'").get(req.params.id);
  if (u) {
    db.prepare('DELETE FROM profiles WHERE user_id = ?').run(req.params.id);
    db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  }
  res.redirect('/admin?ok=' + encodeURIComponent('Player deleted'));
});

// Admin kisi bhi player ka profile edit kar sakta hai
app.get('/admin/edit/:id', requireLogin, requireAdmin, (req, res) => {
  const p = db.prepare('SELECT * FROM profiles WHERE user_id = ?').get(req.params.id);
  if (!p) return res.redirect('/admin');
  res.render('dashboard', {
    p, templates: TEMPLATES,
    saved: req.query.saved === '1', error: req.query.error || null,
    adminEditId: req.params.id
  });
});

app.post('/admin/edit/:id', requireLogin, requireAdmin, (req, res) => {
  fileFields(req, res, (err) => {
    if (err) return res.redirect('/admin/edit/' + req.params.id + '?error=' + encodeURIComponent(err.message));
    if (!saveProfile(req.params.id, req)) return res.redirect('/admin');
    res.redirect('/admin/edit/' + req.params.id + '?saved=1');
  });
});

app.listen(PORT, () => console.log('MO.PLAYERFOLIO running: http://localhost:' + PORT));
