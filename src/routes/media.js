'use strict';
const { config } = require('../config');
const { fail } = require('../errors');
const { UUID } = require('../lib');
const { EXT, signatureMatches } = require('../storage');

const idParam = { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } };
const maxBytes = (mime) => (mime.startsWith('video/') ? config.limits.videoBytes : config.limits.imageBytes);

module.exports = async function mediaRoutes(app) {
  const { pool, storage } = app;

  // 1) طلب رفع: يُنشئ سجلًا معلقًا ويعيد رابط الرفع (رابط S3 موقّع أو مسار محلي)
  app.post('/api/v1/media/uploads', {
    preHandler: app.requireUser,
    schema: {
      body: {
        type: 'object', required: ['mime', 'size'],
        properties: { mime: { enum: Object.keys(EXT) }, size: { type: 'integer', minimum: 12 } },
      },
    },
  }, async (req, reply) => {
    const { mime, size } = req.body;
    if (size > maxBytes(mime)) throw fail(413, `File too large (max ${Math.round(maxBytes(mime) / 1048576)} MB)`, 'too_large');
    const { rows: [{ pending }] } = await pool.query(
      `SELECT count(*)::int AS pending FROM media WHERE owner_id = $1 AND status = 'pending' AND created_at > now() - interval '1 hour'`, [req.user.id]);
    if (pending >= 30) throw fail(429, 'Too many unfinished uploads', 'upload_quota');
    const { rows: [m] } = await pool.query(
      `INSERT INTO media (id, owner_id, kind, mime, size_bytes, storage_key)
       SELECT g.id, $1, $2, $3, $4, g.id::text || '.' || $5 FROM (SELECT gen_random_uuid() AS id) g
       RETURNING id, storage_key`, [req.user.id, mime.startsWith('video/') ? 'video' : 'image', mime, size, EXT[mime]]);
    const upload = await storage.createUpload({ id: m.id, key: m.storage_key, mime, size });
    return reply.code(201).send({ id: m.id, upload });
  });

  // 2) (التخزين المحلي فقط) استقبال الملف كتدفق خام — دون base64 ودون تحميله كاملًا في الذاكرة
  app.register(async (blob) => {
    blob.addContentTypeParser('*', (req, payload, done) => done(null));
    blob.put('/api/v1/media/:id/blob', { preHandler: app.requireUser, schema: { params: idParam } }, async (req) => {
      if (storage.driver !== 'local') throw fail(404, 'Not found');
      const { rows } = await pool.query(
        `SELECT id, mime, storage_key, size_bytes FROM media WHERE id = $1 AND owner_id = $2 AND status = 'pending'`, [req.params.id, req.user.id]);
      const m = rows[0];
      if (!m) throw fail(404, 'Upload not found', 'not_found');
      const size = await storage.write(m.storage_key, req.raw, Math.min(Number(m.size_bytes), maxBytes(m.mime)));
      return { ok: true, size };
    });
  });

  // 3) إتمام الرفع: التحقق من الحجم والتوقيع الحقيقي للملف ثم تفعيله
  app.post('/api/v1/media/:id/complete', { preHandler: app.requireUser, schema: { params: idParam } }, async (req) => {
    const { rows } = await pool.query(
      `SELECT id, kind, mime, storage_key, status FROM media WHERE id = $1 AND owner_id = $2`, [req.params.id, req.user.id]);
    const m = rows[0];
    if (!m) throw fail(404, 'Upload not found', 'not_found');
    if (m.status === 'pending') {
      const head = await storage.head(m.storage_key);
      if (!head) throw fail(400, 'File was not uploaded', 'not_uploaded');
      if (head.size > maxBytes(m.mime) || head.size < 12) {
        await storage.remove(m.storage_key);
        throw fail(413, 'Media size invalid', 'too_large');
      }
      if (!signatureMatches(m.mime, await storage.readStart(m.storage_key, 16))) {
        await storage.remove(m.storage_key);
        await pool.query('DELETE FROM media WHERE id = $1', [m.id]);
        throw fail(415, 'File content does not match its type', 'bad_signature');
      }
      await pool.query(`UPDATE media SET status = 'ready', size_bytes = $2 WHERE id = $1`, [m.id, head.size]);
    }
    return { id: m.id, type: m.kind, url: `/media/${m.id}` };
  });

  // 4) عرض الوسائط بعد التحقق من صلاحية المشاهدة
  app.get('/media/:id', { preHandler: app.requireUser, schema: { params: idParam } }, async (req, reply) => {
    const me = req.user.id;
    const { rows } = await pool.query(
      `SELECT m.mime, m.storage_key FROM media m
        WHERE m.id = $1 AND m.status = 'ready' AND (
          m.owner_id = $2
          OR EXISTS (SELECT 1 FROM users u WHERE u.avatar_media_id = m.id AND u.status = 'active' AND NOT is_blocked($2, u.id))
          OR EXISTS (SELECT 1 FROM post_media pm JOIN posts p ON p.id = pm.post_id
                      WHERE pm.media_id = m.id AND p.deleted_at IS NULL AND can_view($2, p.author_id, p.audience))
          OR EXISTS (SELECT 1 FROM stories s WHERE s.media_id = m.id AND s.expires_at > now() AND can_view($2, s.author_id, s.audience))
        )`, [req.params.id, me]);
    const m = rows[0];
    if (!m) throw fail(404, 'Media unavailable', 'not_found');
    reply.header('cache-control', 'private, max-age=240');
    if (storage.driver === 's3') return reply.redirect(await storage.signedGet(m.storage_key, m.mime), 302);
    reply.header('content-type', m.mime);
    return reply.sendFile(m.storage_key, storage.dir, { cacheControl: false, contentType: false });
  });
};
