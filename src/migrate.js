'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createPool } = require('./db');

const dir = path.join(__dirname, '..', 'migrations');

async function migrate(pool, log = console.log) {
  const client = await pool.connect();
  try {
    // قفل استشاري يمنع تشغيل الترحيل من أكثر من نسخة في وقت واحد
    await client.query('SELECT pg_advisory_lock(727001)');
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = new Set((await client.query('SELECT version FROM schema_migrations')).rows.map((r) => r.version));
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      if (done.has(file)) continue;
      log(`applying migration ${file}`);
      await client.query('BEGIN');
      try {
        await client.query(fs.readFileSync(path.join(dir, file), 'utf8'));
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727001)').catch(() => {});
    client.release();
  }
}

if (require.main === module) {
  const pool = createPool();
  migrate(pool)
    .then(() => console.log('migrations complete'))
    .catch((err) => { console.error(err); process.exitCode = 1; })
    .finally(() => pool.end());
}

module.exports = { migrate };
