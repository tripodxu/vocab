-- 0006: 云端生词本（按词记录，删除以 tombstone 保留）
--
-- starred=0 是墓碑而不是物理 DELETE：另一台设备的下一次增量拉取必须能看到删除，
-- 否则旧的 starred=1 会被重新写回本地。updated_at 是客户端逻辑时间戳，按条 LWW。
CREATE TABLE IF NOT EXISTS user_word_stars (
  user_id     INTEGER NOT NULL REFERENCES user_accounts(id),
  chapter_id  INTEGER NOT NULL CHECK (chapter_id BETWEEN 1 AND 999),
  word_id     INTEGER NOT NULL CHECK (word_id BETWEEN 1 AND 100000),
  starred     INTEGER NOT NULL CHECK (starred IN (0, 1)),
  updated_at  INTEGER NOT NULL CHECK (updated_at > 0),
  PRIMARY KEY (user_id, chapter_id, word_id)
);

CREATE INDEX IF NOT EXISTS idx_word_stars_user_updated ON user_word_stars(user_id, updated_at);
