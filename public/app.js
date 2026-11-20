'use strict';
// وصال — واجهة المستخدم (بدون مكتبات خارجية)
const $ = (s) => document.querySelector(s);
const ICONS = { like: '👍', love: '❤️', laugh: '😂', wow: '😮', sad: '😢', clap: '👏', fire: '🔥', think: '🤔', idea: '💡', support: '🙏' };
const AUDIENCE = { public: '🌐 الجميع', friends: '👥 الأصدقاء', followers: '⭐ المتابعون', friends_and_followers: 'الأصدقاء والمتابعون', only_me: '🔒 أنا فقط' };
const NOTIF = {
  follow: 'بدأ متابعتك', follow_request: 'طلب متابعتك', follow_accepted: 'قبل طلب متابعتك',
  friend_request: 'أرسل إليك طلب صداقة', friend_accepted: 'قبل طلب صداقتك', reaction: 'تفاعل مع منشورك',
  comment: 'علّق على منشورك', reply: 'ردّ على تعليقك',
};
const ERRORS = {
  invalid_credentials: 'بيانات الدخول غير صحيحة', email_taken: 'البريد الإلكتروني مسجل مسبقًا', handle_taken: 'اسم المستخدم غير متاح',
  rate_limited: 'طلبات كثيرة، انتظر قليلًا', locked: 'محاولات كثيرة، حاول بعد 15 دقيقة', suspended: 'هذا الحساب موقوف',
  too_large: 'الملف أكبر من الحد المسموح', bad_signature: 'محتوى الملف لا يطابق نوعه', unauthenticated: 'يرجى تسجيل الدخول',
  not_found: 'العنصر غير موجود أو غير متاح', bad_media: 'الوسائط غير صالحة', validation: 'البيانات المدخلة غير صحيحة',
};
const MAX = { image: 10 * 1024 * 1024, video: 100 * 1024 * 1024 };

const state = { me: null, view: 'feed', profileId: null, cursor: null, pending: [], pendingKind: 'post', loading: false };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, method = 'GET', data) {
  const r = await fetch('/api/v1' + path, {
    method,
    credentials: 'same-origin',
    headers: data === undefined ? { 'x-requested-with': 'fetch' } : { 'content-type': 'application/json', 'x-requested-with': 'fetch' },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== '/auth/me' && !path.startsWith('/auth/')) { showAuth(); }
  if (!r.ok) throw Object.assign(new Error(ERRORS[j.code] || j.error || 'تعذر تنفيذ العملية'), { status: r.status, code: j.code });
  return j;
}

function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (isError ? ' error' : '');
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 3500);
}
async function run(fn) {
  try { await fn(); } catch (e) { toast(e.message, true); $('#uploadStatus').textContent = ''; }
}

const avatar = (u, size = '') => (u?.avatar
  ? `<img class="avatar-photo ${size}" src="${esc(u.avatar)}" alt="" loading="lazy">`
  : `<span class="avatar ${size}">${esc(u?.name?.[0] || 'و')}</span>`);
const userLink = (u) => `<button class="link" data-profile="${esc(u.id)}">${esc(u.name)}</button>`;

function timeAgo(iso) {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return 'الآن';
  if (s < 3600) return `منذ ${Math.floor(s / 60)} د`;
  if (s < 86400) return `منذ ${Math.floor(s / 3600)} س`;
  return new Date(iso).toLocaleDateString('ar', { day: 'numeric', month: 'short', year: 'numeric' });
}

