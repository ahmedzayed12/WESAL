'use strict';
const { fail } = require('./errors');

const AUDIENCES = ['public', 'friends', 'followers', 'friends_and_followers', 'only_me'];
const REACTIONS = ['like', 'love', 'laugh', 'wow', 'sad', 'clap', 'fire', 'think', 'idea', 'support'];
const UUID = '^[0-9a-fA-F-]{36}$';

const mediaUrl = (id) => (id ? `/media/${id}` : null);

// مؤشر ترقيم الصفحات (keyset): ثابت الأداء مهما كبر حجم الجدول، بعكس OFFSET
function encodeCursor(row, field = 'created_at') {
  if (!row) return null;
  const t = row[field] instanceof Date ? row[field].toISOString() : String(row[field]);
  return Buffer.from(JSON.stringify([t, String(row.id)])).toString('base64url');
}
function decodeCursor(cursor) {
  if (!cursor) return [null, null];
  try {
    const [t, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (Number.isNaN(Date.parse(t)) || typeof id !== 'string') throw new Error();
    return [t, id];
  } catch {
    throw fail(400, 'Invalid cursor', 'bad_cursor');
  }
}
function page(rows, limit, field) {
  const items = rows.slice(0, limit);
  return { items, nextCursor: rows.length > limit ? encodeCursor(items[items.length - 1], field) : null };
}

const pageQuery = {
  type: 'object',
  properties: {
    cursor: { type: 'string', maxLength: 200 },
    limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
  },
};

function publicUser(r, prefix = '') {
  return {
    id: r[prefix + 'id'],
    name: r[prefix + 'name'],
    handle: r[prefix + 'handle'],
    avatar: mediaUrl(r[prefix + 'avatar_media_id']),
  };
}

// جلب بيانات العرض الكاملة لمجموعة منشورات بعد اختيار معرّفاتها (استعلام واحد)
async function hydratePosts(db, viewer, ids) {
  if (!ids.length) return [];
  const { rows } = await db.query(
    `SELECT p.id, p.kind, p.text, p.audience, p.created_at, p.reaction_count, p.comment_count,
            u.id AS a_id, u.name AS a_name, u.handle AS a_handle, u.avatar_media_id AS a_avatar_media_id,
            (SELECT type FROM reactions r WHERE r.post_id = p.id AND r.user_id = $1) AS mine,
            (SELECT COALESCE(json_object_agg(c.type, c.count) FILTER (WHERE c.count > 0), '{}')
               FROM post_reaction_counts c WHERE c.post_id = p.id) AS counts,
            (SELECT COALESCE(json_agg(json_build_object('id', m.id, 'type', m.kind) ORDER BY pm.position), '[]')
               FROM post_media pm JOIN media m ON m.id = pm.media_id WHERE pm.post_id = p.id) AS media
       FROM posts p JOIN users u ON u.id = p.author_id
      WHERE p.id = ANY($2::uuid[])`, [viewer, ids]);
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)).filter(Boolean).map((r) => ({
    id: r.id,
    kind: r.kind,
    text: r.text,
    audience: r.audience,
    createdAt: r.created_at,
    author: publicUser(r, 'a_'),
    isMine: r.a_id === viewer,
    media: r.media.map((m) => ({ id: m.id, type: m.type, url: mediaUrl(m.id) })),
    reactions: { total: r.reaction_count, mine: r.mine, counts: r.counts },
    commentCount: r.comment_count,
  }));
}

async function notify(db, { userId, actorId, type, entityId = null }) {
  if (!userId || userId === actorId) return;
  await db.query(
    `INSERT INTO notifications (user_id, actor_id, type, entity_id)
     SELECT $1, $2, $3, $4 WHERE NOT is_blocked($1, $2)`, [userId, actorId, type, entityId]);
}

module.exports = { AUDIENCES, REACTIONS, UUID, mediaUrl, encodeCursor, decodeCursor, page, pageQuery, publicUser, hydratePosts, notify };
