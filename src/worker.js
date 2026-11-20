'use strict';
// عامل الخلفية: تنظيف القصص المنتهية، والرفوعات غير المكتملة، والوسائط اليتيمة، والجلسات المنتهية.
// يمكن تشغيل أكثر من نسخة بأمان: القفل الاستشاري يضمن أن نسخة واحدة فقط تعمل في كل دورة.
const { config, validate } = require('./config');
const { createPool } = require('./db');
const { createStorage } = require('./storage');

const LOCK = 727002;
const BATCH = 500;

async function removeMedia(pool, storage, rows, log) {
  for (const m of rows) {
    try {
      await storage.remove(m.storage_key);
      await pool.query('DELETE FROM media WHERE id = $1', [m.id]);
    } catch (err) {
      log.warn('media cleanup failed', m.id, err.message);
    }
  }
  return rows.length;
}

async function runOnce(pool, storage, log = console) {
  const client = await pool.connect();
  try {
    const { rows: [{ ok }] } = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [LOCK]);
    if (!ok) return { skipped: true };
    try {
      const stats = {};
      // 1) القصص المنتهية: حذف السجل ثم ملف الوسائط
      const { rows: stories } = await pool.query(
        `DELETE FROM stories WHERE id IN (SELECT id FROM stories WHERE expires_at < now() LIMIT ${BATCH}) RETURNING media_id`);
      const { rows: storyMedia } = stories.length
        ? await pool.query('SELECT id, storage_key FROM media WHERE id = ANY($1::uuid[])', [stories.map((s) => s.media_id)])
        : { rows: [] };
      stats.expiredStories = await removeMedia(pool, storage, storyMedia, log);

      // 2) منشورات محذوفة منذ أكثر من 30 يومًا: حذف نهائي مع وسائطها
      const { rows: oldPosts } = await pool.query(
        `SELECT id FROM posts WHERE deleted_at < now() - interval '30 days' LIMIT ${BATCH}`);
      if (oldPosts.length) {
        const ids = oldPosts.map((p) => p.id);
        const { rows: pm } = await pool.query(
          `SELECT m.id, m.storage_key FROM post_media pm JOIN media m ON m.id = pm.media_id WHERE pm.post_id = ANY($1::uuid[])`, [ids]);
        await pool.query('DELETE FROM posts WHERE id = ANY($1::uuid[])', [ids]);
        await removeMedia(pool, storage, pm, log);
      }
      stats.purgedPosts = oldPosts.length;

      // 3) رفوعات لم تكتمل أو وسائط لم تُستخدم خلال 24 ساعة
      const { rows: orphans } = await pool.query(
        `SELECT m.id, m.storage_key FROM media m
          WHERE m.created_at < now() - interval '24 hours'
            AND NOT EXISTS (SELECT 1 FROM post_media pm WHERE pm.media_id = m.id)
            AND NOT EXISTS (SELECT 1 FROM stories s WHERE s.media_id = m.id)
            AND NOT EXISTS (SELECT 1 FROM users u WHERE u.avatar_media_id = m.id)
          LIMIT ${BATCH}`);
      stats.orphanMedia = await removeMedia(pool, storage, orphans, log);

      // 4) الجلسات والإشعارات القديمة
      stats.sessions = (await pool.query('DELETE FROM sessions WHERE expires_at < now()')).rowCount;
      stats.notifications = (await pool.query(
        `DELETE FROM notifications WHERE id IN (SELECT id FROM notifications WHERE created_at < now() - interval '90 days' LIMIT 5000)`)).rowCount;
      return stats;
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK]);
    }
  } finally {
    client.release();
  }
}

if (require.main === module) {
  validate();
  const pool = createPool();
  const storage = createStorage(config.storage);
  const interval = Number(process.env.WORKER_INTERVAL_SECONDS || 60) * 1000;
  let stopping = false;
  const loop = async () => {
    while (!stopping) {
      try {
        const stats = await runOnce(pool, storage);
        if (!stats.skipped) console.log(JSON.stringify({ msg: 'cleanup', ...stats, time: new Date().toISOString() }));
      } catch (err) {
        console.error('worker cycle failed', err);
      }
      await new Promise((r) => setTimeout(r, interval));
    }
  };
  const stop = () => { stopping = true; pool.end().finally(() => process.exit(0)); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  loop();
}

module.exports = { runOnce };
