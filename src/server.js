'use strict';
const Redis = require('ioredis');
const { config, validate } = require('./config');
const { createPool } = require('./db');
const { createStorage } = require('./storage');
const { buildApp } = require('./app');
const { migrate } = require('./migrate');

async function main() {
  validate();
  const pool = createPool();
  const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 2, enableOfflineQueue: false, lazyConnect: false });
  redis.on('error', (err) => console.error('redis error:', err.message));
  const storage = createStorage(config.storage);
  if (process.env.MIGRATE_ON_START === 'true') await migrate(pool);

  const app = buildApp({ pool, redis, storage });
  await app.listen({ host: config.host, port: config.port });

  // إيقاف رشيق: إنهاء الطلبات الجارية قبل الخروج (مهم للنشر دون انقطاع)
  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'shutting down');
    const timer = setTimeout(() => process.exit(1), 25_000);
    try {
      await app.close();
      await pool.end();
      redis.disconnect();
    } finally {
      clearTimeout(timer);
      process.exit(0);
    }
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
