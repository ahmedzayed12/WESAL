'use strict';
const env = process.env;
const bool = (v, d) => (v === undefined || v === '' ? d : ['1', 'true', 'yes'].includes(String(v).toLowerCase()));
const int = (v, d) => (v === undefined || v === '' ? d : Number.parseInt(v, 10));

const production = env.NODE_ENV === 'production';

const config = {
  production,
  host: env.HOST || '0.0.0.0',
  port: int(env.PORT, 3000),
  logLevel: env.LOG_LEVEL || (production ? 'info' : 'debug'),
  trustProxy: bool(env.TRUST_PROXY, production),
  // الأصول المسموح بها لطلبات التعديل (حماية CSRF). مفصولة بفواصل.
  appOrigins: (env.APP_ORIGIN || `http://localhost:${int(env.PORT, 3000)}`).split(',').map((s) => s.trim()).filter(Boolean),
  databaseUrl: env.DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/wesal',
  dbPoolMax: int(env.DATABASE_POOL_MAX, 20),
  dbSsl: bool(env.DATABASE_SSL, false),
  redisUrl: env.REDIS_URL || 'redis://127.0.0.1:6379',
  cookieSecure: bool(env.COOKIE_SECURE, production),
  sessionDays: int(env.SESSION_DAYS, 30),
  storage: {
    driver: env.STORAGE_DRIVER || 'local',
    uploadDir: env.UPLOAD_DIR || require('node:path').join(__dirname, '..', 'uploads'),
    bucket: env.S3_BUCKET,
    region: env.S3_REGION || 'us-east-1',
    endpoint: env.S3_ENDPOINT || undefined,
    publicEndpoint: env.S3_PUBLIC_ENDPOINT || env.S3_ENDPOINT || undefined,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    forcePathStyle: bool(env.S3_FORCE_PATH_STYLE, false),
  },
  limits: {
    imageBytes: int(env.MAX_IMAGE_MB, 10) * 1024 * 1024,
    videoBytes: int(env.MAX_VIDEO_MB, 100) * 1024 * 1024,
  },
  rateLimit: {
    enabled: bool(env.RATE_LIMIT_ENABLED, true),
    authPerMinute: int(env.RATE_LIMIT_AUTH, 10),
    writePerMinute: int(env.RATE_LIMIT_WRITE, 120),
    readPerMinute: int(env.RATE_LIMIT_READ, 900),
  },
};

function validate() {
  const problems = [];
  if (config.storage.driver === 's3') {
    for (const k of ['bucket', 'accessKeyId', 'secretAccessKey']) if (!config.storage[k]) problems.push(`S3 setting missing: ${k}`);
  } else if (config.storage.driver !== 'local') problems.push('STORAGE_DRIVER must be local or s3');
  if (production && !config.cookieSecure) problems.push('COOKIE_SECURE must be true in production');
  if (production && config.appOrigins.some((o) => o.startsWith('http://localhost'))) problems.push('APP_ORIGIN must be set to the public https origin in production');
  if (problems.length) throw new Error('Invalid configuration:\n - ' + problems.join('\n - '));
}

module.exports = { config, validate };
