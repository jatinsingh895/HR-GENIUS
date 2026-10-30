import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const root = fileURLToPath(new URL('.', import.meta.url));
const dataDir = join(root, 'data');
mkdirSync(dataDir, { recursive: true });
const databasePath = process.env.DATABASE_PATH || join(dataDir, 'hrgenius.sqlite');
mkdirSync(dirname(databasePath), { recursive: true });
const db = new DatabaseSync(databasePath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

const oldRecords = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='records'").get();
if (oldRecords) {
  const columns = db.prepare('PRAGMA table_info(records)').all().map(column => column.name);
  if (!columns.includes('org_id')) {
    db.exec(`ALTER TABLE records RENAME TO records_legacy;
      CREATE TABLE records (org_id TEXT NOT NULL, collection TEXT NOT NULL, record_key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(org_id, collection, record_key));
      INSERT INTO records(org_id, collection, record_key, value) SELECT 'demo', collection, record_key, value FROM records_legacy;
      DROP TABLE records_legacy;`);
  }
}
db.exec(`CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS records (
  org_id TEXT NOT NULL, collection TEXT NOT NULL, record_key TEXT NOT NULL, value TEXT NOT NULL,
  PRIMARY KEY(org_id, collection, record_key),
  FOREIGN KEY(org_id) REFERENCES organizations(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, email TEXT NOT NULL UNIQUE, full_name TEXT NOT NULL,
  password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('owner','admin','hr_manager')),
  created_at TEXT NOT NULL, FOREIGN KEY(org_id) REFERENCES organizations(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, csrf_token TEXT NOT NULL, expires_at INTEGER NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS invitations (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, email TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','hr_manager')),
  token_hash TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL, created_by TEXT NOT NULL,
  FOREIGN KEY(org_id) REFERENCES organizations(id) ON DELETE CASCADE
);`);

const collections = ['employees', 'candidates', 'reviews', 'goals', 'payruns', 'leaves', 'onboarding', 'settings'];
const seed = JSON.parse(readFileSync(join(root, 'data', 'seed.json'), 'utf8'));
const nowIso = () => new Date().toISOString();
const demoOrg = db.prepare('SELECT id FROM organizations WHERE id = ?').get('demo');
if (!demoOrg) db.prepare('INSERT INTO organizations(id,name,created_at) VALUES(?,?,?)').run('demo', 'Acme Studio', nowIso());

const statements = {
  all: db.prepare('SELECT record_key, value FROM records WHERE org_id = ? AND collection = ? ORDER BY rowid'),
  clear: db.prepare('DELETE FROM records WHERE org_id = ?'),
  insert: db.prepare('INSERT INTO records (org_id, collection, record_key, value) VALUES (?, ?, ?, ?)'),
  userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  session: db.prepare('SELECT s.csrf_token, s.expires_at, u.id, u.org_id, u.email, u.full_name, u.role, o.name AS org_name FROM sessions s JOIN users u ON u.id=s.user_id JOIN organizations o ON o.id=u.org_id WHERE s.token_hash = ?'),
  team: db.prepare('SELECT id,email,full_name,role,created_at FROM users WHERE org_id=? ORDER BY created_at'),
  inviteInfo: db.prepare('SELECT i.id,i.org_id,i.email,i.role,i.expires_at,o.name AS org_name FROM invitations i JOIN organizations o ON o.id=i.org_id WHERE token_hash=?'),
  removeInvite: db.prepare('DELETE FROM invitations WHERE id=?')
};
const recordCount = db.prepare('SELECT COUNT(*) AS count FROM records WHERE org_id = ?').get('demo').count;
if (recordCount === 0) replaceData('demo', seed);
db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
db.prepare('DELETE FROM invitations WHERE expires_at <= ?').run(Date.now());

function replaceData(orgId, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an HRGenius data object.');
  for (const collection of collections) {
    if (!Array.isArray(value[collection])) throw new Error(`The ${collection} collection must be an array.`);
    if (value[collection].length > 5000) throw new Error(`The ${collection} collection is too large.`);
  }
  const ids = new Set(), emails = new Set();
  for (const person of value.employees) {
    if (!person || typeof person.name !== 'string' || !person.name.trim() || person.name.length > 120 || typeof person.email !== 'string' || person.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(person.email.trim()) || typeof person.role !== 'string' || !person.role.trim() || person.role.length > 120 || typeof person.department !== 'string' || !person.department.trim() || person.department.length > 100 || typeof person.location !== 'string' || !person.location.trim() || person.location.length > 120 || !['Active','On leave','Inactive'].includes(person.status) || typeof person.joined !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(person.joined) || Number.isNaN(Date.parse(`${person.joined}T00:00:00Z`)) || new Date(`${person.joined}T00:00:00Z`).toISOString().slice(0,10)!==person.joined) throw new Error('Every employee must include a name, valid email, job title, department, location, start date and valid status.');
    const id = String(person.id || ''), email = person.email.trim().toLowerCase();
    if (!id || ids.has(id)) throw new Error('Employee IDs must be present and unique.');
    if (emails.has(email)) throw new Error('Employee email addresses must be unique.');
    if (!Number.isFinite(Number(person.salary)) || Number(person.salary) < 0) throw new Error(`Salary for ${person.name} must be a non-negative number.`);
    ids.add(id); emails.add(email);
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    statements.clear.run(orgId);
    for (const collection of collections) for (const [index, record] of value[collection].entries()) {
      if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error(`Invalid record in ${collection}.`);
      const key = String(record.id ?? `${record.name || record.title || 'record'}-${index}`);
      statements.insert.run(orgId, collection, key, JSON.stringify(record));
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

function readData(orgId) {
  return Object.fromEntries(collections.map(collection => [collection, statements.all.all(orgId, collection).map(row => JSON.parse(row.value))]));
}

function send(res, status, payload, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(payload));
}

async function bodyJson(req) {
  let text = '';
  for await (const part of req) { text += part; if (text.length > 5_000_000) throw Object.assign(new Error('Request body is too large.'), { status: 413 }); }
  try { return JSON.parse(text); } catch { throw Object.assign(new Error('Request body must contain valid JSON.'), { status: 400 }); }
}

const secureCookie = process.env.NODE_ENV === 'production';
const cookieName = secureCookie ? '__Host-hrgenius_session' : 'hrgenius_session';
const sessionDays = 14;
const loginAttempts = new Map();
function digest(value) { return createHash('sha256').update(value).digest('hex'); }
function cookies(req) { return Object.fromEntries((req.headers.cookie || '').split(';').map(part => part.trim().split(/=(.*)/s).slice(0, 2)).filter(([key]) => key)); }
function sessionCookie(value, maxAge = sessionDays * 86400) { return `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secureCookie ? '; Secure' : ''}`; }
function checkOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}
function enforceSameOrigin(req) {
  if (!checkOrigin(req)) throw Object.assign(new Error('This request did not come from this HRGenius site. Refresh and try again.'), { status: 403 });
}
function currentSession(req) {
  const raw = cookies(req)[cookieName];
  if (!raw) return null;
  const session = statements.session.get(digest(raw));
  if (!session || session.expires_at <= Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token_hash=?').run(digest(raw));
    return null;
  }
  return { token: raw, csrfToken: session.csrf_token, expiresAt: session.expires_at, user: { id: session.id, email: session.email, name: session.full_name, role: session.role, orgId: session.org_id, company: session.org_name } };
}
function requireSession(session) {
  if (!session) throw Object.assign(new Error('Please sign in to continue.'), { status: 401 });
  return session;
}
function requireCsrf(req, session) {
  enforceSameOrigin(req);
  if (!session || !req.headers['x-csrf-token'] || req.headers['x-csrf-token'] !== session.csrfToken) throw Object.assign(new Error('Your security token expired. Refresh the page and try again.'), { status: 403 });
}
function rateLimit(req, key) {
  const forwarded = process.env.TRUST_PROXY === '1' ? req.headers['x-forwarded-for']?.split(',')[0]?.trim() : '';
  const ip = forwarded || req.socket.remoteAddress || 'unknown';
  const now = Date.now(), bucketKey = `${key}:${ip}`;
  let bucket = loginAttempts.get(bucketKey);
  if (!bucket || bucket.until < now) bucket = { count: 0, until: now + 15 * 60_000 };
  bucket.count++;
  loginAttempts.set(bucketKey, bucket);
  if (bucket.count > 10) throw Object.assign(new Error('Too many attempts. Wait 15 minutes and try again.'), { status: 429 });
}
async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `${salt.toString('hex')}:${Buffer.from(key).toString('hex')}`;
}
async function verifyPassword(password, encoded) {
  const [saltHex, keyHex] = (encoded || '').split(':');
  if (!saltHex || !keyHex || !/^[0-9a-f]{32}$/.test(saltHex) || !/^[0-9a-f]{128}$/.test(keyHex)) return false;
  const actual = Buffer.from(await scrypt(password, Buffer.from(saltHex, 'hex'), 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }));
  return timingSafeEqual(actual, Buffer.from(keyHex, 'hex'));
}
function normalizeEmail(email) { return String(email || '').trim().toLowerCase(); }
function validateEmail(email) { return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email); }
function makeId() { return randomBytes(16).toString('hex'); }
function publicSession(user, csrfToken) { return { user, csrfToken }; }
async function createSession(userId, res) {
  const token = randomBytes(32).toString('base64url'), csrfToken = randomBytes(24).toString('base64url'), expiresAt = Date.now() + sessionDays * 86400_000;
  db.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES(?,?,?,?)').run(digest(token), userId, csrfToken, expiresAt);
  res.setHeader('Set-Cookie', sessionCookie(token));
  const row = db.prepare('SELECT u.id,u.email,u.full_name,u.role,u.org_id,o.name AS org_name FROM users u JOIN organizations o ON o.id=u.org_id WHERE u.id=?').get(userId);
  return publicSession({ id: row.id, email: row.email, name: row.full_name, role: row.role, orgId: row.org_id, company: row.org_name }, csrfToken);
}
function authResponse(session) { return session ? publicSession(session.user, session.csrfToken) : { user: null, csrfToken: null }; }

