// @ts-check
/**
 * FakeD1 —— 供 node --test 使用的内存版 D1。
 *
 * 说明与局限：
 *  · 它按 SQL 语句模式匹配执行，只覆盖 worker/index.js 实际用到的那些语句；
 *    遇到没实现的语句会直接抛错（避免"测试通过但其实没执行"的假象）。
 *  · 它验证的是路由、鉴权、参数校验、限流、按词 LWW 合并等逻辑，
 *    不验证 SQLite 本身的语义（真正的 SQL 正确性需要在 wrangler d1 上跑）。
 */

const norm = (sql) => String(sql).replace(/\s+/g, " ").trim();

class Stmt {
  /** @param {FakeD1} db @param {string} sql @param {any[]} args */
  constructor(db, sql, args = []) {
    this.db = db;
    this.sql = norm(sql);
    this.args = args;
  }

  /** @param {...any} args */
  bind(...args) {
    return new Stmt(this.db, this.sql, args);
  }

  async first() {
    const rows = await this.db.execute(this.sql, this.args, "all");
    return rows.length ? rows[0] : null;
  }

  async all() {
    const rows = await this.db.execute(this.sql, this.args, "all");
    return { results: rows, success: true, meta: {} };
  }

  async run() {
    const rows = await this.db.execute(this.sql, this.args, "run");
    return { results: rows, success: true, meta: { last_row_id: this.db.lastRowId, changes: this.db.changes } };
  }
}

export class FakeD1 {
  constructor() {
    /** @type {Record<string, any[]>} */
    this.tables = {
      user_accounts: [],
      user_sessions: [],
      user_settings: [],
      vocab_progress: [],
      user_word_state: [],
      user_notes: [],
      user_note_images: [],
      auth_throttle: [],
    };
    this.seq = { user_accounts: 0 };
    this.lastRowId = 0;
    this.changes = 0;
  }

  /** @param {string} sql */
  prepare(sql) {
    return new Stmt(this, sql, []);
  }

  /** @param {Stmt[]} stmts */
  async batch(stmts) {
    const out = [];
    for (const stmt of stmts) out.push(await stmt.run());
    return out;
  }

  /** 测试辅助：预置旧版 blob 进度 */
  seedLegacyProgress(userId, chapterId, data) {
    this.tables.vocab_progress.push({ user_id: userId, chapter_id: chapterId, data: JSON.stringify(data) });
  }

  /** 测试辅助：预置账号 */
  seedAccount(email, password_hash, nickname = "seed") {
    const id = ++this.seq.user_accounts;
    this.tables.user_accounts.push({ id, email, password_hash, nickname });
    return id;
  }

