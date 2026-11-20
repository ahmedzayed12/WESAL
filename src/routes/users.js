'use strict';
const { tx } = require('../db');
const { fail } = require('../errors');
const { UUID, mediaUrl, decodeCursor, page, pageQuery, publicUser, hydratePosts, notify } = require('../lib');

const idParam = { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } };

module.exports = async function userRoutes(app) {
  const { pool, redis, storage } = app;
  app.addHook('preHandler', app.requireUser);

  async function targetUser(viewer, id) {
    const { rows } = await pool.query(
      `SELECT id, is_private, status, is_blocked($1, id) AS blocked FROM users WHERE id = $2`, [viewer, id]);
    const u = rows[0];
    if (!u || u.status !== 'active' || u.blocked) throw fail(404, 'User not found', 'not_found');
    return u;
  }

  // البحث عن الأشخاص / اقتراحات
  app.get('/users', {
    schema: { querystring: { ...pageQuery, properties: { ...pageQuery.properties, q: { type: 'string', maxLength: 60 } } } },
  }, async (req) => {
    const me = req.user.id;
    const { limit } = req.query;
    const q = (req.query.q || '').trim().toLowerCase().replace(/^@/, '').replace(/[%_\\]/g, '');
    const [ct, cid] = decodeCursor(req.query.cursor);
    const { rows } = await pool.query(
      `SELECT u.id, u.name, u.handle, u.avatar_media_id, u.is_private, u.created_at,
              are_friends($1, u.id) AS is_friend,
              (SELECT status FROM follows f WHERE f.follower_id = $1 AND f.followee_id = u.id) AS follow_status
         FROM users u
        WHERE u.id <> $1 AND u.status = 'active' AND NOT is_blocked($1, u.id)
          AND ($2 = '' OR lower(u.handle) LIKE $2 || '%' OR lower(u.name) LIKE $2 || '%')
          AND ($3::timestamptz IS NULL OR (u.created_at, u.id) < ($3, $4::uuid))
        ORDER BY u.created_at DESC, u.id DESC LIMIT $5`, [me, q, ct, cid, limit + 1]);
    const p = page(rows, limit);
    p.items = p.items.map((r) => ({ ...publicUser(r), private: r.is_private, isFriend: r.is_friend, followStatus: r.follow_status }));
    return p;
  });

  app.get('/users/:handle/profile', {
    schema: { params: { type: 'object', properties: { handle: { type: 'string', maxLength: 60 } } } },
  }, async (req) => {
    const me = req.user.id;
    const key = req.params.handle;
    const byId = new RegExp(UUID).test(key);
    const { rows } = await pool.query(
      `SELECT u.id, u.name, u.handle, u.bio, u.avatar_media_id, u.is_private, u.created_at, u.status,
              EXISTS (SELECT 1 FROM blocks WHERE blocker_id = u.id AND blocked_id = $1) AS blocked_me,
              EXISTS (SELECT 1 FROM blocks WHERE blocker_id = $1 AND blocked_id = u.id) AS blocked_by_me,
              are_friends($1, u.id) AS is_friend,
              (SELECT status FROM follows WHERE follower_id = $1 AND followee_id = u.id) AS follow_status,
              (SELECT status FROM follows WHERE follower_id = u.id AND followee_id = $1) AS follows_me,
              (SELECT json_build_object('id', id, 'direction', CASE WHEN from_id = $1 THEN 'outgoing' ELSE 'incoming' END)
                 FROM friend_requests WHERE status = 'pending' AND ((from_id = $1 AND to_id = u.id) OR (from_id = u.id AND to_id = $1)) LIMIT 1) AS friend_request,
              (SELECT count(*) FROM follows WHERE followee_id = u.id AND status = 'accepted')::int AS followers,
              (SELECT count(*) FROM follows WHERE follower_id = u.id AND status = 'accepted')::int AS following,
              ((SELECT count(*) FROM friendships WHERE user_a = u.id) + (SELECT count(*) FROM friendships WHERE user_b = u.id))::int AS friends
         FROM users u WHERE ${byId ? 'u.id = $2::uuid' : 'lower(u.handle) = lower($2)'}`, [me, key]);
    const u = rows[0];
    if (!u || u.status !== 'active' || u.blocked_me) throw fail(404, 'User not found', 'not_found');
    return {
      ...publicUser(u), bio: u.bio, private: u.is_private, createdAt: u.created_at, isMe: u.id === me,
      isFriend: u.is_friend, followStatus: u.follow_status, followsMe: u.follows_me === 'accepted',
      friendRequest: u.friend_request, isBlockedByMe: u.blocked_by_me,
      counts: { followers: u.followers, following: u.following, friends: u.friends },
    };
  });

  app.get('/users/:id/posts', { schema: { params: idParam, querystring: pageQuery } }, async (req) => {
    const me = req.user.id;
    const { limit } = req.query;
    const [ct, cid] = decodeCursor(req.query.cursor);
    const { rows } = await pool.query(
      `SELECT p.id, p.created_at FROM posts p
        WHERE p.author_id = $1 AND p.deleted_at IS NULL AND can_view($2, p.author_id, p.audience)
          AND ($3::timestamptz IS NULL OR (p.created_at, p.id) < ($3, $4::uuid))
        ORDER BY p.created_at DESC, p.id DESC LIMIT $5`, [req.params.id, me, ct, cid, limit + 1]);
    const p = page(rows, limit);
    return { items: await hydratePosts(pool, me, p.items.map((r) => r.id)), nextCursor: p.nextCursor };
  });

  // ---------- الملف الشخصي والحساب ----------
  app.patch('/me/profile', {
    schema: {
      body: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 60 },
          bio: { type: 'string', maxLength: 300 },
          private: { type: 'boolean' },
          avatar: { anyOf: [{ type: 'string', pattern: UUID }, { type: 'null' }] },
        },
      },
    },
  }, async (req) => {
    const me = req.user.id;
    const b = req.body;
    await tx(pool, async (db) => {
      if (b.avatar) {
        const { rows } = await db.query(
          `SELECT 1 FROM media WHERE id = $1 AND owner_id = $2 AND status = 'ready' AND kind = 'image'`, [b.avatar, me]);
        if (!rows.length) throw fail(400, 'Invalid profile photo', 'bad_media');
      }
      await db.query(
        `UPDATE users SET
           name = COALESCE($2, name), bio = COALESCE($3, bio), is_private = COALESCE($4, is_private),
           avatar_media_id = CASE WHEN $5 THEN $6::uuid ELSE avatar_media_id END
         WHERE id = $1`,
        [me, b.name?.trim() || null, b.bio ?? null, b.private ?? null, 'avatar' in b, b.avatar ?? null]);
      // عند تحويل الحساب إلى عام تُقبل طلبات المتابعة المعلقة تلقائيًا
      if (b.private === false) await db.query(`UPDATE follows SET status = 'accepted' WHERE followee_id = $1 AND status = 'pending'`, [me]);
    });
    const { rows: [u] } = await pool.query('SELECT id, name, handle, bio, is_private, avatar_media_id FROM users WHERE id = $1', [me]);
    return { ...publicUser(u), bio: u.bio, private: u.is_private };
  });

  // حذف الحساب نهائيًا (حق المستخدم في حذف بياناته)
  app.delete('/me', {
    schema: { body: { type: 'object', required: ['password'], properties: { password: { type: 'string', maxLength: 200 } } } },
  }, async (req, reply) => {
    const me = req.user.id;
    const { verifyPassword } = require('../auth');
    const { rows: [u] } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [me]);
    if (!(await verifyPassword(req.body.password, u.password_hash))) throw fail(401, 'Invalid credentials', 'invalid_credentials');
    const keys = (await pool.query('SELECT storage_key FROM media WHERE owner_id = $1', [me])).rows.map((r) => r.storage_key);
    const sessions = (await pool.query('SELECT token_hash FROM sessions WHERE user_id = $1', [me])).rows;
    await pool.query('DELETE FROM users WHERE id = $1', [me]);
    if (sessions.length) await redis.del(...sessions.map((s) => 'sess:' + s.token_hash.toString('hex'))).catch(() => {});
    reply.clearCookie('sid', { path: '/' });
    // حذف ملفات الوسائط في الخلفية؛ أي ملف يتعذر حذفه يُلتقط لاحقًا بأداة جرد التخزين
    Promise.allSettled(keys.map((k) => storage.remove(k))).then((res) => {
      const failed = res.filter((r) => r.status === 'rejected').length;
      if (failed) req.log.warn({ failed }, 'some media objects could not be deleted');
    });
    return { ok: true };
  });

  app.get('/me/friends', { schema: { querystring: pageQuery } }, async (req) => {
    const me = req.user.id;
    const { limit } = req.query;
    const [ct, cid] = decodeCursor(req.query.cursor);
    const { rows } = await pool.query(
      `SELECT u.id, u.name, u.handle, u.avatar_media_id, f.created_at
         FROM (SELECT user_b AS uid, created_at FROM friendships WHERE user_a = $1
               UNION ALL SELECT user_a, created_at FROM friendships WHERE user_b = $1) f
         JOIN users u ON u.id = f.uid AND u.status = 'active'
        WHERE ($2::timestamptz IS NULL OR (f.created_at, u.id) < ($2, $3::uuid))
        ORDER BY f.created_at DESC, u.id DESC LIMIT $4`, [me, ct, cid, limit + 1]);
    const p = page(rows, limit);
    p.items = p.items.map((r) => publicUser(r));
    return p;
  });

  // ---------- المتابعة ----------
  app.post('/users/:id/follow', { schema: { params: idParam } }, async (req) => {
    const me = req.user.id;
    if (req.params.id === me) throw fail(400, 'Cannot follow yourself');
    const t = await targetUser(me, req.params.id);
    const status = t.is_private ? 'pending' : 'accepted';
    const { rows } = await pool.query(
      `INSERT INTO follows (follower_id, followee_id, status) VALUES ($1, $2, $3)
       ON CONFLICT (follower_id, followee_id) DO NOTHING RETURNING status`, [me, t.id, status]);
    if (rows.length) await notify(pool, { userId: t.id, actorId: me, type: status === 'pending' ? 'follow_request' : 'follow' });
    const { rows: [f] } = await pool.query('SELECT status FROM follows WHERE follower_id = $1 AND followee_id = $2', [me, t.id]);
    return { followee: t.id, status: f.status };
  });

  app.delete('/users/:id/follow', { schema: { params: idParam } }, async (req) => {
    await pool.query('DELETE FROM follows WHERE follower_id = $1 AND followee_id = $2', [req.user.id, req.params.id]);
    return { ok: true };
  });

  // إزالة متابع
  app.delete('/me/followers/:id', { schema: { params: idParam } }, async (req) => {
    await pool.query('DELETE FROM follows WHERE follower_id = $2 AND followee_id = $1', [req.user.id, req.params.id]);
    return { ok: true };
  });

  app.get('/me/follow-requests', { schema: { querystring: pageQuery } }, async (req) => {
    const { limit } = req.query;
    const [ct, cid] = decodeCursor(req.query.cursor);
    const { rows } = await pool.query(
      `SELECT u.id, u.name, u.handle, u.avatar_media_id, f.created_at FROM follows f JOIN users u ON u.id = f.follower_id
        WHERE f.followee_id = $1 AND f.status = 'pending' AND u.status = 'active'
          AND ($2::timestamptz IS NULL OR (f.created_at, u.id) < ($2, $3::uuid))
        ORDER BY f.created_at DESC, u.id DESC LIMIT $4`, [req.user.id, ct, cid, limit + 1]);
    const p = page(rows, limit);
    p.items = p.items.map((r) => publicUser(r));
    return p;
  });

  app.post('/follow-requests/:id/:action', {
    schema: { params: { type: 'object', properties: { id: { type: 'string', pattern: UUID }, action: { enum: ['accept', 'decline'] } } } },
  }, async (req) => {
    const me = req.user.id;
    const q = req.params.action === 'accept'
      ? `UPDATE follows SET status = 'accepted' WHERE follower_id = $1 AND followee_id = $2 AND status = 'pending' RETURNING 1`
      : `DELETE FROM follows WHERE follower_id = $1 AND followee_id = $2 AND status = 'pending' RETURNING 1`;
    const { rows } = await pool.query(q, [req.params.id, me]);
    if (!rows.length) throw fail(404, 'Request not found', 'not_found');
    if (req.params.action === 'accept') await notify(pool, { userId: req.params.id, actorId: me, type: 'follow_accepted' });
    return { ok: true };
  });

  // ---------- الصداقة ----------
  app.post('/users/:id/friend-request', { schema: { params: idParam } }, async (req) => {
    const me = req.user.id;
    if (req.params.id === me) throw fail(400, 'Cannot befriend yourself');
    const t = await targetUser(me, req.params.id);
    return tx(pool, async (db) => {
      const { rows: [{ f }] } = await db.query('SELECT are_friends($1, $2) AS f', [me, t.id]);
      if (f) throw fail(409, 'Already friends', 'already_friends');
      // إن كان الطرف الآخر قد أرسل طلبًا مسبقًا، نقبله مباشرة
      const { rows: reverse } = await db.query(
        `UPDATE friend_requests SET status = 'accepted', responded_at = now()
          WHERE from_id = $1 AND to_id = $2 AND status = 'pending' RETURNING id, from_id, to_id, status`, [t.id, me]);
      if (reverse.length) {
        await db.query('INSERT INTO friendships (user_a, user_b) VALUES (LEAST($1::uuid, $2::uuid), GREATEST($1::uuid, $2::uuid)) ON CONFLICT DO NOTHING', [me, t.id]);
        await notify(db, { userId: t.id, actorId: me, type: 'friend_accepted' });
        return { id: reverse[0].id, from: reverse[0].from_id, to: reverse[0].to_id, status: 'accepted' };
      }
      const { rows } = await db.query(
        `INSERT INTO friend_requests (from_id, to_id) VALUES ($1, $2)
         ON CONFLICT (from_id, to_id) WHERE status = 'pending' DO NOTHING RETURNING id, from_id, to_id, status`, [me, t.id]);
      if (rows.length) {
        await notify(db, { userId: t.id, actorId: me, type: 'friend_request', entityId: rows[0].id });
        return { id: rows[0].id, from: me, to: t.id, status: 'pending' };
      }
      const { rows: [r] } = await db.query(
        `SELECT id FROM friend_requests WHERE from_id = $1 AND to_id = $2 AND status = 'pending'`, [me, t.id]);
      return { id: r.id, from: me, to: t.id, status: 'pending' };
    });
  });

  app.get('/friend-requests', { schema: { querystring: pageQuery } }, async (req) => {
    const me = req.user.id;
    const { limit } = req.query;
    const [ct, cid] = decodeCursor(req.query.cursor);
    const { rows } = await pool.query(
      `SELECT r.id, r.from_id, r.to_id, r.status, r.created_at,
              fu.id AS f_id, fu.name AS f_name, fu.handle AS f_handle, fu.avatar_media_id AS f_avatar_media_id,
              tu.id AS t_id, tu.name AS t_name, tu.handle AS t_handle, tu.avatar_media_id AS t_avatar_media_id
         FROM friend_requests r JOIN users fu ON fu.id = r.from_id JOIN users tu ON tu.id = r.to_id
        WHERE (r.to_id = $1 OR r.from_id = $1) AND r.status = 'pending'
          AND NOT is_blocked(r.from_id, r.to_id)
          AND ($2::timestamptz IS NULL OR (r.created_at, r.id) < ($2, $3::uuid))
        ORDER BY r.created_at DESC, r.id DESC LIMIT $4`, [me, ct, cid, limit + 1]);
    const p = page(rows, limit);
    p.items = p.items.map((r) => ({
      id: r.id, from: r.from_id, to: r.to_id, status: r.status, createdAt: r.created_at,
      direction: r.to_id === me ? 'incoming' : 'outgoing',
      fromUser: publicUser(r, 'f_'), toUser: publicUser(r, 't_'),
    }));
    return p;
  });

  app.post('/friend-requests/:id/:action', {
    schema: { params: { type: 'object', properties: { id: { type: 'string', pattern: UUID }, action: { enum: ['accept', 'decline', 'cancel'] } } } },
  }, async (req) => {
    const me = req.user.id;
    const { id, action } = req.params;
    return tx(pool, async (db) => {
      const { rows } = await db.query(
        `SELECT id, from_id, to_id FROM friend_requests WHERE id = $1 AND status = 'pending' FOR UPDATE`, [id]);
      const r = rows[0];
      const allowed = r && (action === 'cancel' ? r.from_id === me : r.to_id === me);
      if (!allowed) throw fail(404, 'Request not found', 'not_found');
      const status = { accept: 'accepted', decline: 'declined', cancel: 'cancelled' }[action];
      if (action === 'accept') {
        const { rows: [{ b }] } = await db.query('SELECT is_blocked($1, $2) AS b', [r.from_id, r.to_id]);
        if (b) throw fail(404, 'Request not found', 'not_found');
        await db.query('INSERT INTO friendships (user_a, user_b) VALUES (LEAST($1::uuid, $2::uuid), GREATEST($1::uuid, $2::uuid)) ON CONFLICT DO NOTHING', [r.from_id, r.to_id]);
        await notify(db, { userId: r.from_id, actorId: me, type: 'friend_accepted' });
      }
      await db.query('UPDATE friend_requests SET status = $2, responded_at = now() WHERE id = $1', [id, status]);
      return { id, from: r.from_id, to: r.to_id, status };
    });
  });

  app.delete('/users/:id/friend', { schema: { params: idParam } }, async (req) => {
    await pool.query('DELETE FROM friendships WHERE user_a = LEAST($1::uuid, $2::uuid) AND user_b = GREATEST($1::uuid, $2::uuid)', [req.user.id, req.params.id]);
    return { ok: true };
  });

  // ---------- الحظر ----------
  app.post('/users/:id/block', { schema: { params: idParam } }, async (req) => {
    const me = req.user.id;
    const other = req.params.id;
    if (other === me) throw fail(400, 'Invalid user');
    await tx(pool, async (db) => {
      const { rows } = await db.query('SELECT 1 FROM users WHERE id = $1', [other]);
      if (!rows.length) throw fail(404, 'User not found', 'not_found');
      await db.query('INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [me, other]);
      await db.query('DELETE FROM friendships WHERE user_a = LEAST($1::uuid, $2::uuid) AND user_b = GREATEST($1::uuid, $2::uuid)', [me, other]);
      await db.query('DELETE FROM follows WHERE (follower_id = $1 AND followee_id = $2) OR (follower_id = $2 AND followee_id = $1)', [me, other]);
      await db.query(`UPDATE friend_requests SET status = 'cancelled', responded_at = now()
                       WHERE status = 'pending' AND ((from_id = $1 AND to_id = $2) OR (from_id = $2 AND to_id = $1))`, [me, other]);
    });
    return { ok: true };
  });

  app.delete('/users/:id/block', { schema: { params: idParam } }, async (req) => {
    await pool.query('DELETE FROM blocks WHERE blocker_id = $1 AND blocked_id = $2', [req.user.id, req.params.id]);
    return { ok: true };
  });

  app.get('/me/blocks', async (req) => {
    const { rows } = await pool.query(
      `SELECT u.id, u.name, u.handle, u.avatar_media_id FROM blocks b JOIN users u ON u.id = b.blocked_id
        WHERE b.blocker_id = $1 ORDER BY b.created_at DESC LIMIT 500`, [req.user.id]);
    return { items: rows.map((r) => ({ ...publicUser(r), avatar: mediaUrl(r.avatar_media_id) })) };
  });
};
