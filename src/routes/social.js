'use strict';
const { tx } = require('../db');
const { fail } = require('../errors');
const { AUDIENCES, UUID, decodeCursor, page, pageQuery, publicUser, mediaUrl } = require('../lib');

const idParam = { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } };

module.exports = async function socialRoutes(app) {
  const { pool, redis } = app;
  app.addHook('preHandler', app.requireUser);

  // ---------- القصص (تنتهي بعد 24 ساعة) ----------
  app.get('/stories', async (req) => {
    const me = req.user.id;
    const { rows } = await pool.query(
      `WITH net AS (
         SELECT $1::uuid AS id
         UNION SELECT followee_id FROM follows WHERE follower_id = $1 AND status = 'accepted'
         UNION SELECT user_b FROM friendships WHERE user_a = $1
         UNION SELECT user_a FROM friendships WHERE user_b = $1
       )
       SELECT s.id, s.audience, s.created_at, s.expires_at, m.id AS media_id, m.kind,
              u.id AS a_id, u.name AS a_name, u.handle AS a_handle, u.avatar_media_id AS a_avatar_media_id
         FROM net JOIN stories s ON s.author_id = net.id AND s.expires_at > now()
         JOIN users u ON u.id = s.author_id AND u.status = 'active'
         JOIN media m ON m.id = s.media_id
        WHERE can_view($1, s.author_id, s.audience)
        ORDER BY (s.author_id = $1) DESC, s.created_at DESC LIMIT 300`, [me]);
    return {
      items: rows.map((s) => ({
        id: s.id, audience: s.audience, createdAt: s.created_at, expiresAt: s.expires_at,
        media: { id: s.media_id, type: s.kind, url: mediaUrl(s.media_id) },
        author: publicUser(s, 'a_'), isMine: s.a_id === me,
      })),
    };
  });

  app.post('/stories', {
    schema: {
      body: {
        type: 'object', required: ['media', 'audience'],
        properties: { media: { type: 'string', pattern: UUID }, audience: { enum: AUDIENCES } },
      },
    },
  }, async (req, reply) => {
    const me = req.user.id;
    const story = await tx(pool, async (db) => {
      const { rows } = await db.query(
        `SELECT id, kind FROM media m WHERE id = $1 AND owner_id = $2 AND status = 'ready'
           AND NOT EXISTS (SELECT 1 FROM post_media pm WHERE pm.media_id = m.id)
           AND NOT EXISTS (SELECT 1 FROM stories s WHERE s.media_id = m.id) FOR UPDATE`, [req.body.media, me]);
      if (!rows.length) throw fail(400, 'Invalid story media', 'bad_media');
      const { rows: [s] } = await db.query(
        `INSERT INTO stories (author_id, media_id, audience, expires_at) VALUES ($1, $2, $3, now() + interval '24 hours')
         RETURNING id, audience, created_at, expires_at`, [me, req.body.media, req.body.audience]);
      return { ...s, kind: rows[0].kind };
    });
    return reply.code(201).send({
      id: story.id, audience: story.audience, createdAt: story.created_at, expiresAt: story.expires_at,
      media: { id: req.body.media, type: story.kind, url: mediaUrl(req.body.media) }, isMine: true,
    });
  });

  app.delete('/stories/:id', { schema: { params: idParam } }, async (req) => {
    // نُنهي صلاحيتها فورًا؛ عامل الخلفية يحذف السجل والملف
    const { rows } = await pool.query(
      `UPDATE stories SET expires_at = now() WHERE id = $1 AND author_id = $2 RETURNING id`, [req.params.id, req.user.id]);
    if (!rows.length) throw fail(404, 'Story not found', 'not_found');
    return { ok: true };
  });

  // ---------- الإشعارات ----------
  app.get('/notifications', {
    schema: { querystring: { type: 'object', properties: { before: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 } } } },
  }, async (req) => {
    const { limit, before } = req.query;
    const { rows } = await pool.query(
      `SELECT n.id, n.type, n.entity_id, n.read_at, n.created_at,
              u.id AS a_id, u.name AS a_name, u.handle AS a_handle, u.avatar_media_id AS a_avatar_media_id
         FROM notifications n LEFT JOIN users u ON u.id = n.actor_id
        WHERE n.user_id = $1 AND ($2::bigint IS NULL OR n.id < $2)
        ORDER BY n.id DESC LIMIT $3`, [req.user.id, before ?? null, limit + 1]);
    const items = rows.slice(0, limit).map((n) => ({
      id: Number(n.id), type: n.type, entityId: n.entity_id, read: !!n.read_at, createdAt: n.created_at,
      actor: n.a_id ? publicUser(n, 'a_') : null,
    }));
    return { items, nextBefore: rows.length > limit ? items[items.length - 1].id : null };
  });

  app.post('/notifications/read', async (req) => {
    await pool.query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [req.user.id]);
    return { ok: true };
  });

  // ---------- البلاغات والإشراف ----------
  app.post('/reports', {
    schema: {
      body: {
        type: 'object', required: ['targetType', 'targetId', 'reason'],
        properties: {
          targetType: { enum: ['post', 'comment', 'user', 'story'] },
          targetId: { type: 'string', pattern: UUID },
          reason: { type: 'string', minLength: 3, maxLength: 1000 },
        },
      },
    },
  }, async (req, reply) => {
    const { targetType, targetId, reason } = req.body;
    const table = { post: 'posts', comment: 'comments', user: 'users', story: 'stories' }[targetType];
    const { rows } = await pool.query(`SELECT 1 FROM ${table} WHERE id = $1`, [targetId]);
    if (!rows.length) throw fail(404, 'Target not found', 'not_found');
    await pool.query(
      `INSERT INTO reports (reporter_id, target_type, target_id, reason) VALUES ($1, $2, $3, $4)
       ON CONFLICT (reporter_id, target_type, target_id) WHERE status = 'open' DO NOTHING`,
      [req.user.id, targetType, targetId, reason.trim()]);
    return reply.code(201).send({ ok: true });
  });

  app.get('/admin/reports', { preHandler: app.requireModerator, schema: { querystring: pageQuery } }, async (req) => {
    const { limit } = req.query;
    const [ct, cid] = decodeCursor(req.query.cursor);
    const { rows } = await pool.query(
      `SELECT r.id, r.target_type, r.target_id, r.reason, r.created_at, u.handle AS reporter,
              (SELECT count(*) FROM reports r2 WHERE r2.target_id = r.target_id AND r2.status = 'open')::int AS total_reports
         FROM reports r LEFT JOIN users u ON u.id = r.reporter_id
        WHERE r.status = 'open' AND ($1::timestamptz IS NULL OR (r.created_at, r.id) > ($1, $2::uuid))
        ORDER BY r.created_at, r.id LIMIT $3`, [ct, cid, limit + 1]);
    const p = page(rows, limit);
    p.items = p.items.map((r) => ({
      id: r.id, targetType: r.target_type, targetId: r.target_id, reason: r.reason, createdAt: r.created_at,
      reporter: r.reporter, totalReports: r.total_reports,
    }));
    return p;
  });

  app.post('/admin/reports/:id/resolve', {
    preHandler: app.requireModerator,
    schema: { params: idParam, body: { type: 'object', required: ['action'], properties: { action: { enum: ['dismiss', 'remove_content', 'suspend_user'] } } } },
  }, async (req) => {
    const { action } = req.body;
    const revoked = await tx(pool, async (db) => {
      const { rows } = await db.query(`SELECT target_type, target_id FROM reports WHERE id = $1 AND status = 'open' FOR UPDATE`, [req.params.id]);
      const r = rows[0];
      if (!r) throw fail(404, 'Report not found', 'not_found');
      let sessions = [];
      if (action === 'remove_content') {
        if (r.target_type === 'post') await db.query('UPDATE posts SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL', [r.target_id]);
        else if (r.target_type === 'comment') await db.query('UPDATE comments SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL', [r.target_id]);
        else if (r.target_type === 'story') await db.query('UPDATE stories SET expires_at = now() WHERE id = $1', [r.target_id]);
        else throw fail(400, 'Use suspend_user for user reports');
      }
      if (action === 'suspend_user') {
        const owner = {
          user: 'SELECT $1::uuid AS id',
          post: 'SELECT author_id AS id FROM posts WHERE id = $1',
          comment: 'SELECT author_id AS id FROM comments WHERE id = $1',
          story: 'SELECT author_id AS id FROM stories WHERE id = $1',
        }[r.target_type];
        const { rows: [o] } = await db.query(owner, [r.target_id]);
        if (!o) throw fail(404, 'Target not found');
        const { rows: target } = await db.query(`SELECT role FROM users WHERE id = $1`, [o.id]);
        if (target[0]?.role === 'admin') throw fail(403, 'Cannot suspend an admin');
        await db.query(`UPDATE users SET status = 'suspended' WHERE id = $1`, [o.id]);
        sessions = (await db.query('DELETE FROM sessions WHERE user_id = $1 RETURNING token_hash', [o.id])).rows;
      }
      const status = action === 'dismiss' ? 'dismissed' : 'actioned';
      await db.query(
        `UPDATE reports SET status = $3, resolved_by = $2, resolved_at = now()
          WHERE target_id = $1 AND status = 'open'`, [r.target_id, req.user.id, status]);
      return sessions;
    });
    if (revoked.length) await redis.del(...revoked.map((s) => 'sess:' + s.token_hash.toString('hex'))).catch(() => {});
    return { ok: true };
  });
};
