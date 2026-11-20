'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, client, registerUser, uploadMedia, PNG, MP4 } = require('./helpers');
const { runOnce } = require('../src/worker');

let ctx, ahmed, sara, mohamed;

before(async () => {
  ctx = await setup();
  ahmed = await registerUser(ctx.app, 'ahmed');
  sara = await registerUser(ctx.app, 'sara');
  mohamed = await registerUser(ctx.app, 'mohamed');
  await sara('PATCH', '/api/v1/me/profile', { private: true });
});
after(async () => { await ctx.close(); });

test('health and readiness', async () => {
  const c = client(ctx.app);
  assert.equal((await c('GET', '/healthz')).status, 200);
  const r = await c('GET', '/readyz');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.checks, { db: 'ok', redis: 'ok' });
});

test('auth: register validation, duplicate, login, logout, me', async () => {
  const c = client(ctx.app);
  assert.equal((await c('GET', '/api/v1/auth/me')).status, 401);
  assert.equal((await c('POST', '/api/v1/auth/register', { name: 'x', handle: 'a b', email: 'bad', password: 'short' })).status, 400);
  const dup = await c('POST', '/api/v1/auth/register', { name: 'X', handle: 'AHMED', email: 'new@example.com', password: 'long enough pw' });
  assert.equal(dup.status, 409);
  assert.equal((await c('POST', '/api/v1/auth/login', { login: 'ahmed', password: 'wrong password' })).status, 401);
  const ok = await c('POST', '/api/v1/auth/login', { login: 'AHMED@example.com', password: 'correct horse battery' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.handle, 'ahmed');
  assert.match(String(ok.headers['set-cookie']), /HttpOnly/i);
  assert.equal((await c('GET', '/api/v1/auth/me')).body.id, ahmed.user.id);
  await c('POST', '/api/v1/auth/logout');
  assert.equal((await c('GET', '/api/v1/auth/me')).status, 401);
  // كلمة المرور غير مخزنة كنص صريح
  const { rows } = await ctx.pool.query('SELECT password_hash FROM users WHERE handle = $1', ['ahmed']);
  assert.match(rows[0].password_hash, /^scrypt\$/);
});

test('csrf: writes need X-Requested-With and an allowed origin', async () => {
  const noHeader = await ctx.app.inject({ method: 'POST', url: '/api/v1/posts', headers: { cookie: ahmed.cookie() }, payload: { text: 'x', audience: 'public' } });
  assert.equal(noHeader.statusCode, 403);
  const evil = await ahmed('POST', '/api/v1/posts', { text: 'x', audience: 'public' }, { origin: 'https://evil.example' });
  assert.equal(evil.status, 403);
});

test('private account: follow is pending until approved', async () => {
  const f = await ahmed('POST', `/api/v1/users/${sara.user.id}/follow`);
  assert.equal(f.body.status, 'pending');
  const reqs = await sara('GET', '/api/v1/me/follow-requests');
  assert.equal(reqs.body.items[0].id, ahmed.user.id);
  await sara('POST', `/api/v1/follow-requests/${ahmed.user.id}/accept`);
  const prof = await ahmed('GET', '/api/v1/users/sara/profile');
  assert.equal(prof.body.followStatus, 'accepted');
  assert.equal(prof.body.isFriend, false);
});

test('friend request accept creates friendship independent of follow', async () => {
  const r = await ahmed('POST', `/api/v1/users/${mohamed.user.id}/friend-request`);
  assert.equal(r.body.status, 'pending');
  const again = await ahmed('POST', `/api/v1/users/${mohamed.user.id}/friend-request`);
  assert.equal(again.body.id, r.body.id, 'idempotent');
  const incoming = await mohamed('GET', '/api/v1/friend-requests');
  assert.equal(incoming.body.items[0].direction, 'incoming');
  assert.equal((await ahmed('POST', `/api/v1/friend-requests/${r.body.id}/accept`)).status, 404, 'sender cannot accept');
  assert.equal((await mohamed('POST', `/api/v1/friend-requests/${r.body.id}/accept`)).body.status, 'accepted');
  const p = await ahmed('GET', `/api/v1/users/${mohamed.user.id}/profile`);
  assert.equal(p.body.isFriend, true);
  assert.equal(p.body.followStatus, null);
  assert.equal((await mohamed('GET', '/api/v1/me/friends')).body.items[0].id, ahmed.user.id);
});

test('post audiences are enforced in feed, explore and direct fetch', async () => {
  const friendsOnly = await ahmed('POST', '/api/v1/posts', { text: 'للأصدقاء فقط', audience: 'friends' });
  assert.equal(friendsOnly.status, 201);
  const followersOnly = await sara('POST', '/api/v1/posts', { text: 'للمتابعين', audience: 'followers' });
  const onlyMe = await ahmed('POST', '/api/v1/posts', { text: 'خاص', audience: 'only_me' });

  const feedM = await mohamed('GET', '/api/v1/feed');
  assert.ok(feedM.body.items.some((p) => p.id === friendsOnly.body.id), 'friend sees friends post');
  assert.ok(!feedM.body.items.some((p) => p.id === onlyMe.body.id));
  assert.equal((await sara('GET', `/api/v1/posts/${friendsOnly.body.id}`)).status, 404, 'non-friend cannot fetch');
  assert.ok((await ahmed('GET', '/api/v1/feed')).body.items.some((p) => p.id === followersOnly.body.id), 'approved follower sees');
  assert.equal((await mohamed('GET', `/api/v1/posts/${followersOnly.body.id}`)).status, 404);
  const explore = await mohamed('GET', '/api/v1/explore');
  assert.ok(explore.body.items.every((p) => p.audience === 'public'));
});

test('feed cursor pagination returns every post exactly once', async () => {
  const c = await registerUser(ctx.app, 'pager');
  const ids = [];
  for (let i = 0; i < 7; i++) ids.push((await c('POST', '/api/v1/posts', { text: 'p' + i, audience: 'public' })).body.id);
  const seen = [];
  let cursor = null;
  do {
    const r = await c('GET', `/api/v1/feed?limit=3${cursor ? '&cursor=' + cursor : ''}`);
    seen.push(...r.body.items.map((p) => p.id));
    cursor = r.body.nextCursor;
  } while (cursor);
  assert.deepEqual(seen, ids.reverse());
  assert.equal((await c('GET', '/api/v1/feed?cursor=garbage')).status, 400);
});

test('reactions are idempotent and counted per type', async () => {
  const p = await ahmed('POST', '/api/v1/posts', { text: 'عام', audience: 'public' });
  await mohamed('PUT', `/api/v1/posts/${p.body.id}/reaction`, { type: 'love' });
  const r = await mohamed('PUT', `/api/v1/posts/${p.body.id}/reaction`, { type: 'like' });
  assert.equal(r.body.total, 1);
  assert.deepEqual(r.body.counts, { like: 1 });
  await sara('PUT', `/api/v1/posts/${p.body.id}/reaction`, { type: 'like' });
  const got = await ahmed('GET', `/api/v1/posts/${p.body.id}`);
  assert.equal(got.body.reactions.total, 2);
  assert.equal(got.body.reactions.counts.like, 2);
  await mohamed('DELETE', `/api/v1/posts/${p.body.id}/reaction`);
  assert.equal((await ahmed('GET', `/api/v1/posts/${p.body.id}`)).body.reactions.total, 1);
  assert.equal((await mohamed('PUT', `/api/v1/posts/${p.body.id}/reaction`, { type: 'nope' })).status, 400);
});

test('comments, replies, comment reactions and notifications', async () => {
  const p = await ahmed('POST', '/api/v1/posts', { text: 'ناقشوا', audience: 'public' });
  const c1 = await mohamed('POST', `/api/v1/posts/${p.body.id}/comments`, { text: 'أول' });
  assert.equal(c1.status, 201);
  const reply = await ahmed('POST', `/api/v1/posts/${p.body.id}/comments`, { text: 'رد', parentId: c1.body.id });
  assert.equal(reply.body.parentId, c1.body.id);
  const cr = await ahmed('PUT', `/api/v1/comments/${c1.body.id}/reaction`, { type: 'clap' });
  assert.equal(cr.body.total, 1);
  const list = await sara('GET', `/api/v1/posts/${p.body.id}/comments`);
  assert.equal(list.body.items.length, 2);
  assert.equal(list.body.items[0].reactions.total, 1);
  assert.equal((await ahmed('GET', `/api/v1/posts/${p.body.id}`)).body.commentCount, 2);
  const notes = await ahmed('GET', '/api/v1/notifications');
  assert.ok(notes.body.items.some((n) => n.type === 'comment' && n.actor.id === mohamed.user.id));
  assert.ok((await mohamed('GET', '/api/v1/notifications')).body.items.some((n) => n.type === 'reply'));
});

test('media: streamed upload, signature check, post, access control', async () => {
  const fake = await ahmed('POST', '/api/v1/media/uploads', { mime: 'image/png', size: 32 });
  await ahmed('PUT', fake.body.upload.url, Buffer.alloc(32, 7), { 'content-type': 'image/png' });
  assert.equal((await ahmed('POST', `/api/v1/media/${fake.body.id}/complete`)).status, 415, 'non-PNG bytes rejected');
  assert.equal((await ahmed('POST', '/api/v1/media/uploads', { mime: 'image/gif', size: 32 })).status, 400);
  assert.equal((await ahmed('POST', '/api/v1/media/uploads', { mime: 'image/png', size: 999e6 })).status, 413);

  const img = await uploadMedia(ahmed, PNG, 'image/png');
  assert.equal(img.type, 'image');
  // لا يمكن لمستخدم آخر استخدام وسائط ليست له
  assert.equal((await mohamed('POST', '/api/v1/posts', { text: '', audience: 'public', media: [img.id] })).status, 400);
  const post = await ahmed('POST', '/api/v1/posts', { text: '', audience: 'friends', media: [img.id] });
  assert.equal(post.status, 201);
  assert.equal(post.body.media[0].url, `/media/${img.id}`);
  assert.equal((await ahmed('POST', '/api/v1/posts', { text: 'x', audience: 'public', media: [img.id] })).status, 400, 'media reuse rejected');
  const asFriend = await mohamed('GET', `/media/${img.id}`);
  assert.equal(asFriend.status, 200);
  assert.equal(asFriend.headers['content-type'], 'image/png');
  assert.equal((await sara('GET', `/media/${img.id}`)).status, 404, 'non-friend blocked');
  assert.equal((await client(ctx.app)('GET', `/media/${img.id}`)).status, 401);
});

test('reels require exactly one video', async () => {
  const img = await uploadMedia(mohamed, PNG, 'image/png');
  assert.equal((await mohamed('POST', '/api/v1/posts', { text: '', audience: 'public', kind: 'reel', media: [img.id] })).status, 400);
  const vid = await uploadMedia(mohamed, MP4, 'video/mp4');
  const reel = await mohamed('POST', '/api/v1/posts', { text: 'ريل', audience: 'public', kind: 'reel', media: [vid.id] });
  assert.equal(reel.status, 201);
  assert.ok((await sara('GET', '/api/v1/reels')).body.items.some((p) => p.id === reel.body.id));
});

test('stories are visible for 24h then cleaned up with their media', async () => {
  const img = await uploadMedia(ahmed, PNG, 'image/png');
  const story = await ahmed('POST', '/api/v1/stories', { media: img.id, audience: 'public' });
  assert.equal(story.status, 201);
  assert.ok((await mohamed('GET', '/api/v1/stories')).body.items.some((s) => s.id === story.body.id));
  await ctx.pool.query(`UPDATE stories SET expires_at = now() - interval '1 minute' WHERE id = $1`, [story.body.id]);
  assert.ok(!(await mohamed('GET', '/api/v1/stories')).body.items.some((s) => s.id === story.body.id));
  assert.equal((await mohamed('GET', `/media/${img.id}`)).status, 404);
  const stats = await runOnce(ctx.pool, ctx.storage, { warn() {} });
  assert.ok(stats.expiredStories >= 1);
  assert.equal((await ctx.pool.query('SELECT 1 FROM media WHERE id = $1', [img.id])).rowCount, 0);
});

test('profile photo is shown to others', async () => {
  const img = await uploadMedia(mohamed, PNG, 'image/png');
  const r = await mohamed('PATCH', '/api/v1/me/profile', { avatar: img.id, bio: 'مرحبًا' });
  assert.equal(r.body.avatar, `/media/${img.id}`);
  assert.equal((await ahmed('GET', '/api/v1/me/friends')).body.items.find((u) => u.id === mohamed.user.id).avatar, `/media/${img.id}`);
  assert.equal((await sara('GET', `/media/${img.id}`)).status, 200);
});

test('block removes friendship, follows and visibility both ways', async () => {
  const p = await ahmed('POST', '/api/v1/posts', { text: 'قبل الحظر', audience: 'public' });
  await mohamed('POST', `/api/v1/users/${ahmed.user.id}/block`);
  assert.equal((await ahmed('GET', `/api/v1/users/${mohamed.user.id}/profile`)).status, 404);
  assert.equal((await mohamed('GET', `/api/v1/posts/${p.body.id}`)).status, 404);
  assert.ok(!(await mohamed('GET', '/api/v1/explore')).body.items.some((x) => x.author.id === ahmed.user.id));
  assert.equal((await ahmed('POST', `/api/v1/users/${mohamed.user.id}/friend-request`)).status, 404);
  const prof = await mohamed('GET', `/api/v1/users/${ahmed.user.id}/profile`);
  assert.equal(prof.body.isBlockedByMe, true);
  assert.equal(prof.body.isFriend, false);
  await mohamed('DELETE', `/api/v1/users/${ahmed.user.id}/block`);
  assert.equal((await mohamed('GET', `/api/v1/posts/${p.body.id}`)).status, 200);
});

test('reports and moderation: suspend revokes sessions', async () => {
  const troll = await registerUser(ctx.app, 'troll');
  const p = await troll('POST', '/api/v1/posts', { text: 'spam', audience: 'public' });
  assert.equal((await sara('POST', '/api/v1/reports', { targetType: 'post', targetId: p.body.id, reason: 'spam content' })).status, 201);
  assert.equal((await sara('GET', '/api/v1/admin/reports')).status, 403);
  await ctx.pool.query(`UPDATE users SET role = 'admin' WHERE handle = 'ahmed'`);
  await ctx.redis.flushdb(); // تفريغ ذاكرة الجلسات لتطبيق الدور الجديد
  const reports = await ahmed('GET', '/api/v1/admin/reports');
  const rep = reports.body.items.find((r) => r.targetId === p.body.id);
  assert.ok(rep);
  assert.equal((await ahmed('POST', `/api/v1/admin/reports/${rep.id}/resolve`, { action: 'suspend_user' })).status, 200);
  assert.equal((await troll('GET', '/api/v1/auth/me')).status, 401);
  assert.equal((await troll('POST', '/api/v1/auth/login', { login: 'troll', password: 'correct horse battery' })).status, 403);
  assert.ok(!(await sara('GET', '/api/v1/explore')).body.items.some((x) => x.id === p.body.id), 'suspended content hidden');
});

test('account deletion removes user data', async () => {
  const temp = await registerUser(ctx.app, 'temp');
  await uploadMedia(temp, PNG, 'image/png');
  await temp('POST', '/api/v1/posts', { text: 'bye', audience: 'public' });
  assert.equal((await temp('DELETE', '/api/v1/me', { password: 'wrong' })).status, 401);
  assert.equal((await temp('DELETE', '/api/v1/me', { password: 'correct horse battery' })).status, 200);
  assert.equal((await ctx.pool.query(`SELECT 1 FROM users WHERE handle = 'temp'`)).rowCount, 0);
  assert.equal((await temp('GET', '/api/v1/auth/me')).status, 401);
});

test('rate limiter blocks bursts', async () => {
  const { config } = require('../src/config');
  config.rateLimit.enabled = true;
  try {
    const c = client(ctx.app);
    let last;
    for (let i = 0; i < config.rateLimit.authPerMinute + 1; i++) last = await c('POST', '/api/v1/auth/login', { login: 'nobody', password: 'x' });
    assert.equal(last.status, 429);
  } finally {
    config.rateLimit.enabled = false;
  }
});