// ---------------- المصادقة ----------------
function showAuth() {
  state.me = null;
  $('#appView').hidden = true;
  $('#authView').hidden = false;
}
async function boot() {
  try {
    state.me = await api('/auth/me');
  } catch { return showAuth(); }
  $('#authView').hidden = true;
  $('#appView').hidden = false;
  renderMe();
  await Promise.all([sidebar(), stories(), openView('feed')]);
}
function renderMe() {
  const me = state.me;
  $('#myProfile').innerHTML = `${avatar(me)}<div><strong>${esc(me.name)}</strong><small class="muted">@${esc(me.handle)}</small></div>`;
  $('#composerAvatar').innerHTML = avatar(me);
  $('#meButton').innerHTML = avatar(me, 'small');
  $('#privateToggle').checked = me.private;
  $('#adminNav').hidden = !['admin', 'moderator'].includes(me.role);
  const badge = $('#notifBadge');
  badge.hidden = !me.unreadNotifications;
  badge.textContent = me.unreadNotifications > 99 ? '99+' : me.unreadNotifications;
}

for (const [formId, path] of [['#loginForm', '/auth/login'], ['#registerForm', '/auth/register']]) {
  $(formId).addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#authMessage').textContent = '';
    try {
      await api(path, 'POST', Object.fromEntries(new FormData(e.target)));
      e.target.reset();
      await boot();
    } catch (err) { $('#authMessage').textContent = err.message; }
  });
}

// ---------------- الشريط الجانبي ----------------
async function sidebar() {
  const [reqs, follows, people, friends] = await Promise.all([
    api('/friend-requests'), api('/me/follow-requests'), api('/users?limit=8'), api('/me/friends?limit=12'),
  ]);
  $('#requests').innerHTML = reqs.items.filter((r) => r.direction === 'incoming').map((r) => `
    <div class="person"><div class="person-head">${avatar(r.fromUser)}<div><strong>${userLink(r.fromUser)}</strong><small>أرسل إليك طلب صداقة</small></div></div>
    <div class="person-actions"><button data-freq="${r.id}|accept">قبول</button><button data-freq="${r.id}|decline">رفض</button></div></div>`).join('')
    || '<p class="muted">لا توجد طلبات جديدة</p>';
  $('#followRequests').innerHTML = follows.items.map((u) => `
    <div class="person"><div class="person-head">${avatar(u)}<div><strong>${userLink(u)}</strong><small>@${esc(u.handle)}</small></div></div>
    <div class="person-actions"><button data-followreq="${u.id}|accept">قبول</button><button data-followreq="${u.id}|decline">رفض</button></div></div>`).join('')
    || '<p class="muted">لا توجد طلبات</p>';
  $('#people').innerHTML = renderPeople(people.items);
  $('#friends').innerHTML = friends.items.map((u) => `<div class="person"><div class="person-head">${avatar(u)}<div><strong>${userLink(u)}</strong><small>@${esc(u.handle)}</small></div></div></div>`).join('')
    || '<p class="muted">لم تضف أصدقاء بعد</p>';
}
function renderPeople(users) {
  return users.map((u) => `
    <div class="person"><div class="person-head">${avatar(u)}<div><strong>${userLink(u)} ${u.private ? '🔒' : ''}</strong><small>@${esc(u.handle)}</small></div></div>
    <div class="person-actions">
      ${u.followStatus ? `<button data-unfollow="${u.id}">${u.followStatus === 'pending' ? 'إلغاء الطلب' : 'إلغاء المتابعة'}</button>` : `<button data-follow="${u.id}">متابعة</button>`}
      ${u.isFriend ? '' : `<button data-friend="${u.id}">إضافة صديق</button>`}
    </div></div>`).join('') || '<p class="muted">لا يوجد أشخاص</p>';
}

// ---------------- العرض الرئيسي ----------------
const VIEWS = {
  feed: { title: 'آخر المنشورات', hint: 'من أصدقائك ومن تتابعهم', path: '/feed' },
  explore: { title: 'استكشاف', hint: 'أحدث المنشورات العامة', path: '/explore' },
  reels: { title: 'ريلز وصال', hint: 'فيديوهات قصيرة', path: '/reels' },
};

