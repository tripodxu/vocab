-- 0004: 题目报错（第五期）——用户在认词辨析卡上举报可疑题目，后台可导出 CSV
CREATE TABLE IF NOT EXISTS question_report (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  chapter INTEGER NOT NULL,
  word_id INTEGER NOT NULL,
  kind TEXT NOT NULL,              -- similar 选项过于相近 / options-wrong 选项有误 / meaning-wrong 释义有误 / other 其他
  note TEXT,                       -- 用户补充说明（可空）
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_report_created ON question_report (created_at);
CREATE INDEX IF NOT EXISTS idx_report_word ON question_report (chapter, word_id);
