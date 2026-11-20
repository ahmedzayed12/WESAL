'use strict';
// اختبارات تكامل على PostgreSQL وRedis حقيقيين.
// المتغيرات: TEST_DATABASE_URL و TEST_REDIS_URL (القيم الافتراضية للتشغيل المحلي).
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wesal-test-'));
process.env.UPLOAD_DIR = uploadDir;
process.env.STORAGE_DRIVER = 'local';
process.env.RATE_LIMIT_ENABLED = 'false';
process.env.APP_ORIGIN = 'http://localhost:3000';
process.env.LOG_LEVEL = 'silent';

const Redis = require('ioredis');
const { Pool } = require('pg');
const { config } = require('../src/config');
const { createStorage } = require('../src/storage');
const { buildApp } = require('../src/app');
const { migrate } = require('../src/migrate');

const DB = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/wesal_test';
const REDIS = process.env.TEST_REDIS_URL || 'redis://127.0.0.1:6379/15';

async function setup() {
  const pool = new Pool({ connectionString: DB, max: 10 });
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(pool, () => {});
  const redis = new Redis(REDIS);
  await redis.flushdb();
  const storage = createStorage(config.storage);
  const app = buildApp({ pool, redis, storage, logger: false });
  await app.ready();
  const close = async () => { await app.close(); await pool.end(); redis.disconnect(); fs.rmSync(uploadDir, { recursive: true, force: true }); };
  return { app, pool, redis, storage, close };
}

// عميل بسيط يحمل كعكة الجلسة مثل المتصفح
function client(app) {
  let cookie = '';
  const c = async (method, url, body, extraHeaders = {}) => {
    const headers = { 'x-requested-with': 'fetch', ...extraHeaders };
    if (cookie) headers.cookie = cookie;
    const opts = { method, url, headers };
    if (body !== undefined) {
      if (Buffer.isBuffer(body)) opts.payload = body;
      else opts.payload = body;
    }
    const res = await app.inject(opts);
    const set = res.headers['set-cookie'];
    if (set) {
      const m = String(Array.isArray(set) ? set[0] : set).match(/sid=([^;]*)/);
      if (m) cookie = m[1] ? 'sid=' + m[1] : '';
    }
    let json = null;
    try { json = res.json(); } catch { /* ليس JSON */ }
    return { status: res.statusCode, body: json, headers: res.headers, raw: res };
  };
  c.cookie = () => cookie;
  return c;
}

async function registerUser(app, handle, extra = {}) {
  const c = client(app);
  const r = await c('POST', '/api/v1/auth/register', { name: handle.toUpperCase(), handle, email: `${handle}@example.com`, password: 'correct horse battery', ...extra });
  if (r.status !== 201) throw new Error('register failed: ' + JSON.stringify(r.body));
  c.user = r.body;
  return c;
}

const PNG = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(24)]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(20)]);

async function uploadMedia(c, bytes, mime) {
  const start = await c('POST', '/api/v1/media/uploads', { mime, size: bytes.length });
  if (start.status !== 201) throw new Error('upload start failed: ' + JSON.stringify(start.body));
  const put = await c('PUT', start.body.upload.url, bytes, { 'content-type': mime });
  if (put.status !== 200) throw new Error('upload put failed: ' + JSON.stringify(put.body));
  const done = await c('POST', `/api/v1/media/${start.body.id}/complete`);
  if (done.status !== 200) throw new Error('upload complete failed: ' + JSON.stringify(done.body));
  return done.body;
}

module.exports = { setup, client, registerUser, uploadMedia, PNG, MP4 };
