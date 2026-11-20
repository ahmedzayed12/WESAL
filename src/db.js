'use strict';
const { Pool } = require('pg');
const { config } = require('./config');

function createPool(url = config.databaseUrl) {
  const pool = new Pool({
    connectionString: url,
    max: config.dbPoolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
    ssl: config.dbSsl ? { rejectUnauthorized: false } : undefined,
    application_name: 'wesal',
  });
  pool.on('error', (err) => console.error('pg pool error', err));
  return pool;
}

async function tx(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { createPool, tx };
