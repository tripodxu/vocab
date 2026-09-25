-- 0009: 题目报错的处理闭环
-- status: open=待处理（默认，兼容存量行） / handled=已处理；
-- handled_at 记录标记时间，重新打开时置回 NULL。
ALTER TABLE question_report ADD COLUMN status TEXT NOT NULL DEFAULT 'open';
ALTER TABLE question_report ADD COLUMN handled_at TEXT;

CREATE INDEX IF NOT EXISTS idx_report_status ON question_report (status, created_at);