async function handleApi(req, res, url) {
  const path = url.pathname;
  if (path === '/api/health' && req.method === 'GET') return send(res, 200, { ok: true, database: 'SQLite' });
  const session = currentSession(req);
  if (path === '/api/auth/session' && req.method === 'GET') return send(res, 200, authResponse(session));
  if (path === '/api/auth/signup' && req.method === 'POST') {
    enforceSameOrigin(req); rateLimit(req, 'signup');
    const input = await bodyJson(req), name = String(input.name || '').trim(), email = normalizeEmail(input.email), company = String(input.company || '').trim(), password = String(input.password || ''), inviteToken = String(input.invite || '');
    if (name.length < 2 || name.length > 100) throw Object.assign(new Error('Enter your full name.'), { status: 400 });
    if (!validateEmail(email)) throw Object.assign(new Error('Enter a valid email address.'), { status: 400 });
    if (password.length < 12 || password.length > 200) throw Object.assign(new Error('Use a password with at least 12 characters.'), { status: 400 });
    if (statements.userByEmail.get(email)) throw Object.assign(new Error('An account with that email already exists. Sign in instead.'), { status: 409 });
    let orgId, role = 'owner';
    if (inviteToken) {
      const invite = statements.inviteInfo.get(digest(inviteToken));
      if (!invite || invite.expires_at <= Date.now()) throw Object.assign(new Error('This invitation is invalid or expired. Ask a workspace admin for a new invitation.'), { status: 400 });
      if (invite.email !== email) throw Object.assign(new Error(`This invitation is for ${invite.email}. Use that email address.`), { status: 400 });
      orgId = invite.org_id; role = invite.role;
    } else {
      if (company.length < 2 || company.length > 120) throw Object.assign(new Error('Enter your company or workspace name.'), { status: 400 });
      orgId = makeId();
    }
    const userId = makeId(), passwordHash = await hashPassword(password);
    db.exec('BEGIN IMMEDIATE');
    try {
      if (!inviteToken) db.prepare('INSERT INTO organizations(id,name,created_at) VALUES(?,?,?)').run(orgId, company, nowIso());
      db.prepare('INSERT INTO users(id,org_id,email,full_name,password_hash,role,created_at) VALUES(?,?,?,?,?,?,?)').run(userId, orgId, email, name, passwordHash, role, nowIso());
      if (inviteToken) db.prepare('DELETE FROM invitations WHERE token_hash=?').run(digest(inviteToken));
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); if (String(error.message).includes('UNIQUE')) throw Object.assign(new Error('An account with that email already exists.'), { status: 409 }); throw error; }
    return send(res, 201, await createSession(userId, res));
  }
  if (path === '/api/auth/login' && req.method === 'POST') {
    enforceSameOrigin(req); rateLimit(req, 'login');
    const input = await bodyJson(req), email = normalizeEmail(input.email), password = String(input.password || ''), user = statements.userByEmail.get(email);
    const valid = await verifyPassword(password, user?.password_hash || '');
    if (!user || !valid) throw Object.assign(new Error('Email or password is incorrect.'), { status: 401 });
    return send(res, 200, await createSession(user.id, res));
  }
  if (path === '/api/auth/password' && req.method === 'POST') {
    requireCsrf(req, session);
    const input = await bodyJson(req), currentPassword = String(input.currentPassword || ''), newPassword = String(input.newPassword || '');
    if (newPassword.length < 12 || newPassword.length > 200) throw Object.assign(new Error('Use a new password with at least 12 characters.'), { status: 400 });
    const user = db.prepare('SELECT password_hash FROM users WHERE id=?').get(session.user.id);
    if (!await verifyPassword(currentPassword, user.password_hash)) throw Object.assign(new Error('Your current password is incorrect.'), { status: 400 });
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(await hashPassword(newPassword),session.user.id);
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(session.user.id);
    return send(res,200,await createSession(session.user.id,res));
  }
  if (path.startsWith('/api/invitations/') && req.method === 'GET') {
    const raw = decodeURIComponent(path.slice('/api/invitations/'.length)), invite = statements.inviteInfo.get(digest(raw));
    if (!invite || invite.expires_at <= Date.now()) throw Object.assign(new Error('This invitation is invalid or expired.'), { status: 404 });
    return send(res, 200, { email: invite.email, role: invite.role, company: invite.org_name });
  }
  if (path === '/api/auth/logout' && req.method === 'POST') {
    requireCsrf(req, session);
    if (session) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(digest(session.token));
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
  }
  if (!session) throw Object.assign(new Error('Please sign in to continue.'), { status: 401 });
  if (path === '/api/workspace' && req.method === 'PATCH') {
    requireCsrf(req, session);
    if (!['owner','admin'].includes(session.user.role)) throw Object.assign(new Error('Only the workspace owner or an admin can rename this workspace.'), { status: 403 });
    const input = await bodyJson(req), company = String(input.company || '').trim();
    if (company.length < 2 || company.length > 120) throw Object.assign(new Error('Workspace name must be between 2 and 120 characters.'), { status: 400 });
    db.prepare('UPDATE organizations SET name=? WHERE id=?').run(company, session.user.orgId);
    return send(res, 200, { company });
  }
  if (path === '/api/data' && req.method === 'GET') return send(res, 200, readData(session.user.orgId));
  if (path === '/api/data' && req.method === 'PUT') {
    requireCsrf(req, session);
    replaceData(session.user.orgId, await bodyJson(req));
    return send(res, 200, { ok: true });
  }
  if (path === '/api/team' && req.method === 'GET') return send(res, 200, { users: statements.team.all(session.user.orgId) });
  if (path === '/api/invitations' && req.method === 'POST') {
    requireCsrf(req, session);
    const input = await bodyJson(req), email = normalizeEmail(input.email), role = input.role;
    if (!validateEmail(email)) throw Object.assign(new Error('Enter a valid email address.'), { status: 400 });
    if (!['admin','hr_manager'].includes(role)) throw Object.assign(new Error('Choose Admin or HR Manager.'), { status: 400 });
    if (role === 'admin' && !['owner','admin'].includes(session.user.role)) throw Object.assign(new Error('Only the workspace owner or an admin can invite another admin.'), { status: 403 });
    if (statements.userByEmail.get(email)) throw Object.assign(new Error('That email already has an HRGenius account.'), { status: 409 });
    const token = randomBytes(32).toString('base64url'), id = makeId(), expiresAt = Date.now() + 7 * 86400_000;
    db.prepare('DELETE FROM invitations WHERE org_id=? AND email=?').run(session.user.orgId,email);
    db.prepare('INSERT INTO invitations(id,org_id,email,role,token_hash,expires_at,created_by) VALUES(?,?,?,?,?,?,?)').run(id,session.user.orgId,email,role,digest(token),expiresAt,session.user.id);
    const base = process.env.APP_URL || `${secureCookie ? 'https' : 'http'}://${req.headers.host}`;
    return send(res,201,{email,role,expiresAt,inviteUrl:`${base.replace(/\/$/,'')}/?invite=${token}`});
  }
  const teamMatch = path.match(/^\/api\/team\/([a-f0-9]{32})$/);
  if (teamMatch && req.method === 'DELETE') {
    requireCsrf(req, session);
    if (!['owner','admin'].includes(session.user.role)) throw Object.assign(new Error('Only the workspace owner or an admin can remove team access.'), { status: 403 });
    const member = db.prepare('SELECT id,role FROM users WHERE id=? AND org_id=?').get(teamMatch[1],session.user.orgId);
    if (!member) throw Object.assign(new Error('Team member not found.'),{status:404});
    if (member.id===session.user.id) throw Object.assign(new Error('You cannot remove your own account.'),{status:400});
    if (member.role==='owner') throw Object.assign(new Error('The workspace owner cannot be removed.'),{status:400});
    db.prepare('DELETE FROM invitations WHERE created_by=?').run(member.id);
    db.prepare('DELETE FROM users WHERE id=?').run(member.id);
    return send(res,200,{ok:true});
  }
  return send(res,404,{error:'API route not found.'});
}