async function openView(view, profileId = null) {
  state.view = view;
  state.profileId = profileId;
  state.cursor = null;
  document.querySelectorAll('.nav').forEach((n) => n.classList.toggle('active',
    view === 'profile' ? n.dataset.profile === 'me' && profileId === state.me.id : n.dataset.tab === view));
  $('#composer').hidden = !['feed', 'explore', 'reels'].includes(view) && !(view === 'profile' && profileId === state.me.id);
  $('#storyStrip').hidden = !['feed', 'stories'].includes(view);
  $('#profileHeader').innerHTML = '';
  $('#feed').innerHTML = '<p class="muted center">جارٍ التحميل…</p>';
  $('#loadMore').hidden = true;
  if (VIEWS[view]) {
    $('#feedTitle').textContent = VIEWS[view].title;
    $('#feedHint').textContent = VIEWS[view].hint;
    $('#feed').innerHTML = '';
    return loadPosts();
  }
  if (view === 'profile') return showProfile(profileId);
  if (view === 'stories') return showStories();
  if (view === 'notifications') return showNotifications();
  if (view === 'admin') return showReports();
  if (view === 'search') return showSearch(profileId);
}

async function loadPosts() {
  if (state.loading) return;
  state.loading = true;
  try {
    const base = state.view === 'profile' ? `/users/${state.profileId}/posts` : VIEWS[state.view].path;
    const r = await api(`${base}?limit=15${state.cursor ? '&cursor=' + encodeURIComponent(state.cursor) : ''}`);
    $('#feed').insertAdjacentHTML('beforeend', r.items.map(renderPost).join(''));
    if (!$('#feed').children.length) {
      $('#feed').innerHTML = `<div class="card side-card empty">${state.view === 'feed'
        ? 'لا توجد منشورات بعد. تابع أشخاصًا أو أضف أصدقاء، أو جرّب <button class="link" data-tab="explore">الاستكشاف</button>.'
        : 'لا يوجد محتوى حاليًا.'}</div>`;
    }
    state.cursor = r.nextCursor;
    $('#loadMore').hidden = !r.nextCursor;
  } finally { state.loading = false; }
}

function mediaHTML(media, reel) {
  if (!media?.length) return '';
  return `<div class="postmedia ${reel ? 'reel' : ''}">${media.map((m) => (m.type === 'image'
    ? `<img loading="lazy" src="${esc(m.url)}" alt="صورة منشور">`
    : `<video controls playsinline preload="metadata" src="${esc(m.url)}"></video>`)).join('')}</div>`;
}

function renderPost(p) {
  const counts = p.reactions.counts || {};
  return `<article class="post" id="post-${p.id}">
    <div class="compose-title">${avatar(p.author)}<div>
      <div class="author">${userLink(p.author)} ${p.kind === 'reel' ? '<span class="chip">ريلز</span>' : ''}</div>
      <div class="meta">${AUDIENCE[p.audience] || ''} · ${timeAgo(p.createdAt)}</div></div>
      <div class="post-menu">${p.isMine || ['admin', 'moderator'].includes(state.me.role) ? `<button data-delete="${p.id}" title="حذف">🗑</button>` : ''}${p.isMine ? '' : `<button data-report="post|${p.id}" title="إبلاغ">⚑</button>`}</div>
    </div>
    ${p.text ? `<div class="content">${esc(p.text)}</div>` : ''}
    ${mediaHTML(p.media, p.kind === 'reel')}
    <div class="reactionbar">${Object.entries(ICONS).map(([k, v]) => `<button class="${p.reactions.mine === k ? 'selected' : ''}" data-react="${p.id}|${k}" title="${k}">${v}${counts[k] ? ' ' + counts[k] : ''}</button>`).join('')}</div>
    <div class="toolbar">
      <button data-viewreactions="${p.id}">♡ المتفاعلون (${p.reactions.total})</button>
      <button data-comments="${p.id}">▤ التعليقات (${p.commentCount})</button>
    </div>
    <div class="comments" id="comments-${p.id}"></div>
  </article>`;
}

