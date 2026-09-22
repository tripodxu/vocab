-- 0005: 索引清理与补充
--
-- 1) 删除三个"主键前缀"冗余索引：SQLite 的 PRIMARY KEY (a, b[, c]) 已自动建立
--    同前缀索引，再建一遍只会放大写入成本、不带来新的查询能力。
--    · idx_word_state_user_chapter = PRIMARY KEY(user_id, chapter_id, word_id) 前缀
--    · idx_notes_user_chapter      = PRIMARY KEY(user_id, chapter_id, word_id) 前缀
--    · idx_vocab_user              = PRIMARY KEY(user_id, chapter_id) 前缀
-- 2) 补 auth_throttle(window_start)：每日 cron 按 window_start/blocked_until 扫描，
--    原来是全表扫。
-- 3) 补 question_report(user_id)：按用户回看/统计报错历史用（0004 只建了
--    created_at 与 (chapter, word_id) 两个索引）。
DROP INDEX IF EXISTS idx_word_state_user_chapter;
DROP INDEX IF EXISTS idx_notes_user_chapter;
DROP INDEX IF EXISTS idx_vocab_user;

CREATE INDEX IF NOT EXISTS idx_throttle_window ON auth_throttle(window_start);
CREATE INDEX IF NOT EXISTS idx_report_user ON question_report(user_id);