  /**
   * @param {string} sql
   * @param {any[]} a
   * @param {"all" | "run"} mode
   */
  async execute(sql, a, mode) {
    const T = this.tables;
    const now = Date.now();

    // ---------- 账号 / 会话 ----------
    if (sql.startsWith("INSERT INTO user_accounts")) {
      const id = ++this.seq.user_accounts;
      T.user_accounts.push({ id, email: a[0], password_hash: a[1], nickname: a[2] });
      this.lastRowId = id;
      this.changes = 1;
      return [];
    }
    if (sql.startsWith("SELECT id FROM user_accounts WHERE email = ?")) {
      const row = T.user_accounts.find((r) => r.email === a[0]);
      return row ? [{ id: row.id }] : [];
    }
    if (sql.startsWith("SELECT id, password_hash, nickname FROM user_accounts WHERE email = ?")) {
      const row = T.user_accounts.find((r) => r.email === a[0]);
      return row ? [{ id: row.id, password_hash: row.password_hash, nickname: row.nickname }] : [];
    }
    if (sql.startsWith("SELECT nickname FROM user_accounts WHERE id = ?")) {
      const row = T.user_accounts.find((r) => r.id === a[0]);
      return row ? [{ nickname: row.nickname }] : [];
    }
    if (sql.startsWith("UPDATE user_accounts SET nickname = ? WHERE id = ?")) {
      const row = T.user_accounts.find((r) => r.id === a[1]);
      if (row) row.nickname = a[0];
      return [];
    }
    if (sql.startsWith("SELECT password_hash FROM user_accounts WHERE id = ?")) {
      const row = T.user_accounts.find((r) => r.id === a[0]);
      return row ? [{ password_hash: row.password_hash }] : [];
    }
    if (sql.startsWith("UPDATE user_accounts SET password_hash = ? WHERE id = ?")) {
      const row = T.user_accounts.find((r) => r.id === a[1]);
      if (row) row.password_hash = a[0];
      return [];
    }
    if (sql.startsWith("INSERT INTO user_sessions")) {
      T.user_sessions.push({ token: a[0], user_id: a[1], expires_at: a[2] });
      return [];
    }
    if (sql.startsWith("SELECT u.id AS id, u.email AS email, s.token AS token FROM user_sessions")) {
      const session = T.user_sessions.find((s) => s.token === a[0] && s.expires_at > new Date().toISOString());
      if (!session) return [];
      const account = T.user_accounts.find((u) => u.id === session.user_id);
      return account ? [{ id: account.id, email: account.email, token: session.token }] : [];
    }
    if (sql.startsWith("DELETE FROM user_sessions WHERE user_id = ? AND token != ?")) {
      T.user_sessions = T.user_sessions.filter((s) => !(s.user_id === a[0] && s.token !== a[1]));
      return [];
    }
    if (sql.startsWith("DELETE FROM user_sessions WHERE user_id = ?")) {
      T.user_sessions = T.user_sessions.filter((s) => s.user_id !== a[0]);
      return [];
    }
    if (sql.startsWith("DELETE FROM user_sessions WHERE token = ?")) {
      T.user_sessions = T.user_sessions.filter((s) => s.token !== a[0]);
      return [];
    }
    if (sql.startsWith("DELETE FROM user_sessions WHERE expires_at < datetime('now')")) {
      const iso = new Date().toISOString();
      T.user_sessions = T.user_sessions.filter((s) => s.expires_at >= iso);
      return [];
    }

    // ---------- 限流 ----------
    if (sql.startsWith("SELECT failures, window_start, blocked_until FROM auth_throttle WHERE key = ?")) {
      const row = T.auth_throttle.find((r) => r.key === a[0]);
      return row ? [row] : [];
    }
    if (sql.startsWith("INSERT INTO auth_throttle")) {
      const existing = T.auth_throttle.find((r) => r.key === a[0]);
      if (existing) {
        existing.failures = a[1];
        existing.window_start = a[2];
        existing.blocked_until = a[3];
      } else {
        T.auth_throttle.push({ key: a[0], failures: a[1], window_start: a[2], blocked_until: a[3] });
      }
      return [];
    }
    if (sql.startsWith("DELETE FROM auth_throttle WHERE key = ?")) {
      T.auth_throttle = T.auth_throttle.filter((r) => r.key !== a[0]);
      return [];
    }
    if (sql.startsWith("DELETE FROM auth_throttle WHERE window_start < ?")) {
      T.auth_throttle = T.auth_throttle.filter((r) => !(r.window_start < a[0] && r.blocked_until < a[1]));
      return [];
    }

    // ---------- 设置 ----------
    if (sql.startsWith("SELECT settings FROM user_settings WHERE user_id = ?")) {
      const row = T.user_settings.find((r) => r.user_id === a[0]);
      return row ? [{ settings: row.settings }] : [];
    }
    if (sql.startsWith("INSERT INTO user_settings")) {
      const row = T.user_settings.find((r) => r.user_id === a[0]);
      if (row) row.settings = a[1];
      else T.user_settings.push({ user_id: a[0], settings: a[1], updated_at: new Date(now).toISOString() });
      return [];
    }

    // ---------- 旧版进度（迁移用） ----------
    if (sql.startsWith("SELECT COUNT(*) AS n FROM user_word_state WHERE user_id = ?")) {
      return [{ n: T.user_word_state.filter((r) => r.user_id === a[0]).length }];
    }
    if (sql.startsWith("SELECT chapter_id, data FROM vocab_progress WHERE user_id = ?")) {
      return T.vocab_progress.filter((r) => r.user_id === a[0]);
    }

    // ---------- 词状态 ----------
    if (sql.startsWith("INSERT INTO user_word_state")) {
      const [user_id, chapter_id, word_id, status, streak, wrong_count, seen_at, due_at] = a;
      const row = T.user_word_state.find(
        (r) => r.user_id === user_id && r.chapter_id === chapter_id && r.word_id === word_id
      );
      const isMigration = sql.includes("DO NOTHING");
      if (!row) {
        T.user_word_state.push({ user_id, chapter_id, word_id, status, streak, wrong_count, seen_at, due_at });
        this.changes = 1;
      } else if (isMigration) {
        this.changes = 0;
      } else if (seen_at >= row.seen_at) {
        Object.assign(row, { status, streak, wrong_count, seen_at, due_at });
        this.changes = 1;
      } else {
        this.changes = 0;
      }
      return [];
    }
    if (sql.startsWith("SELECT chapter_id, word_id, status, streak, wrong_count, seen_at, due_at FROM user_word_state")) {
      // 三种形态：按 chapter+since / 仅 since / 全部（导出用）
      const byChapter = sql.includes("AND chapter_id = ?");
      const bySince = sql.includes("AND seen_at > ?");
      let cursor = 1;
      const chapter = byChapter ? a[cursor++] : null;
      const since = bySince ? a[cursor++] : 0;
      return T.user_word_state
        .filter(
          (r) =>
            r.user_id === a[0] &&
            (chapter === null || r.chapter_id === chapter) &&
            (!bySince || r.seen_at > since)
        )
        .sort((x, y) => x.chapter_id - y.chapter_id || x.word_id - y.word_id);
    }
    if (sql.startsWith("DELETE FROM user_word_state WHERE user_id = ? AND chapter_id = ?")) {
      T.user_word_state = T.user_word_state.filter((r) => !(r.user_id === a[0] && r.chapter_id === a[1]));
      return [];
    }

    // ---------- 讲义备注 ----------
    if (sql.startsWith("SELECT word_id, note, has_image, updated_at FROM user_notes WHERE user_id = ? AND chapter_id = ?")) {
      return T.user_notes.filter((r) => r.user_id === a[0] && r.chapter_id === a[1]);
    }
    if (sql.startsWith("SELECT chapter_id, word_id, note, has_image FROM user_notes WHERE user_id = ?")) {
      return T.user_notes.filter((r) => r.user_id === a[0]);
    }
    if (sql.startsWith("SELECT chapter_id, word_id, note, has_image, updated_at FROM user_notes WHERE user_id = ?")) {
      return T.user_notes.filter((r) => r.user_id === a[0]);
    }
    if (sql.startsWith("SELECT has_image FROM user_notes")) {
      const row = T.user_notes.find((r) => r.user_id === a[0] && r.chapter_id === a[1] && r.word_id === a[2]);
      return row ? [{ has_image: row.has_image }] : [];
    }
    if (sql.startsWith("SELECT note FROM user_notes")) {
      const row = T.user_notes.find((r) => r.user_id === a[0] && r.chapter_id === a[1] && r.word_id === a[2]);
      return row ? [{ note: row.note }] : [];
    }
    if (sql.startsWith("UPDATE user_notes SET has_image = 0")) {
      const row = T.user_notes.find((r) => r.user_id === a[1] && r.chapter_id === a[2] && r.word_id === a[3]);
      if (row) {
        row.has_image = 0;
        row.updated_at = a[0];
      }
      return [];
    }
    if (sql.startsWith("INSERT INTO user_notes")) {
      const [user_id, chapter_id, word_id, note, has_image, updated_at] = a;
      const row = T.user_notes.find(
        (r) => r.user_id === user_id && r.chapter_id === chapter_id && r.word_id === word_id
      );
      if (row) {
        // 空备注写入时保留已有配图标记（worker 已先读后写，这里再兜一层）
        row.note = note;
        if (note || !row.has_image) row.has_image = has_image;
        row.updated_at = updated_at;
      } else {
        T.user_notes.push({ user_id, chapter_id, word_id, note, has_image, updated_at });
      }
      return [];
    }
    if (sql.startsWith("DELETE FROM user_notes WHERE user_id = ? AND chapter_id = ? AND word_id = ?")) {
      T.user_notes = T.user_notes.filter(
        (r) => !(r.user_id === a[0] && r.chapter_id === a[1] && r.word_id === a[2])
      );
      return [];
    }

    // ---------- 讲义配图 ----------
    if (sql.startsWith("SELECT mime, data FROM user_note_images")) {
      const row = T.user_note_images.find(
        (r) => r.user_id === a[0] && r.chapter_id === a[1] && r.word_id === a[2]
      );
      return row ? [{ mime: row.mime, data: row.data }] : [];
    }
    if (sql.startsWith("SELECT chapter_id, word_id, mime, data FROM user_note_images")) {
      return T.user_note_images.filter((r) => r.user_id === a[0]);
    }
    if (sql.startsWith("INSERT INTO user_note_images")) {
      const [user_id, chapter_id, word_id, mime, data, updated_at] = a;
      const row = T.user_note_images.find(
        (r) => r.user_id === user_id && r.chapter_id === chapter_id && r.word_id === word_id
      );
      if (row) Object.assign(row, { mime, data, updated_at });
      else T.user_note_images.push({ user_id, chapter_id, word_id, mime, data, updated_at });
      return [];
    }
    if (sql.startsWith("DELETE FROM user_note_images")) {
      T.user_note_images = T.user_note_images.filter(
        (r) => !(r.user_id === a[0] && r.chapter_id === a[1] && r.word_id === a[2])
      );
      return [];
    }

    throw new Error(`FakeD1 未实现的 SQL：${sql}`);
  }
}