async function refreshPost(id) {
  const el = document.getElementById('post-' + id);
  if (!el) return;
  const open = el.querySelector('.comments').innerHTML;
  el.outerHTML = renderPost(await api('/posts/' + id));
  if (open) await showComments(id);
}

// ---------------- التعليقات ----------------
async function showComments(postId, cursor) {
  const r = await api(`/posts/${postId}/comments?limit=30${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`);
  const root = document.getElementById('comments-' + postId);
  const html = r.items.map((c) => `<div class="comment ${c.parentId ? 'reply' : ''}">
      <div class="comment-head">${avatar(c.author, 'tiny')} <b>${userLink(c.author)}</b> <small class="muted">${timeAgo(c.createdAt)}</small></div>
      <div class="comment-text">${esc(c.text)}</div>
      <button class="${c.reactions.mine ? 'selected' : ''}" data-commentreact="${c.id}|${postId}|${c.reactions.mine ? '' : 'love'}">❤️ ${c.reactions.total || ''}</button>
      <button data-reply="${postId}|${c.id}|${esc(c.author.name)}">رد</button>
      ${c.isMine ? `<button data-delcomment="${c.id}|${postId}">حذف</button>` : `<button data-report="comment|${c.id}">إبلاغ</button>`}
    </div>`).join('');
  if (cursor) {
    root.querySelector('.more-comments')?.remove();
    root.querySelector('.commentform').insertAdjacentHTML('beforebegin', html);
  } else {
    root.innerHTML = html + `<form class="commentform" data-commentform="${postId}"><input maxlength="2000" placeholder="اكتب تعليقًا…" required><button>إرسال</button></form>`;
  }
  if (r.nextCursor) root.querySelector('.commentform').insertAdjacentHTML('beforebegin', `<button class="more-comments link" data-morecomments="${postId}|${r.nextCursor}">تعليقات أخرى…</button>`);
}

// ---------------- القصص ----------------
async function stories() {
  const { items } = await api('/stories');
  const byAuthor = new Map();
  for (const s of items) if (!byAuthor.has(s.author.id)) byAuthor.set(s.author.id, s);
  state.stories = items;
  $('#storyStrip').innerHTML = [...byAuthor.values()].map((s) => `<button class="story-item" data-story="${s.author.id}">
      ${s.media.type === 'image' ? `<img src="${esc(s.media.url)}" alt="">` : `<video muted preload="metadata" src="${esc(s.media.url)}"></video>`}
      <span>${s.isMine ? 'قصتك' : esc(s.author.name)}</span></button>`).join('');
}
async function showStories(authorId) {
  $('#feedTitle').textContent = 'القصص';
  $('#feedHint').textContent = 'تختفي بعد 24 ساعة';
  await stories();
  const list = authorId ? state.stories.filter((s) => s.author.id === authorId) : state.stories;
  $('#feed').innerHTML = list.map((s) => `<div class="story-full"><h3>${esc(s.author.name)} · ${timeAgo(s.createdAt)}
      ${s.isMine ? `<button class="link light" data-delstory="${s.id}">حذف</button>` : `<button class="link light" data-report="story|${s.id}">إبلاغ</button>`}</h3>
      ${s.media.type === 'image' ? `<img src="${esc(s.media.url)}" alt="">` : `<video controls playsinline src="${esc(s.media.url)}"></video>`}</div>`).join('')
    || '<div class="card side-card">لا توجد قصص متاحة.</div>';
}

