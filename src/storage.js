'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'video/mp4': 'mp4', 'video/webm': 'webm' };

// التحقق من التوقيع الفعلي للملف (magic bytes) وليس من نوع MIME المُعلن فقط
function signatureMatches(mime, b) {
  if (!b || b.length < 12) return false;
  switch (mime) {
    case 'image/jpeg': return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    case 'image/png': return b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    case 'image/webp': return b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP';
    case 'video/mp4': return b.toString('ascii', 4, 8) === 'ftyp';
    case 'video/webm': return b.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
    default: return false;
  }
}

// تخزين محلي: مناسب للتطوير أو لخادم واحد. للتوسع الأفقي استخدم s3.
class LocalStorage {
  constructor({ uploadDir }) {
    this.driver = 'local';
    this.dir = path.resolve(uploadDir);
    fs.mkdirSync(this.dir, { recursive: true });
  }
  file(key) {
    if (!/^[a-f0-9-]{36}\.(jpg|png|webp|mp4|webm)$/.test(key)) throw new Error('bad storage key');
    return path.join(this.dir, key);
  }
  async createUpload({ id }) {
    return { method: 'PUT', url: `/api/v1/media/${id}/blob`, headers: { 'x-requested-with': 'fetch' } };
  }
  async write(key, stream, maxBytes) {
    const tmp = this.file(key) + '.part';
    let size = 0;
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        size += chunk.length;
        if (size > maxBytes) return cb(Object.assign(new Error('Media too large'), { statusCode: 413 }));
        cb(null, chunk);
      },
    });
    try {
      await pipeline(stream, counter, fs.createWriteStream(tmp, { flags: 'w' }));
      await fsp.rename(tmp, this.file(key));
    } catch (err) {
      await fsp.unlink(tmp).catch(() => {});
      throw err;
    }
    return size;
  }
  async head(key) {
    try { return { size: (await fsp.stat(this.file(key))).size }; } catch { return null; }
  }
  async readStart(key, n = 16) {
    const fh = await fsp.open(this.file(key), 'r');
    try {
      const buf = Buffer.alloc(n);
      const { bytesRead } = await fh.read(buf, 0, n, 0);
      return buf.subarray(0, bytesRead);
    } finally { await fh.close(); }
  }
  async remove(key) { await fsp.unlink(this.file(key)).catch(() => {}); }
  async ping() { await fsp.access(this.dir, fs.constants.W_OK); }
}

// تخزين S3 (AWS S3 / Cloudflare R2 / MinIO / DigitalOcean Spaces):
// الرفع يتم مباشرة من المتصفح إلى التخزين عبر روابط موقّعة، فلا يمر عبر خوادم التطبيق.
class S3Storage {
  constructor(opts) {
    const cmd = require('@aws-sdk/client-s3');
    this.driver = 's3';
    this.bucket = opts.bucket;
    const base = {
      region: opts.region,
      forcePathStyle: opts.forcePathStyle,
      credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
    };
    this.client = new cmd.S3Client({ ...base, endpoint: opts.endpoint });
    // عميل منفصل لتوقيع الروابط بعنوان يصل إليه المتصفح
    this.signer = new cmd.S3Client({ ...base, endpoint: opts.publicEndpoint });
    this.cmd = cmd;
    this.presign = require('@aws-sdk/s3-request-presigner').getSignedUrl;
  }
  async createUpload({ key, mime, size }) {
    const url = await this.presign(this.signer, new this.cmd.PutObjectCommand({
      Bucket: this.bucket, Key: key, ContentType: mime, ContentLength: size,
    }), { expiresIn: 900 });
    return { method: 'PUT', url, headers: { 'content-type': mime } };
  }
  async head(key) {
    try {
      const r = await this.client.send(new this.cmd.HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { size: Number(r.ContentLength) };
    } catch (err) {
      if (err.$metadata?.httpStatusCode === 404 || err.name === 'NotFound') return null;
      throw err;
    }
  }
  async readStart(key, n = 16) {
    const r = await this.client.send(new this.cmd.GetObjectCommand({ Bucket: this.bucket, Key: key, Range: `bytes=0-${n - 1}` }));
    return Buffer.from(await r.Body.transformToByteArray());
  }
  async signedGet(key, mime) {
    return this.presign(this.signer, new this.cmd.GetObjectCommand({
      Bucket: this.bucket, Key: key, ResponseContentType: mime,
    }), { expiresIn: 600 });
  }
  async remove(key) {
    await this.client.send(new this.cmd.DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
  async ping() {
    await this.client.send(new this.cmd.HeadBucketCommand({ Bucket: this.bucket }));
  }
}

function createStorage(opts) {
  return opts.driver === 's3' ? new S3Storage(opts) : new LocalStorage(opts);
}

module.exports = { createStorage, signatureMatches, EXT };
