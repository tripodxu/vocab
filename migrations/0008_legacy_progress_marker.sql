-- 0008: 旧版整章进度迁移完成标记
-- 不能用当前 user_word_state 行数判断是否迁移：重置会暂时删空行，
-- 若再次 GET 又把旧 blob 导回，就会撤销用户刚刚执行的重置。
CREATE TABLE IF NOT EXISTS user_legacy_progress_migrations (
  user_id INTEGER PRIMARY KEY REFERENCES user_accounts(id),
  migrated_at INTEGER NOT NULL
);