// ---------------- الملف الشخصي ----------------
async function showProfile(id) {
  const u = await api(`/users/${id}/profile`);
  $('#feedTitle').textContent = u.isMe ? 'ملفي الشخصي' : 'الملف الشخصي';
  $('#feedHint').textContent = '';
  let actions = '';
  if (u.isBlockedByMe) actions = `<button data-unblock="${u.id}">إلغاء الحظر</button>`;
  else if (!u.isMe) {
    actions += u.followStatus ? `<button data-unfollow="${u.id}">${u.followStatus === 'pending' ? 'إلغاء طلب المتابعة' : 'إلغاء المتابعة'}</button>` : `<button class="primary" data-follow="${u.id}">متابعة</button>`;
    if (u.isFriend) actions += `<button data-unfriend="${u.id}">إلغاء الصداقة</button>`;
    else if (u.friendRequest?.direction === 'incoming') actions += `<button data-freq="${u.friendRequest.id}|accept">قبول الصداقة</button>`;
    else if (u.friendRequest?.direction === 'outgoing') actions += `<button data-freq="${u.friendRequest.id}|cancel">إلغاء طلب الصداقة</button>`;
    else actions += `<button data-friend="${u.id}">إضافة صديق</button>`;
    actions += `<button data-block="${u.id}">حظر</button><button data-report="user|${u.id}">إبلاغ</button>`;
  } else actions = '<button data-editbio>تعديل النبذة</button>';
  $('#profileHeader').innerHTML = `<div class="card profile-card">
    ${avatar(u, 'big')}
    <div class="profile-info"><h2>${esc(u.name)} ${u.private ? '🔒' : ''}</h2><div class="muted" dir="ltr">@${esc(u.handle)}</div>
      ${u.bio ? `<p>${esc(u.bio)}</p>` : ''}
      <div class="counts"><span><b>${u.counts.friends}</b> صديق</span><span><b>${u.counts.followers}</b> متابِع</span><span><b>${u.counts.following}</b> يتابع</span>${u.followsMe ? '<span class="chip">يتابعك</span>' : ''}</div>
      <div class="person-actions">${actions}</div></div></div>`;
  $('#feed').innerHTML = '';
  if (!u.isBlockedByMe) await loadPosts();
}

// ---------------- البحث ----------------
async function showSearch(q) {
  $('#feedTitle').textContent = `نتائج البحث: ${q}`;
  $('#feedHint').textContent = '';
  const r = await api('/users?limit=30&q=' + encodeURIComponent(q));
  $('#feed').innerHTML = `<div class="card side-card">${renderPeople(r.items)}</div>`;
}

// ---------------- الإشعارات ----------------
async function showNotifications() {
  $('#feedTitle').textContent = 'الإشعارات';
  $('#feedHint').textContent = '';
  const r = await api('/notifications?limit=50');
  $('#feed').innerHTML = `<div class="card side-card">${r.items.map((n) => `<div class="notification ${n.read ? '' : 'unread'}">
      ${avatar(n.actor)}<div>${n.actor ? userLink(n.actor) : 'مستخدم'} ${NOTIF[n.type] || n.type}
      ${n.entityId && ['reaction', 'comment', 'reply'].includes(n.type) ? `<button class="link" data-openpost="${n.entityId}">عرض</button>` : ''}
      <small class="muted">${timeAgo(n.createdAt)}</small></div></div>`).join('') || '<p class="muted">لا توجد إشعارات</p>'}</div>`;
  if (r.items.some((n) => !n.read)) {
    await api('/notifications/read', 'POST');
    state.me.unreadNotifications = 0;
    renderMe();
  }
}

// ---------------- لوحة الإشراف ----------------
async function showReports() {
  $('#feedTitle').textContent = 'البلاغات المفتوحة';
  $('#feedHint').textContent = 'للمشرفين فقط';
  const r = await api('/admin/reports?limit=50');
  $('#feed').innerHTML = r.items.map((x) => `<div class="card side-card">
      <b>${esc(x.targetType)}</b> · ${esc(x.targetId)} <span class="chip">${x.totalReports} بلاغ</span>
      <p>${esc(x.reason)}</p><small class="muted">من @${esc(x.reporter || '—')} · ${timeAgo(x.createdAt)}</small>
      <div class="person-actions">
        ${x.targetType === 'post' ? `<button data-openpost="${x.targetId}">عرض المنشور</button>` : ''}
        <button data-resolve="${x.id}|dismiss">تجاهل</button>
        ${x.targetType !== 'user' ? `<button data-resolve="${x.id}|remove_content">حذف المحتوى</button>` : ''}
        <button class="danger" data-resolve="${x.id}|suspend_user">إيقاف الحساب</button></div></div>`).join('')
    || '<div class="card side-card">لا توجد بلاغات مفتوحة 🎉</div>';
}

