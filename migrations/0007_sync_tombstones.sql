-- 0007: 同步删除的持久化标记
-- 重置/删除必须留下服务端 cutoff，旧客户端的延迟 PUT 不能复活已删除数据。
CREATE TABLE IF NOT EXISTS user_chapter_resets (
  user_id    INTEGER NOT NULL REFERENCES user_accounts(id),
  chapter_id INTEGER NOT NULL,
  reset_at   INTEGER NOT NULL,
  PRIMARY KEY (user_id, chapter_id)
);

CREATE TABLE IF NOT EXISTS user_note_tombstones (
  user_id    INTEGER NOT NULL REFERENCES user_accounts(id),
  chapter_id INTEGER NOT NULL,
  word_id    INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, chapter_id, word_id)
);

CREATE TABLE IF NOT EXISTS user_note_image_tombstones (
  user_id    INTEGER NOT NULL REFERENCES user_accounts(id),
  chapter_id INTEGER NOT NULL,
  word_id    INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, chapter_id, word_id)
);

CREATE INDEX IF NOT EXISTS idx_note_image_tombstones_user_updated
  ON user_note_image_tombstones(user_id, updated_at);