const publicFiles = new Set(['index.html','styles.css','auth.css','settings.css','app.js']);
const mime = { '.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8' };
const server = createServer(async (req,res) => {
  try {
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
    if (secureCookie) res.setHeader('Strict-Transport-Security','max-age=31536000; includeSubDomains');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
    const url = new URL(req.url,'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      if (!['GET','HEAD','POST','PUT','PATCH','DELETE'].includes(req.method)) return send(res,405,{error:'Method not allowed.'},{Allow:'GET, HEAD, POST, PUT, PATCH, DELETE'});
      return await handleApi(req,res,url);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res,405,{error:'Method not allowed.'},{Allow:'GET, HEAD'});
    const pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    if (!publicFiles.has(pathname.replace(/^\/+/,''))) { res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'}); return res.end('Not found'); }
    const file = normalize(join(root,pathname));
    if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'}); return res.end('Not found'); }
    res.writeHead(200,{'Content-Type':mime[extname(file)] || 'application/octet-stream','Cache-Control':'no-cache'});
    if (req.method==='HEAD') return res.end();
    createReadStream(file).pipe(res);
  } catch (error) {
    if (res.headersSent) return res.destroy(error);
    console.error(error);
    send(res,error.status || 400,{error:error.message || 'The request could not be completed.'});
  }
});

const port=Number(process.env.PORT || 3000), host=process.env.HOST || '127.0.0.1';
server.listen(port,host,()=>{console.log(`HRGenius is listening on ${host}:${port}`);console.log(`SQLite database: ${databasePath}`);console.log('Press Ctrl+C to stop the server.');});
let shuttingDown = false;
for (const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>{
  if (shuttingDown) return;
  shuttingDown = true;
  server.close(()=>{db.close();process.exit(0);});
  server.closeIdleConnections?.();
});
