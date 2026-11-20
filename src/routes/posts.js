'use strict';
const { tx } = require('../db');
const { fail } = require('../errors');
const { AUDIENCES, REACTIONS, UUID, decodeCursor, page, pageQuery, publicUser, hydratePosts, notify } = require('../lib');

const idParam = { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } };

module.exports = async function postRoutes(app) {
  const { pool } = app;
  app.addHook('preHandler', app.requireUser);

  async function visiblePost(db, viewer, id, lock = false) {
    const { rows } = await db.query(
      `SELECT p.id, p.author_id, p.audience FROM posts p JOIN users u ON u.id = p.author_id
        WHERE p.id = $1 AND p.deleted_at IS NULL AND u.status = 'active' AND can_view($2, p.author_id, p.audience)
        ${lock ? 'FOR UPDATE OF p' : ''}`, [id, viewer]);
    if (!rows[0]) throw fail(404, 'Post not found', 'not_found');
    return rows[0];
  }

  // الصفحة الرئيسية: منشورات شبكتك (أنت + الأصدقاء + من تتابعهم).
  // نموذج "السحب عند القراءة" باستخدام فهرس المؤلف؛ يجلب أعلى N من كل مؤلف ثم يدمج.
  app.get('/feed', { schema: { querystring: pageQuery } }, async (req) => {
    const me = req.user.id;
    const { limit } = req.query;
    const [ct, cid] = decodeCursor(req.query.cursor);
    const { rows } = await pool.query(
      `WITH rel AS (
         SELECT $1::uuid AS id, true AS self, false AS fr, false AS fo
         UNION ALL SELECT followee_id, false, false, true FROM follows WHERE follower_id = $1 AND status = 'accepted'
         UNION ALL SELECT user_b, false, true, false FROM friendships WHERE user_a = $1
         UNION ALL SELECT user_a, false, true, false FROM friendships WHERE user_b = $1
       ), net AS (
         -- العلاقة تُحسب مرة واحدة لكل مؤلف بدل حسابها لكل منشور
         SELECT id, bool_or(self) AS self, bool_or(fr) AS fr, bool_or(fo) AS fo FROM rel GROUP BY id
       )
       SELECT p.id, p.created_at FROM net
       JOIN users u ON u.id = net.id AND u.status = 'active'
       CROSS JOIN LATERAL (
         SELECT id, created_at FROM posts
          WHERE author_id = net.id AND deleted_at IS NULL
            AND ($2::timestamptz IS NULL OR (created_at, id) < ($2, $3::uuid))
            AND (net.self OR audience = 'public'
                 OR (audience = 'friends' AND net.fr)
                 OR (audience = 'followers' AND net.fo)
                 OR (audience = 'friends_and_followers' AND (net.fr OR net.fo)))
          ORDER BY created_at DESC, id DESC LIMIT $4
       ) p
       WHERE net.self OR NOT is_blocked($1, net.id)
       ORDER BY p.created_at DESC, p.id DESC LIMIT $4`, [me, ct, cid, limit + 1]);
    const p = page(rows, limit);
    return { items: await hydratePosts(pool, me, p.items.map((r) => r.id)), nextCursor: p.nextCursor };
  });

  // استكشاف: أحدث المنشورات العامة من الجميع
  app.get('/explore', { schema: { querystring: pageQuery } }, async (req) => {
    const me = req.user.id;
    const { limit } = req.query;
    const [ct, cid] = decodeCursor(req.query.cursor);
    const { rows } = await pool.query(
      `SELECT p.id, p.created_at FROM posts p JOIN users u ON u.id = p.author_id AND u.status = 'active'
        WHERE p.deleted_at IS NULL AND p.audience = 'public' AND NOT is_blocked($1, p.author_id)
          AND ($2::timestamptz IS NULL OR (p.created_at, p.id) < ($2, $3::uuid))
        ORDER BY p.created_at DESC, p.id DESC LIMIT $4`, [me, ct, cid, limit + 1]);
    const p = page(rows, limit);
    return { items: await hydratePosts(pool, me, p.items.map((r) => r.id)), nextCursor: p.nextCursor };
  });

  app.get('/reels', { schema: { querystring: pageQuery } }, async (req) => {
    const me = req.user.id;
    const { limit } = req.query;
    const [ct, cid] = decodeCursor(req.query.cursor);
    const { rows } = await pool.query(
      `SELECT p.id, p.created_at FROM posts p JOIN users u ON u.id = p.author_id AND u.status = 'active'
        WHERE p.deleted_at IS NULL AND p.kind = 'reel' AND can_view($1, p.author_id, p.audience)
          AND ($2::timestamptz IS NULL OR (p.created_at, p.id) < ($2, $3::uuid))
        ORDER BY p.created_at DESC, p.id DESC LIMIT $4`, [me, ct, cid, limit + 1]);
    const p = page(rows, limit);
    return { items: await hydratePosts(pool, me, p.items.map((r) => r.id)), nextCursor: p.nextCursor };
  });

  app.post('/posts', {
    schema: {
      body: {
        type: 'object',
        required: ['audience'],
        properties: {
          text: { type: 'string', maxLength: 5000, default: '' },
          audience: { enum: AUDIENCES },
          kind: { enum: ['post', 'reel'], default: 'post' },
          media: { type: 'array', maxItems: 4, uniqueItems: true, items: { type: 'string', pattern: UUID }, default: [] },
        },
      },
    },
  }, async (req, reply) => {
    const me = req.user.id;
    const { audience, kind } = req.body;
    const text = req.body.text.trim();
    const mediaIds = req.body.media;
    if (!text && !mediaIds.length) throw fail(400, 'Post is empty', 'empty_post');
    const id = await tx(pool, async (db) => {
      let media = [];
      if (mediaIds.length) {
        ({ rows: media } = await db.query(
          `SELECT m.id, m.kind FROM media m
            WHERE m.id = ANY($1::uuid[]) AND m.owner_id = $2 AND m.status = 'ready'
              AND NOT EXISTS (SELECT 1 FROM post_media pm WHERE pm.media_id = m.id)
              AND NOT EXISTS (SELECT 1 FROM stories s WHERE s.media_id = m.id)
            FOR UPDATE`, [mediaIds, me]));
        if (media.length !== mediaIds.length) throw fail(400, 'Invalid or already used media', 'bad_media');
      }
      if (kind === 'reel' && (media.length !== 1 || media[0].kind !== 'video')) throw fail(400, 'A reel needs exactly one video', 'bad_reel');
      const { rows: [p] } = await db.query(
        'INSERT INTO posts (author_id, kind, text, audience) VALUES ($1, $2, $3, $4) RETURNING id', [me, kind, text, audience]);
      for (const [i, mid] of mediaIds.entries()) {
        await db.query('INSERT INTO post_media (post_id, media_id, position) VALUES ($1, $2, $3)', [p.id, mid, i]);
      }
      return p.id;
    });
    const [post] = await hydratePosts(pool, me, [id]);
    return reply.code(201).send(post);
  });

  app.get('/posts/:id', { schema: { params: idParam } }, async (req) => {
    await visiblePost(pool, req.user.id, req.params.id);
    return (await hydratePosts(pool, req.user.id, [req.params.id]))[0];
  });

  app.patch('/posts/:id', {
    schema: {
      params: idParam,
      body: { type: 'object', properties: { text: { type: 'string', maxLength: 5000 }, audience: { enum: AUDIENCES } } },
    },
  }, async (req) => {
    const { rows } = await pool.query(
      `UPDATE posts SET text = COALESCE($3, text), audience = COALESCE($4, audience)
        WHERE id = $1 AND author_id = $2 AND deleted_at IS NULL RETURNING id`,
      [req.params.id, req.user.id, req.body.text?.trim() ?? null, req.body.audience ?? null]);
    if (!rows.length) throw fail(404, 'Post not found', 'not_found');
    return (await hydratePosts(pool, req.user.id, [req.params.id]))[0];
  });

  app.delete('/posts/:id', { schema: { params: idParam } }, async (req) => {
    const isMod = ['admin', 'moderator'].includes(req.user.role);
    const { rows } = await pool.query(
      `UPDATE posts SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL AND (author_id = $2 OR $3) RETURNING id`,
      [req.params.id, req.user.id, isMod]);
    if (!rows.length) throw fail(404, 'Post not found', 'not_found');
    return { ok: true };
  });

  // ---------- التفاعلات ----------
  app.put('/posts/:id/reaction', {
    schema: { params: idParam, body: { type: 'object', required: ['type'], properties: { type: { enum: REACTIONS } } } },
  }, async (req) => {
    const me = req.user.id;
    const type = req.body.type;
    const notifyAuthor = await tx(pool, async (db) => {
      const post = await visiblePost(db, me, req.params.id);
      const { rows: old } = await db.query(
        'SELECT type FROM reactions WHERE post_id = $1 AND user_id = $2 FOR UPDATE', [post.id, me]);
      if (old[0]?.type === type) return null;
      if (old.length) {
        await db.query('UPDATE reactions SET type = $3, created_at = now() WHERE post_id = $1 AND user_id = $2', [post.id, me, type]);
        await db.query('UPDATE post_reaction_counts SET count = count - 1 WHERE post_id = $1 AND type = $2', [post.id, old[0].type]);
      } else {
        await db.query('INSERT INTO reactions (post_id, user_id, type) VALUES ($1, $2, $3)', [post.id, me, type]);
        await db.query('UPDATE posts SET reaction_count = reaction_count + 1 WHERE id = $1', [post.id]);
      }
      await db.query(
        `INSERT INTO post_reaction_counts (post_id, type, count) VALUES ($1, $2, 1)
         ON CONFLICT (post_id, type) DO UPDATE SET count = post_reaction_counts.count + 1`, [post.id, type]);
      return old.length ? null : post.author_id;
    });
    if (notifyAuthor) await notify(pool, { userId: notifyAuthor, actorId: me, type: 'reaction', entityId: req.params.id });
    return (await hydratePosts(pool, me, [req.params.id]))[0].reactions;
  });

  app.delete('/posts/:id/reaction', { schema: { params: idParam } }, async (req) => {
    const me = req.user.id;
    await tx(pool, async (db) => {
      const { rows } = await db.query('DELETE FROM reactions WHERE post_id = $1 AND user_id = $2 RETURNING type', [req.params.id, me]);
      if (rows.length) {
        await db.query('UPDATE posts SET reaction_count = reaction_count - 1 WHERE id = $1', [req.params.id]);
        await db.query('UPDATE post_reaction_counts SET count = count - 1 WHERE post_id = $1 AND type = $2', [req.params.id, rows[0].type]);
      }
    });
    return { ok: true };
  });

  app.get('/posts/:id/reactions', { schema: { params: idParam, querystring: pageQuery } }, async (req) => {
    const me = req.user.id;
    await visiblePost(pool, me, req.params.id);
    const { limit } = req.query;
    const [ct, cid] = decodeCursor(req.query.cursor);
    const { rows } = await pool.query(
      `SELECT u.id, u.name, u.handle, u.avatar_media_id, r.type, r.created_at
         FROM reactions r JOIN users u ON u.id = r.user_id
        WHERE r.post_id = $1 AND NOT is_blocked($2, r.user_id) AND u.status = 'active'
          AND ($3::timestamptz IS NULL OR (r.created_at, u.id) < ($3, $4::uuid))
        ORDER BY r.created_at DESC, u.id DESC LIMIT $5`, [req.params.id, me, ct, cid, limit + 1]);
    const p = page(rows, limit);
    p.items = p.items.map((r) => ({ user: publicUser(r), type: r.type }));
    return p;
  });

  // ---------- التعليقات ----------
  app.get('/posts/:id/comments', { schema: { params: idParam, querystring: pageQuery } }, async (req) => {
    const me = req.user.id;
    await visiblePost(pool, me, req.params.id);
    const { limit } = req.query;
    const [ct, cid] = decodeCursor(req.query.cursor);
    const { rows } = await pool.query(
      `SELECT c.id, c.post_id, c.parent_id, c.text, c.created_at, c.reaction_count,
              u.id AS a_id, u.name AS a_name, u.handle AS a_handle, u.avatar_media_id AS a_avatar_media_id,
              (SELECT type FROM comment_reactions cr WHERE cr.comment_id = c.id AND cr.user_id = $2) AS mine
         FROM comments c JOIN users u ON u.id = c.author_id AND u.status = 'active'
        WHERE c.post_id = $1 AND c.deleted_at IS NULL AND NOT is_blocked($2, c.author_id)
          AND ($3::timestamptz IS NULL OR (c.created_at, c.id) > ($3, $4::uuid))
        ORDER BY c.created_at, c.id LIMIT $5`, [req.params.id, me, ct, cid, limit + 1]);
    const p = page(rows, limit);
    p.items = p.items.map((c) => ({
      id: c.id, postId: c.post_id, parentId: c.parent_id, text: c.text, createdAt: c.created_at,
      author: publicUser(c, 'a_'), isMine: c.a_id === me, reactions: { total: c.reaction_count, mine: c.mine },
    }));
    return p;
  });

  app.post('/posts/:id/comments', {
    schema: {
      params: idParam,
      body: {
        type: 'object', required: ['text'],
        properties: { text: { type: 'string', minLength: 1, maxLength: 2000 }, parentId: { anyOf: [{ type: 'string', pattern: UUID }, { type: 'null' }] } },
      },
    },
  }, async (req, reply) => {
    const me = req.user.id;
    const text = req.body.text.trim();
    if (!text) throw fail(400, 'Comment is empty', 'empty_comment');
    const { comment, post, parentAuthor } = await tx(pool, async (db) => {
      const post = await visiblePost(db, me, req.params.id);
      let parentAuthor = null;
      if (req.body.parentId) {
        const { rows } = await db.query(
          'SELECT author_id FROM comments WHERE id = $1 AND post_id = $2 AND deleted_at IS NULL', [req.body.parentId, post.id]);
        if (!rows.length) throw fail(400, 'Invalid parent comment', 'bad_parent');
        parentAuthor = rows[0].author_id;
      }
      const { rows: [comment] } = await db.query(
        `INSERT INTO comments (post_id, author_id, parent_id, text) VALUES ($1, $2, $3, $4)
         RETURNING id, post_id, parent_id, text, created_at`, [post.id, me, req.body.parentId || null, text]);
      await db.query('UPDATE posts SET comment_count = comment_count + 1 WHERE id = $1', [post.id]);
      return { comment, post, parentAuthor };
    });
    await notify(pool, { userId: post.author_id, actorId: me, type: 'comment', entityId: post.id });
    if (parentAuthor && parentAuthor !== post.author_id) await notify(pool, { userId: parentAuthor, actorId: me, type: 'reply', entityId: post.id });
    return reply.code(201).send({
      id: comment.id, postId: comment.post_id, parentId: comment.parent_id, text: comment.text,
      createdAt: comment.created_at, isMine: true, reactions: { total: 0, mine: null },
    });
  });

  app.delete('/comments/:id', { schema: { params: idParam } }, async (req) => {
    const me = req.user.id;
    const isMod = ['admin', 'moderator'].includes(req.user.role);
    await tx(pool, async (db) => {
      // يمكن لكاتب التعليق أو صاحب المنشور أو المشرف حذف التعليق
      const { rows } = await db.query(
        `UPDATE comments c SET deleted_at = now() FROM posts p
          WHERE c.id = $1 AND p.id = c.post_id AND c.deleted_at IS NULL AND (c.author_id = $2 OR p.author_id = $2 OR $3)
          RETURNING c.post_id`, [req.params.id, me, isMod]);
      if (!rows.length) throw fail(404, 'Comment not found', 'not_found');
      await db.query('UPDATE posts SET comment_count = GREATEST(comment_count - 1, 0) WHERE id = $1', [rows[0].post_id]);
    });
    return { ok: true };
  });

  async function visibleComment(db, viewer, id) {
    const { rows } = await db.query(
      `SELECT c.id, c.author_id FROM comments c JOIN posts p ON p.id = c.post_id
        WHERE c.id = $1 AND c.deleted_at IS NULL AND p.deleted_at IS NULL AND can_view($2, p.author_id, p.audience)
          AND NOT is_blocked($2, c.author_id)`, [id, viewer]);
    if (!rows[0]) throw fail(404, 'Comment not found', 'not_found');
    return rows[0];
  }

  app.put('/comments/:id/reaction', {
    schema: { params: idParam, body: { type: 'object', required: ['type'], properties: { type: { enum: REACTIONS } } } },
  }, async (req) => {
    const me = req.user.id;
    return tx(pool, async (db) => {
      const c = await visibleComment(db, me, req.params.id);
      const { rows } = await db.query(
        `INSERT INTO comment_reactions (comment_id, user_id, type) VALUES ($1, $2, $3)
         ON CONFLICT (comment_id, user_id) DO UPDATE SET type = EXCLUDED.type
         RETURNING (xmax = 0) AS inserted`, [c.id, me, req.body.type]);
      const { rows: [r] } = rows[0].inserted
        ? await db.query('UPDATE comments SET reaction_count = reaction_count + 1 WHERE id = $1 RETURNING reaction_count', [c.id])
        : await db.query('SELECT reaction_count FROM comments WHERE id = $1', [c.id]);
      return { total: r.reaction_count, mine: req.body.type };
    });
  });

  app.delete('/comments/:id/reaction', { schema: { params: idParam } }, async (req) => {
    await tx(pool, async (db) => {
      const { rows } = await db.query('DELETE FROM comment_reactions WHERE comment_id = $1 AND user_id = $2 RETURNING 1', [req.params.id, req.user.id]);
      if (rows.length) await db.query('UPDATE comments SET reaction_count = reaction_count - 1 WHERE id = $1', [req.params.id]);
    });
    return { ok: true };
  });
};
