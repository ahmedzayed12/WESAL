'use strict';
// منح دور المشرف لحساب: node scripts/make-admin.js <handle> [admin|moderator|user]
const { createPool } = require('../src/db');

(async () => {
  const [handle, role = 'admin'] = process.argv.slice(2);
  if (!handle || !['admin', 'moderator', 'user'].includes(role)) {
    console.error('usage: node scripts/make-admin.js <handle> [admin|moderator|user]');
    process.exit(2);
  }
  const pool = createPool();
  const { rowCount } = await pool.query('UPDATE users SET role = $2 WHERE lower(handle) = lower($1)', [handle, role]);
  // إبطال الجلسات ليُطبَّق الدور الجديد فورًا
  await pool.query('DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE lower(handle) = lower($1))', [handle]);
  console.log(rowCount ? `@${handle} is now ${role} (please log in again)` : `user @${handle} not found`);
  await pool.end();
  process.exit(rowCount ? 0 : 1);
})();