// ---------------- رفع الوسائط ----------------
function uploadWithProgress(url, method, headers, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    xhr.withCredentials = url.startsWith('/');
    for (const [k, v] of Object.entries(headers || {})) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => (xhr.status < 300 ? resolve() : reject(new Error(xhr.status === 413 ? ERRORS.too_large : 'فشل رفع الملف')));
    xhr.onerror = () => reject(new Error('انقطع الاتصال أثناء الرفع'));
    xhr.send(file);
  });
}
async function upload(file) {
  const type = file.type.startsWith('video/') ? 'video' : 'image';
  if (file.size > MAX[type]) throw new Error(`الحد الأقصى ${MAX[type] / 1048576} ميجابايت`);
  const start = await api('/media/uploads', 'POST', { mime: file.type, size: file.size });
  const bar = $('#progress');
  bar.hidden = false;
  try {
    await uploadWithProgress(start.upload.url, start.upload.method, start.upload.headers, file, (p) => { bar.firstElementChild.style.width = Math.round(p * 100) + '%'; });
  } finally { bar.hidden = true; bar.firstElementChild.style.width = '0'; }
  return api(`/media/${start.id}/complete`, 'POST');
}

function preview() {
  $('#preview').innerHTML = state.pending.map((p, i) => `<div class="preview-item">${p.type === 'image'
    ? `<img src="${p.local}" alt="">` : `<video src="${p.local}" muted></video>`}<button data-remove="${i}" aria-label="إزالة">×</button></div>`).join('');
}

async function filesSelected(files, kind) {
  if (!files.length) return;
  if (kind === 'story') {
    $('#uploadStatus').textContent = 'جارٍ رفع القصة…';
    const m = await upload(files[0]);
    await api('/stories', 'POST', { media: m.id, audience: $('#audience').value });
    $('#uploadStatus').textContent = '';
    toast('تم نشر القصة ✓');
    return stories();
  }
  if (kind === 'reel') { state.pending = []; if (!files[0].type.startsWith('video/')) throw new Error('الريلز يتطلب فيديو'); }
  else if (state.pendingKind === 'reel') state.pending = [];
  for (const f of files) {
    if (state.pending.length >= 4) throw new Error('الحد الأقصى 4 وسائط');
    $('#uploadStatus').textContent = `جارٍ رفع ${f.name}…`;
    const m = await upload(f);
    state.pending.push({ ...m, local: URL.createObjectURL(f) });
    preview();
  }
  state.pendingKind = kind === 'reel' ? 'reel' : 'post';
  $('#uploadStatus').textContent = state.pendingKind === 'reel' ? 'الفيديو جاهز للنشر كريلز' : 'تم رفع الوسائط. اضغط نشر الآن.';
}

// ---------------- الأحداث ----------------
async function report(type, id) {
  const reason = prompt('سبب الإبلاغ:');
  if (!reason || reason.trim().length < 3) return;
  await api('/reports', 'POST', { targetType: type, targetId: id, reason });
  toast('تم إرسال البلاغ، شكرًا لك');
}

