'use strict';
const { config } = require('../config');
const { hashPassword, verifyPassword, burnPasswordCheck, newToken, tokenHash } = require('../auth');
const { fail } = require('../errors');
const { mediaUrl } = require('../lib');

const RESERVED = new Set(['admin', 'api', 'media', 'support', 'help', 'root', 'wesal', 'settings', 'login', 'register']);

module.exports = async function authRoutes(app) {
  const { pool, redis } = app;

  async function startSession(req, reply, userId) {
    const token = newToken();
    const expires = new Date(Date.now() + config.sessionDays * 86400_000);
    await pool.query(
      'INSERT INTO sessions (token_hash, user_id, expires_at, ip, user_agent) VALUES ($1, $2, $3, $4, $5)',
      [tokenHash(token), userId, expires, req.ip, String(req.headers['user-agent'] || '').slice(0, 300)]);
    reply.setCookie('sid', token, {
      path: '/', httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, expires,
    });
  }

  async function me(userId) {
    const { rows } = await pool.query(
      `SELECT id, name, handle, email, bio, is_private, avatar_media_id, role, created_at,
              (SELECT count(*) FROM notifications n WHERE n.user_id = u.id AND n.read_at IS NULL)::int AS unread
         FROM users u WHERE id = $1`, [userId]);
    const u = rows[0];
    if (!u) throw fail(401, 'Authentication required');
    return {
      id: u.id, name: u.name, handle: u.handle, email: u.email, bio: u.bio, private: u.is_private,
      avatar: mediaUrl(u.avatar_media_id), role: u.role, createdAt: u.created_at, unreadNotifications: u.unread,
    };
  }

  app.post('/auth/register', {
    schema: {
      body: {
        type: 'object',
        required: ['name', 'handle', 'email', 'password'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 60 },
          handle: { type: 'string', pattern: '^[A-Za-z0-9_]{3,30}$' },
          email: { type: 'string', format: 'email', maxLength: 254 },
          password: { type: 'string', minLength: 8, maxLength: 200 },
        },
      },
    },
  }, async (req, reply) => {
    const { name, handle, email, password } = req.body;
    if (RESERVED.has(handle.toLowerCase())) throw fail(409, 'Handle not available', 'handle_taken');
    const hash = await hashPassword(password);
    let id;
    try {
      ({ rows: [{ id }] } = await pool.query(
        'INSERT INTO users (name, handle, email, password_hash) VALUES ($1, $2, $3, $4) RETURNING id',
        [name.trim(), handle, email.trim().toLowerCase(), hash]));
    } catch (err) {
      if (err.code === '23505') {
        const field = String(err.constraint).includes('email') ? 'email' : 'handle';
        throw fail(409, field === 'email' ? 'Email already registered' : 'Handle not available', field + '_taken');
      }
      throw err;
    }
    await startSession(req, reply, id);
    return reply.code(201).send(await me(id));
  });

  app.post('/auth/login', {
    schema: {
      body: {
        type: 'object',
        required: ['login', 'password'],
        properties: { login: { type: 'string', minLength: 1, maxLength: 254 }, password: { type: 'string', minLength: 1, maxLength: 200 } },
      },
    },
  }, async (req, reply) => {
    const login = req.body.login.trim().toLowerCase();
    // قفل مؤقت للحساب بعد محاولات فاشلة متكررة (مقاومة تخمين كلمات المرور)
    const failKey = 'loginfail:' + login;
    const fails = Number(await redis.get(failKey).catch(() => 0)) || 0;
    if (fails >= 10) throw fail(429, 'Too many failed attempts, try again later', 'locked');
    const { rows } = await pool.query(
      'SELECT id, password_hash, status FROM users WHERE lower(email) = $1 OR lower(handle) = $1 LIMIT 1', [login]);
    const u = rows[0];
    if (!u) await burnPasswordCheck(req.body.password);
    if (!u || !(await verifyPassword(req.body.password, u.password_hash))) {
      await redis.multi().incr(failKey).expire(failKey, 900).exec().catch(() => {});
      throw fail(401, 'Invalid credentials', 'invalid_credentials');
    }
    if (u.status !== 'active') throw fail(403, 'Account suspended', 'suspended');
    redis.del(failKey).catch(() => {});
    await startSession(req, reply, u.id);
    return me(u.id);
  });

  app.post('/auth/logout', async (req, reply) => {
    const token = req.cookies.sid;
    if (token) {
      const hash = tokenHash(token);
      await pool.query('DELETE FROM sessions WHERE token_hash = $1', [hash]);
      await redis.del('sess:' + hash.toString('hex')).catch(() => {});
    }
    reply.clearCookie('sid', { path: '/' });
    return { ok: true };
  });

  // تسجيل الخروج من كل الأجهزة
  app.post('/auth/logout-all', { preHandler: app.requireUser }, async (req, reply) => {
    const { rows } = await pool.query('DELETE FROM sessions WHERE user_id = $1 RETURNING token_hash', [req.user.id]);
    if (rows.length) await redis.del(...rows.map((r) => 'sess:' + r.token_hash.toString('hex'))).catch(() => {});
    reply.clearCookie('sid', { path: '/' });
    return { ok: true };
  });

  app.post('/auth/password', {
    preHandler: app.requireUser,
    schema: {
      body: {
        type: 'object', required: ['current', 'next'],
        properties: { current: { type: 'string', maxLength: 200 }, next: { type: 'string', minLength: 8, maxLength: 200 } },
      },
    },
  }, async (req, reply) => {
    const { rows: [u] } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    if (!(await verifyPassword(req.body.current, u.password_hash))) throw fail(401, 'Invalid credentials', 'invalid_credentials');
    await pool.query('UPDATE users SET password_hash = $2 WHERE id = $1', [req.user.id, await hashPassword(req.body.next)]);
    const { rows } = await pool.query('DELETE FROM sessions WHERE user_id = $1 RETURNING token_hash', [req.user.id]);
    if (rows.length) await redis.del(...rows.map((r) => 'sess:' + r.token_hash.toString('hex'))).catch(() => {});
    await startSession(req, reply, req.user.id);
    return { ok: true };
  });

  app.get('/auth/me', { preHandler: app.requireUser }, async (req) => me(req.user.id));
  app.decorate('loadMe', me);
};
