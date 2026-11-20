-- وصال: المخطط الأساسي
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  handle        text NOT NULL,
  email         text NOT NULL,
  name          text NOT NULL,
  bio           text NOT NULL DEFAULT '',
  password_hash text NOT NULL,
  is_private    boolean NOT NULL DEFAULT false,
  avatar_media_id uuid,
  role          text NOT NULL DEFAULT 'user' CHECK (role IN ('user','moderator','admin')),
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_handle_uq ON users (lower(handle));
CREATE UNIQUE INDEX users_email_uq ON users (lower(email));
CREATE INDEX users_created_idx ON users (created_at DESC, id DESC);

CREATE TABLE sessions (
  token_hash  bytea PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  ip          inet,
  user_agent  text
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

CREATE TABLE media (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('image','video')),
  mime        text NOT NULL,
  size_bytes  bigint NOT NULL,
  storage_key text NOT NULL UNIQUE,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ready')),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX media_owner_idx ON media (owner_id);
CREATE INDEX media_status_created_idx ON media (status, created_at);
ALTER TABLE users ADD CONSTRAINT users_avatar_fk FOREIGN KEY (avatar_media_id) REFERENCES media(id) ON DELETE SET NULL;

CREATE TABLE follows (
  follower_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followee_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status      text NOT NULL CHECK (status IN ('pending','accepted')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, followee_id),
  CHECK (follower_id <> followee_id)
);
CREATE INDEX follows_followee_idx ON follows (followee_id, status);

CREATE TABLE friend_requests (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined','cancelled')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  responded_at timestamptz,
  CHECK (from_id <> to_id)
);
CREATE UNIQUE INDEX friend_requests_pending_uq ON friend_requests (from_id, to_id) WHERE status = 'pending';
CREATE INDEX friend_requests_to_idx ON friend_requests (to_id, status, created_at DESC);

-- صداقة متماثلة: user_a < user_b دائمًا
CREATE TABLE friendships (
  user_a     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_a, user_b),
  CHECK (user_a < user_b)
);
CREATE INDEX friendships_b_idx ON friendships (user_b);

CREATE TABLE blocks (
  blocker_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);
CREATE INDEX blocks_blocked_idx ON blocks (blocked_id);

CREATE TABLE posts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind           text NOT NULL DEFAULT 'post' CHECK (kind IN ('post','reel')),
  text           text NOT NULL DEFAULT '',
  audience       text NOT NULL CHECK (audience IN ('public','friends','followers','friends_and_followers','only_me')),
  reaction_count integer NOT NULL DEFAULT 0,
  comment_count  integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz
);
CREATE INDEX posts_author_idx ON posts (author_id, created_at DESC, id DESC) INCLUDE (audience) WHERE deleted_at IS NULL;
CREATE INDEX posts_public_idx ON posts (created_at DESC, id DESC) WHERE deleted_at IS NULL AND audience = 'public';
CREATE INDEX posts_reels_idx ON posts (created_at DESC, id DESC) WHERE deleted_at IS NULL AND kind = 'reel';

CREATE TABLE post_media (
  post_id  uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  media_id uuid NOT NULL UNIQUE REFERENCES media(id) ON DELETE CASCADE,
  position smallint NOT NULL,
  PRIMARY KEY (post_id, position)
);

CREATE TABLE stories (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media_id   uuid NOT NULL UNIQUE REFERENCES media(id) ON DELETE CASCADE,
  audience   text NOT NULL CHECK (audience IN ('public','friends','followers','friends_and_followers','only_me')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX stories_author_idx ON stories (author_id, expires_at);
CREATE INDEX stories_expires_idx ON stories (expires_at);

CREATE TABLE reactions (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id    uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  type       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, user_id)
);
CREATE INDEX reactions_user_idx ON reactions (user_id);

CREATE TABLE comments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id        uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  author_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id      uuid REFERENCES comments(id) ON DELETE CASCADE,
  text           text NOT NULL,
  reaction_count integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz
);
CREATE INDEX comments_post_idx ON comments (post_id, created_at, id);
CREATE INDEX comments_author_idx ON comments (author_id);

CREATE TABLE comment_reactions (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  comment_id uuid NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  type       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (comment_id, user_id)
);

CREATE TABLE notifications (
  id         bigserial PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_id   uuid REFERENCES users(id) ON DELETE CASCADE,
  type       text NOT NULL,
  entity_id  uuid,
  read_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications (user_id, id DESC);

CREATE TABLE reports (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id uuid REFERENCES users(id) ON DELETE SET NULL,
  target_type text NOT NULL CHECK (target_type IN ('post','comment','user','story')),
  target_id   uuid NOT NULL,
  reason      text NOT NULL,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','dismissed','actioned')),
  resolved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE INDEX reports_status_idx ON reports (status, created_at);
CREATE UNIQUE INDEX reports_open_uq ON reports (reporter_id, target_type, target_id) WHERE status = 'open';

-- دوال الصلاحيات (قابلة للدمج في الاستعلامات من قِبل المخطِّط)
CREATE FUNCTION is_blocked(a uuid, b uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM blocks WHERE (blocker_id = a AND blocked_id = b) OR (blocker_id = b AND blocked_id = a))
$$;
CREATE FUNCTION are_friends(a uuid, b uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM friendships WHERE user_a = LEAST(a, b) AND user_b = GREATEST(a, b))
$$;
CREATE FUNCTION is_follower(follower uuid, followee uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM follows WHERE follower_id = follower AND followee_id = followee AND status = 'accepted')
$$;
CREATE FUNCTION can_view(viewer uuid, author uuid, aud text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT viewer = author OR (
    NOT is_blocked(viewer, author) AND (
      aud = 'public'
      OR (aud = 'friends' AND are_friends(viewer, author))
      OR (aud = 'followers' AND is_follower(viewer, author))
      OR (aud = 'friends_and_followers' AND (are_friends(viewer, author) OR is_follower(viewer, author)))
    )
  )
$$;

-- عدادات التفاعل لكل نوع (تجنب COUNT/GROUP BY على المنشورات الرائجة)
CREATE TABLE post_reaction_counts (
  post_id uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  type    text NOT NULL,
  count   integer NOT NULL DEFAULT 0,
  PRIMARY KEY (post_id, type)
);

-- بحث بالبادئة عن الأسماء والمعرّفات
CREATE INDEX users_handle_prefix_idx ON users (lower(handle) text_pattern_ops);
CREATE INDEX users_name_prefix_idx ON users (lower(name) text_pattern_ops);
