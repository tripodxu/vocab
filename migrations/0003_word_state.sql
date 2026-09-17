-- ============================================================
-- 0003: 按词存储的学习状态 / 讲义备注与配图 / 登录限流
--
-- 设计要点：
--  1) 学习状态按 (user, chapter, word) 一行，取代原来的整章 JSON blob，
--     这样多端可以按词合并，而不是整体覆盖。
--  2) seen_at / updated_at 存「客户端逻辑时间戳(ms)」，写入时用 LWW
--     （last-write-wins by seen_at）条件更新，因此两端交替作答不会互相覆盖。
--  3) 讲义配图单独一张表，列表接口不返回 base64，避免把大字段带进每次同步。
-- ============================================================

CREATE TABLE IF NOT EXISTS user_word_state (
  user_id     INTEGER NOT NULL REFERENCES user_accounts(id),
  chapter_id  INTEGER NOT NULL,
  word_id     INTEGER NOT NULL,
  status      TEXT    NOT NULL DEFAULT 'learning',
  streak      INTEGER NOT NULL DEFAULT 0,
  wrong_count INTEGER NOT NULL DEFAULT 0,
  seen_at     INTEGER NOT NULL DEFAULT 0,
  due_at      INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (user_id, chapter_id, word_id)
);

CREATE INDEX IF NOT EXISTS idx_word_state_user_seen ON user_word_state(user_id, seen_at);
CREATE INDEX IF NOT EXISTS idx_word_state_user_chapter ON user_word_state(user_id, chapter_id);

CREATE TABLE IF NOT EXISTS user_notes (
  user_id    INTEGER NOT NULL REFERENCES user_accounts(id),
  chapter_id INTEGER NOT NULL,
  word_id    INTEGER NOT NULL,
  note       TEXT    NOT NULL DEFAULT '',
  has_image  INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, chapter_id, word_id)
);

CREATE INDEX IF NOT EXISTS idx_notes_user_chapter ON user_notes(user_id, chapter_id);

CREATE TABLE IF NOT EXISTS user_note_images (
  user_id    INTEGER NOT NULL REFERENCES user_accounts(id),
  chapter_id INTEGER NOT NULL,
  word_id    INTEGER NOT NULL,
  mime       TEXT    NOT NULL,
  data       TEXT    NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, chapter_id, word_id)
);

CREATE TABLE IF NOT EXISTS auth_throttle (
  key           TEXT PRIMARY KEY,
  failures      INTEGER NOT NULL DEFAULT 0,
  window_start  INTEGER NOT NULL,
  blocked_until INTEGER NOT NULL DEFAULT 0
);
