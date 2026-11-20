'use strict';
const path = require('node:path');
const Fastify = require('fastify');
const { config } = require('./config');
const { tokenHash } = require('./auth');
const { fail } = require('./errors');

const SESSION_CACHE_TTL = 300; // ثوانٍ

function buildApp({ pool, redis, storage, logger = true }) {
  const app = Fastify({
    logger: logger && {
      level: config.logLevel,
      redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
    },
    trustProxy: config.trustProxy,
    bodyLimit: 256 * 1024, // الطلبات JSON صغيرة؛ الوسائط لا تمر عبر JSON إطلاقًا
    requestIdHeader: 'x-request-id',
    ajv: { customOptions: { removeAdditional: true, coerceTypes: 'array', useDefaults: true, allErrors: false } },
  });

  app.decorate('pool', pool);
  app.decorate('redis', redis);
  app.decorate('storage', storage);
  app.decorateRequest('user', null);

  app.register(require('@fastify/cookie'));
  app.register(require('@fastify/static'), {
    root: path.join(__dirname, '..', 'public'),
    wildcard: false,
    maxAge: config.production ? '1h' : 0,
  });

  // ترويسات أمان على كل الردود
  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'strict-origin-when-cross-origin');
    reply.header('x-frame-options', 'DENY');
    reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    if (config.cookieSecure) reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    const type = String(reply.getHeader('content-type') || '');
    if (type.startsWith('text/html')) {
      const mediaSrc = storage.driver === 's3' && config.storage.publicEndpoint ? ` ${new URL(config.storage.publicEndpoint).origin}` : '';
      reply.header('content-security-policy',
        `default-src 'self'; img-src 'self' blob: data:${mediaSrc}; media-src 'self' blob:${mediaSrc}; connect-src 'self'${mediaSrc}; ` +
        "style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    }
    if (req.url.startsWith('/api/') && !reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
    return payload;
  });

  // حماية CSRF: الطلبات المعدِّلة يجب أن تأتي من أصل مسموح وتحمل ترويسة مخصصة
  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/api/') || ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
    const origin = req.headers.origin;
    if (origin && !config.appOrigins.includes(origin)) throw fail(403, 'Origin not allowed', 'bad_origin');
    if (req.headers['x-requested-with'] !== 'fetch') throw fail(403, 'Missing X-Requested-With header', 'csrf');
  });

  // المصادقة عبر كعكة الجلسة (httpOnly) مع تخزين مؤقت في Redis
  app.addHook('onRequest', async (req) => {
    const token = req.cookies?.sid;
    if (!token || token.length > 100) return;
    const hash = tokenHash(token);
    const cacheKey = 'sess:' + hash.toString('hex');
    let cached = null;
    try { cached = await redis.get(cacheKey); } catch (err) { req.log.warn({ err }, 'redis unavailable for session cache'); }
    if (cached) {
      if (cached !== '-') req.user = JSON.parse(cached);
      return;
    }
    const { rows } = await pool.query(
      `SELECT u.id, u.role, u.status FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > now()`, [hash]);
    const u = rows[0] && rows[0].status === 'active' ? { id: rows[0].id, role: rows[0].role } : null;
    redis.set(cacheKey, u ? JSON.stringify(u) : '-', 'EX', SESSION_CACHE_TTL).catch(() => {});
    req.user = u;
  });

  // تحديد معدل الطلبات (نافذة ثابتة في Redis، مشتركة بين كل نسخ الخادم)
  app.addHook('onRequest', async (req, reply) => {
    if (!config.rateLimit.enabled || !req.url.startsWith('/api/')) return;
    const isAuth = req.url.startsWith('/api/v1/auth/') && req.method === 'POST';
    const isWrite = !['GET', 'HEAD'].includes(req.method);
    const [bucket, limit] = isAuth ? ['auth', config.rateLimit.authPerMinute]
      : isWrite ? ['w', config.rateLimit.writePerMinute] : ['r', config.rateLimit.readPerMinute];
    const who = isAuth || !req.user ? 'ip:' + req.ip : 'u:' + req.user.id;
    const win = Math.floor(Date.now() / 60000);
    const key = `rl:${bucket}:${who}:${win}`;
    let count;
    try {
      const res = await redis.multi().incr(key).expire(key, 70).exec();
      count = res[0][1];
    } catch (err) {
      req.log.warn({ err }, 'rate limiter unavailable; failing open');
      return;
    }
    reply.header('x-ratelimit-limit', limit);
    reply.header('x-ratelimit-remaining', Math.max(0, limit - count));
    if (count > limit) {
      reply.header('retry-after', 60 - Math.floor((Date.now() / 1000) % 60));
      throw fail(429, 'Too many requests, slow down', 'rate_limited');
    }
  });

  app.decorate('requireUser', async (req) => {
    if (!req.user) throw fail(401, 'Authentication required', 'unauthenticated');
  });
  app.decorate('requireModerator', async (req) => {
    if (!req.user) throw fail(401, 'Authentication required', 'unauthenticated');
    if (!['admin', 'moderator'].includes(req.user.role)) throw fail(403, 'Forbidden', 'forbidden');
  });

  app.setErrorHandler((err, req, reply) => {
    if (err.validation) return reply.code(400).send({ error: 'Invalid request: ' + err.message, code: 'validation' });
    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
    if (status >= 500) req.log.error({ err }, 'request failed');
    if (err.code === '23505') return reply.code(409).send({ error: 'Already exists', code: 'conflict' });
    if (err.code === '22P02') return reply.code(404).send({ error: 'Not found', code: 'not_found' });
    reply.code(status).send({ error: status >= 500 ? 'Server error' : err.message, code: typeof err.code === 'string' ? err.code : undefined });
  });

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/') || req.url.startsWith('/media/')) return reply.code(404).send({ error: 'Not found' });
    return reply.type('text/html; charset=utf-8').sendFile('index.html');
  });

  // فحوص الصحة لموازن الأحمال/المنسّق
  app.get('/healthz', async () => ({ ok: true }));
  app.get('/readyz', async (req, reply) => {
    const checks = {};
    await Promise.all([
      pool.query('SELECT 1').then(() => { checks.db = 'ok'; }, () => { checks.db = 'down'; }),
      redis.ping().then(() => { checks.redis = 'ok'; }, () => { checks.redis = 'down'; }),
    ]);
    const ok = Object.values(checks).every((v) => v === 'ok');
    return reply.code(ok ? 200 : 503).send({ ok, checks });
  });


  app.register(require('./routes/auth'), { prefix: '/api/v1' });
  app.register(require('./routes/users'), { prefix: '/api/v1' });
  app.register(require('./routes/posts'), { prefix: '/api/v1' });
  app.register(require('./routes/media'));
  app.register(require('./routes/social'), { prefix: '/api/v1' });

  return app;
}

module.exports = { buildApp };