document.addEventListener('click', (e) => {
  const el = e.target.closest('button');
  if (!el) return;
  const d = el.dataset;
  run(async () => {
    if (d.authtab) {
      document.querySelectorAll('[data-authtab]').forEach((b) => b.classList.toggle('active', b === el));
      $('#loginForm').hidden = d.authtab !== 'login';
      $('#registerForm').hidden = d.authtab !== 'register';
      return;
    }
    if (d.tab) return openView(d.tab);
    if (d.profile) return openView('profile', d.profile === 'me' ? state.me.id : d.profile);
    if (d.story) { await openView('stories'); return showStories(d.story); }
    if (d.remove !== undefined) { state.pending.splice(Number(d.remove), 1); if (!state.pending.length) state.pendingKind = 'post'; return preview(); }
    if (d.follow) { const r = await api(`/users/${d.follow}/follow`, 'POST'); toast(r.status === 'pending' ? 'تم إرسال طلب المتابعة' : 'تمت المتابعة'); }
    else if (d.unfollow) await api(`/users/${d.unfollow}/follow`, 'DELETE');
    else if (d.friend) { await api(`/users/${d.friend}/friend-request`, 'POST'); toast('تم إرسال طلب الصداقة'); }
    else if (d.unfriend) { if (!confirm('إلغاء الصداقة؟')) return; await api(`/users/${d.unfriend}/friend`, 'DELETE'); }
    else if (d.freq) { const [id, action] = d.freq.split('|'); await api(`/friend-requests/${id}/${action}`, 'POST'); }
    else if (d.followreq) { const [id, action] = d.followreq.split('|'); await api(`/follow-requests/${id}/${action}`, 'POST'); }
    else if (d.block) { if (!confirm('حظر هذا الحساب؟ سيُلغى أي تواصل بينكما.')) return; await api(`/users/${d.block}/block`, 'POST'); toast('تم الحظر'); }
    else if (d.unblock) await api(`/users/${d.unblock}/block`, 'DELETE');
    else if (d.react) {
      const [id, type] = d.react.split('|');
      await api(`/posts/${id}/reaction`, el.classList.contains('selected') ? 'DELETE' : 'PUT', el.classList.contains('selected') ? undefined : { type });
      return refreshPost(id);
    } else if (d.viewreactions) {
      const r = await api(`/posts/${d.viewreactions}/reactions?limit=50`);
      return alert(r.items.map((x) => `${x.user.name}: ${ICONS[x.type]}`).join('\n') || 'لا توجد تفاعلات');
    } else if (d.comments) {
      const root = document.getElementById('comments-' + d.comments);
      if (root.innerHTML) { root.innerHTML = ''; return; }
      return showComments(d.comments);
    } else if (d.morecomments) { const [id, cursor] = d.morecomments.split('|'); return showComments(id, cursor); }
    else if (d.reply) {
      const [postId, parent, name] = d.reply.split('|');
      const input = document.querySelector(`[data-commentform="${postId}"] input`);
      input.dataset.parent = parent;
      input.placeholder = `الرد على ${name}…`;
      return input.focus();
    } else if (d.commentreact) {
      const [id, postId, type] = d.commentreact.split('|');
      await api(`/comments/${id}/reaction`, type ? 'PUT' : 'DELETE', type ? { type } : undefined);
      return showComments(postId);
    } else if (d.delcomment) {
      const [id, postId] = d.delcomment.split('|');
      if (!confirm('حذف التعليق؟')) return;
      await api(`/comments/${id}`, 'DELETE');
      return refreshPost(postId);
    } else if (d.delete) {
      if (!confirm('حذف المنشور؟')) return;
      await api(`/posts/${d.delete}`, 'DELETE');
      return document.getElementById('post-' + d.delete)?.remove();
    } else if (d.delstory) {
      if (!confirm('حذف القصة؟')) return;
      await api(`/stories/${d.delstory}`, 'DELETE');
      return showStories();
    } else if (d.report) { const [type, id] = d.report.split('|'); return report(type, id); }
    else if (d.openpost) {
      const p = await api('/posts/' + d.openpost);
      $('#feedTitle').textContent = 'منشور';
      $('#profileHeader').innerHTML = '';
      $('#feed').innerHTML = renderPost(p);
      $('#loadMore').hidden = true;
      return showComments(p.id);
    } else if (d.resolve) { const [id, action] = d.resolve.split('|'); await api(`/admin/reports/${id}/resolve`, 'POST', { action }); return showReports(); }
    else if (d.editbio !== undefined) {
      const bio = prompt('نبذة عنك (300 حرف كحد أقصى):', '');
      if (bio === null) return;
      await api('/me/profile', 'PATCH', { bio: bio.slice(0, 300) });
      return showProfile(state.me.id);
    } else if (d.action === 'logout' || d.action === 'logout-all') {
      await api(d.action === 'logout' ? '/auth/logout' : '/auth/logout-all', 'POST');
      return showAuth();
    } else if (d.action === 'delete-account') {
      const password = prompt('سيُحذف حسابك وكل منشوراتك ووسائطك نهائيًا. أدخل كلمة المرور للتأكيد:');
      if (!password) return;
      await api('/me', 'DELETE', { password });
      return showAuth();
    } else return;
    // بعد أي تغيير في العلاقات: حدّث الشريط الجانبي والعرض الحالي
    await sidebar();
    if (state.view === 'profile') await showProfile(state.profileId);
    else if (state.view === 'search') await showSearch(state.profileId);
  });
});

