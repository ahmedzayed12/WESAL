'use strict';
// يملأ قاعدة بيانات (تجريبية فقط!) ببيانات حجمية لاختبار الأداء.
// node scripts/seed-benchmark.js [users=20000] [postsPerUser=25]
// جميع الحسابات بكلمة المرور: benchmark-pass
const { createPool } = require('../src/db');
const { hashPassword } = require('../src/auth');

(async () => {
  const users = Number(process.argv[2] || 20000);
  const per = Number(process.argv[3] || 25);
  if (process.env.NODE_ENV === 'production') throw new Error('refusing to seed a production database');
  const pool = createPool();
  const hash = await hashPassword('benchmark-pass');
  const db = await pool.connect();
  await db.query('SET statement_timeout = 0');
  console.time('seed');
  await db.query(
    `INSERT INTO users (name, handle, email, password_hash, is_private, created_at)
     SELECT 'مستخدم ' || g, 'bench' || g, 'bench' || g || '@example.com', $2, g % 10 = 0, now() - (g || ' seconds')::interval
       FROM generate_series(1, $1) g ON CONFLICT DO NOTHING`, [users, hash]);
  // جدول مرقّم مؤقت لتوليد علاقات حتمية بسرعة
  await db.query(`CREATE TEMP TABLE bu AS SELECT id, row_number() OVER (ORDER BY id) - 1 AS n FROM users WHERE handle LIKE 'bench%'`);
  await db.query('CREATE INDEX ON bu (n)');
  // كل مستخدم يتابع 150 حسابًا تقريبًا ولديه نحو 40 صديقًا
  await db.query(
    `INSERT INTO follows (follower_id, followee_id, status)
     SELECT a.id, b.id, 'accepted' FROM bu a CROSS JOIN generate_series(1, 150) k
       JOIN bu b ON b.n = (a.n * 7919 + k * 104729) % $1
      WHERE a.id <> b.id ON CONFLICT DO NOTHING`, [users]);
  await db.query(
    `INSERT INTO friendships (user_a, user_b)
     SELECT LEAST(a.id, b.id), GREATEST(a.id, b.id) FROM bu a CROSS JOIN generate_series(1, 20) k
       JOIN bu b ON b.n = (a.n + k * 31) % $1
      WHERE a.id <> b.id ON CONFLICT DO NOTHING`, [users]);
  await db.query(
    `INSERT INTO posts (author_id, text, audience, created_at)
     SELECT u.id, 'منشور تجريبي رقم ' || k,
            (ARRAY['public','public','public','friends','followers','friends_and_followers','only_me'])[1 + (k % 7)],
            now() - ((random() * 60 * 24 * 30) || ' minutes')::interval
       FROM users u CROSS JOIN generate_series(1, $1) k WHERE u.handle LIKE 'bench%'`, [per]);
  await db.query('ANALYZE');
  const { rows } = await db.query(`SELECT (SELECT count(*) FROM users) u, (SELECT count(*) FROM follows) f,
                                            (SELECT count(*) FROM friendships) fr, (SELECT count(*) FROM posts) p`);
  console.timeEnd('seed');
  console.log(rows[0]);
  db.release();
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