document.addEventListener('submit', (e) => {
  const form = e.target.closest('[data-commentform]');
  if (!form) return;
  e.preventDefault();
  run(async () => {
    const postId = form.dataset.commentform;
    const input = form.querySelector('input');
    await api(`/posts/${postId}/comments`, 'POST', { text: input.value, parentId: input.dataset.parent || null });
    await refreshPost(postId);
  });
});

$('#loadMore').addEventListener('click', () => run(loadPosts));
$('#searchInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.value.trim()) run(() => openView('search', e.target.value.trim()));
});
$('#privateToggle').addEventListener('change', (e) => run(async () => {
  await api('/me/profile', 'PATCH', { private: e.target.checked });
  state.me.private = e.target.checked;
  toast(e.target.checked ? 'أصبح حسابك خاصًا' : 'أصبح حسابك عامًا');
}));
$('#avatarInput').addEventListener('change', (e) => run(async () => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (!file.type.startsWith('image/')) throw new Error('اختر صورة فقط');
  const m = await upload(file);
  await api('/me/profile', 'PATCH', { avatar: m.id });
  state.me = await api('/auth/me');
  renderMe();
  toast('تم تحديث الصورة الشخصية');
}));
for (const [id, kind] of [['imageInput', 'post'], ['videoInput', 'post'], ['reelInput', 'reel'], ['storyInput', 'story']]) {
  $('#' + id).addEventListener('change', (e) => run(async () => {
    const files = [...e.target.files];
    e.target.value = '';
    await filesSelected(files, kind);
  }));
}
$('#publish').addEventListener('click', () => run(async () => {
  const btn = $('#publish');
  btn.disabled = true;
  try {
    const post = await api('/posts', 'POST', {
      text: $('#postText').value, audience: $('#audience').value, kind: state.pendingKind, media: state.pending.map((m) => m.id),
    });
    state.pending.forEach((p) => URL.revokeObjectURL(p.local));
    $('#postText').value = '';
    state.pending = [];
    state.pendingKind = 'post';
    preview();
    $('#uploadStatus').textContent = '';
    toast('تم النشر بنجاح ✓');
    $('#feed').querySelector('.empty')?.remove();
    $('#feed').insertAdjacentHTML('afterbegin', renderPost(post));
  } finally { btn.disabled = false; }
}));

// تحديث عدّاد الإشعارات دوريًا
setInterval(() => {
  if (!state.me || document.hidden) return;
  api('/auth/me').then((me) => { state.me = me; renderMe(); }).catch(() => {});
}, 60_000);

boot();
