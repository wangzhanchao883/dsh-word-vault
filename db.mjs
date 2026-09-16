/**
 * SQLite 落库层(node:sqlite,DSH 运行时 node 22 自带;该构建无 FTS5,本项目不需要全文检索)。
 *
 * 表结构:
 *   users          多用户(各自独立的生词库视图)
 *   dict           全局词典缓存(一个词只翻一次,跨用户共享,省 LLM 调用)
 *   words          词条:kind=word 单词 / kind=phrase 词组;带首次/最近录入时间、出现次数、掌握状态、连对 streak
 *   events         每次录入一条流水(来源=热键/拍照/考试/手动),统计与回溯的唯一依据
 *   exam_sessions  一场考试
 *   exam_answers   每题作答(连续答对打标、答错清零的唯一依据)
 *
 * 物化索引可重建:words 是 events 的投影,必要时可由 events 重算(见 rebuildCounters)。
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const SCHEMA_VERSION = 2;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  hotkey     TEXT NOT NULL DEFAULT '',
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS dict (
  term       TEXT PRIMARY KEY,
  kind       TEXT NOT NULL DEFAULT 'word',
  phonetic   TEXT NOT NULL DEFAULT '',
  pos        TEXT NOT NULL DEFAULT '',
  meaning    TEXT NOT NULL DEFAULT '',
  source     TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS words (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  kind         TEXT NOT NULL DEFAULT 'word',
  term         TEXT NOT NULL,
  lemma        TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  seen_count   INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'learning',
  streak       INTEGER NOT NULL DEFAULT 0,
  wrong_count  INTEGER NOT NULL DEFAULT 0,
  last_exam_at TEXT,
  mastered_at  TEXT,
  UNIQUE (user_id, kind, lemma)
);
CREATE INDEX IF NOT EXISTS idx_words_user_last ON words(user_id, last_seen_at);
CREATE INDEX IF NOT EXISTS idx_words_user_count ON words(user_id, seen_count);
CREATE INDEX IF NOT EXISTS idx_words_user_status ON words(user_id, status);
CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  word_id    INTEGER REFERENCES words(id),
  kind       TEXT NOT NULL,
  via        TEXT NOT NULL DEFAULT '',
  context    TEXT NOT NULL DEFAULT '',
  capture_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
CREATE INDEX IF NOT EXISTS idx_events_user ON events(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_events_capture ON events(capture_id);
-- 一次抓取(一次 Ctrl+C / 一次拍照 / 一次对话录入)= 一行,支撑浮窗的「改库」「撤销」
CREATE TABLE IF NOT EXISTS captures (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  via        TEXT NOT NULL DEFAULT '',
  text       TEXT NOT NULL DEFAULT '',
  item_count INTEGER NOT NULL DEFAULT 0,
  status     TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_captures_created ON captures(created_at);
CREATE TABLE IF NOT EXISTS exam_sessions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  scope       TEXT NOT NULL DEFAULT '{}',
  size        INTEGER NOT NULL DEFAULT 0,
  correct     INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  finished_at TEXT
);
CREATE TABLE IF NOT EXISTS exam_answers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  INTEGER NOT NULL REFERENCES exam_sessions(id),
  user_id     INTEGER NOT NULL REFERENCES users(id),
  word_id     INTEGER NOT NULL REFERENCES words(id),
  prompt      TEXT NOT NULL DEFAULT '',
  chosen      TEXT NOT NULL DEFAULT '',
  correct     INTEGER NOT NULL DEFAULT 0,
  is_recheck  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_answers_word ON exam_answers(word_id, created_at);
`;

/** 当前时刻(本地时区 ISO,便于直接当"录入时间"读) */
export function nowIso(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const off = -date.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

/** 打开(必要时创建)数据库并建表 */
export function openDb(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  migrate(db);
  db.prepare("INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run("schema_version", String(SCHEMA_VERSION));
  return db;
}

/** 轻量迁移:老库缺列就补列(新库由 SCHEMA 直接建全) */
function migrate(db) {
  const cols = db.prepare("PRAGMA table_info(events)").all().map((c) => c.name);
  if (!cols.includes("capture_id")) {
    db.exec("ALTER TABLE events ADD COLUMN capture_id TEXT NOT NULL DEFAULT ''");
    db.exec("CREATE INDEX IF NOT EXISTS idx_events_capture ON events(capture_id)");
  }
}

export function closeDb(db) {
  try {
    db.close();
  } catch {
    /* 已关闭 */
  }
}

/** 建用户(幂等),返回用户行 */
export function ensureUser(db, name, hotkey = "", enabled = true) {
  const row = db.prepare("SELECT * FROM users WHERE name = ?").get(name);
  if (row) {
    if (hotkey && row.hotkey !== hotkey) {
      db.prepare("UPDATE users SET hotkey = ? WHERE id = ?").run(hotkey, row.id);
      row.hotkey = hotkey;
    }
    return row;
  }
  db.prepare("INSERT INTO users(name, hotkey, enabled, created_at) VALUES(?, ?, ?, ?)")
    .run(name, hotkey, enabled ? 1 : 0, nowIso());
  return db.prepare("SELECT * FROM users WHERE name = ?").get(name);
}

export function listUsers(db) {
  return db.prepare("SELECT * FROM users ORDER BY id").all();
}

export function findUser(db, nameOrId) {
  if (nameOrId === undefined || nameOrId === null || nameOrId === "") return null;
  if (typeof nameOrId === "number" || /^\d+$/.test(String(nameOrId))) {
    const byId = db.prepare("SELECT * FROM users WHERE id = ?").get(Number(nameOrId));
    if (byId) return byId;
  }
  return db.prepare("SELECT * FROM users WHERE name = ?").get(String(nameOrId)) ?? null;
}

/** 批量写词典缓存(同词已存在则不覆盖已有释义,除非 force) */
export function upsertDict(db, entries, { force = false } = {}) {
  const now = nowIso();
  const insert = db.prepare(
    `INSERT INTO dict(term, kind, phonetic, pos, meaning, source, created_at, updated_at)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(term) DO UPDATE SET
       phonetic = CASE WHEN excluded.phonetic <> '' THEN excluded.phonetic ELSE dict.phonetic END,
       pos      = CASE WHEN excluded.pos <> '' THEN excluded.pos ELSE dict.pos END,
       meaning  = CASE WHEN ${force ? "1" : "excluded.meaning <> '' AND dict.meaning = ''"} THEN excluded.meaning ELSE dict.meaning END,
       source   = excluded.source,
       updated_at = excluded.updated_at`,
  );
  let n = 0;
  for (const e of Array.isArray(entries) ? entries : []) {
    const term = String(e && e.term ? e.term : "").trim().toLowerCase();
    if (!term) continue;
    insert.run(
      term,
      String(e.kind || "word"),
      String(e.phonetic || ""),
      String(e.pos || ""),
      String(e.meaning || ""),
      String(e.source || "llm"),
      now,
      now,
    );
    n += 1;
  }
  return n;
}

export function getDict(db, terms) {
  const list = (Array.isArray(terms) ? terms : []).map((t) => String(t).trim().toLowerCase()).filter(Boolean);
  if (!list.length) return new Map();
  const stmt = db.prepare("SELECT * FROM dict WHERE term = ?");
  const out = new Map();
  for (const t of list) {
    const row = stmt.get(t);
    if (row) out.set(t, row);
  }
  return out;
}

/**
 * 录入一批词条:新词插入(seen_count=1),老词计数 +1,并各写一条 event。
 * 同一批内已按 lemma 去重,所以"同一次录入重复出现"只算一次(用户口径)。
 * @returns {{items: Array<{term:string, status:'new'|'repeat', seenCount:number, wordId:number}>, at:string, captureId:string}}
 */
export function recordEntries(db, { userId, entries, kind = "hotkey", via = "", context = "", captureId = "" }) {
  const at = nowIso();
  const cid = captureId || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const findStmt = db.prepare("SELECT * FROM words WHERE user_id = ? AND kind = ? AND lemma = ?");
  const insertStmt = db.prepare(
    `INSERT INTO words(user_id, kind, term, lemma, first_seen_at, last_seen_at, seen_count, status)
     VALUES(?, ?, ?, ?, ?, ?, 1, 'learning')`,
  );
  const bumpStmt = db.prepare("UPDATE words SET seen_count = seen_count + 1, last_seen_at = ?, term = ? WHERE id = ?");
  const eventStmt = db.prepare(
    "INSERT INTO events(user_id, word_id, kind, via, context, capture_id, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)",
  );

  const items = [];
  for (const raw of Array.isArray(entries) ? entries : []) {
    const term = String(raw && raw.term ? raw.term : "").trim().toLowerCase();
    const lemma = String(raw && raw.lemma ? raw.lemma : term).trim().toLowerCase();
    const entryKind = String(raw && raw.kind ? raw.kind : "word");
    if (!term || !lemma) continue;
    const existing = findStmt.get(userId, entryKind, lemma);
    let wordId;
    let status;
    let seenCount;
    if (existing) {
      bumpStmt.run(at, term, existing.id);
      wordId = existing.id;
      status = "repeat";
      seenCount = existing.seen_count + 1;
    } else {
      const info = insertStmt.run(userId, entryKind, term, lemma, at, at);
      wordId = Number(info.lastInsertRowid);
      status = "new";
      seenCount = 1;
    }
    eventStmt.run(userId, wordId, kind, via, String(context || "").slice(0, 500), cid, at);
    items.push({ term, kind: entryKind, status, seenCount, wordId, lemma });
  }
  db.prepare(
    `INSERT INTO captures(id, user_id, via, text, item_count, status, created_at)
     VALUES(?, ?, ?, ?, ?, 'active', ?)
     ON CONFLICT(id) DO UPDATE SET item_count = item_count + excluded.item_count, text = excluded.text`,
  ).run(cid, userId, via || kind, String(context || "").slice(0, 1000), items.length, at);
  return { items, at, captureId: cid };
}

export function getCapture(db, captureId) {
  return db.prepare("SELECT * FROM captures WHERE id = ?").get(String(captureId)) ?? null;
}

export function listCaptures(db, userId, limit = 10) {
  const n = Math.max(1, Math.min(100, Number(limit) || 10));
  if (userId) return db.prepare("SELECT * FROM captures WHERE user_id = ? ORDER BY created_at DESC LIMIT ?").all(userId, n);
  return db.prepare("SELECT * FROM captures ORDER BY created_at DESC LIMIT ?").all(n);
}

/**
 * 撤销一次抓取:删掉它的 events,并把受影响词条的计数/时间戳按剩余 events 重算;
 * 一个词条若不再有任何 events(说明是这次新建的)就整条删除。
 */
export function undoCapture(db, captureId) {
  const cap = getCapture(db, captureId);
  if (!cap) return { ok: false, error: `没有这次抓取记录:${captureId}` };
  if (cap.status !== "active") return { ok: false, error: `这次抓取已是 ${cap.status} 状态,不能重复操作` };

  const rows = db.prepare("SELECT DISTINCT word_id FROM events WHERE capture_id = ? AND word_id IS NOT NULL").all(captureId);
  const delEvents = db.prepare("DELETE FROM events WHERE capture_id = ?").run(captureId);
  const agg = db.prepare(
    "SELECT COUNT(*) AS n, MIN(created_at) AS first, MAX(created_at) AS last FROM events WHERE word_id = ?",
  );
  let removed = 0;
  let adjusted = 0;
  for (const r of rows) {
    const a = agg.get(r.word_id);
    if (!a || !a.n) {
      db.prepare("DELETE FROM words WHERE id = ?").run(r.word_id);
      removed += 1;
    } else {
      db.prepare("UPDATE words SET seen_count = ?, first_seen_at = ?, last_seen_at = ? WHERE id = ?")
        .run(a.n, a.first, a.last, r.word_id);
      adjusted += 1;
    }
  }
  db.prepare("UPDATE captures SET status = 'undone', updated_at = ? WHERE id = ?").run(nowIso(), captureId);
  return { ok: true, deletedEvents: Number(delEvents.changes), removedWords: removed, adjustedWords: adjusted, user: cap.user_id };
}

/**
 * 把一次抓取改到另一个用户:先撤销原抓取,再把同样的内容记到目标用户(生成新的 captureId)。
 * @returns {{ok:boolean, moved?:number, toUser?:string, newCaptureId?:string, error?:string}}
 */
export function reassignCapture(db, captureId, targetUserId) {
  const cap = getCapture(db, captureId);
  if (!cap) return { ok: false, error: `没有这次抓取记录:${captureId}` };
  if (cap.user_id === targetUserId) return { ok: false, error: "目标用户与原用户相同" };
  const words = db
    .prepare(
      `SELECT w.term, w.kind, w.lemma FROM events e JOIN words w ON w.id = e.word_id
       WHERE e.capture_id = ? GROUP BY w.id`,
    )
    .all(captureId);
  const undo = undoCapture(db, captureId);
  if (!undo.ok) return undo;
  if (!words.length) return { ok: false, error: "这次抓取没有可移动的词条" };
  const res = recordEntries(db, {
    userId: targetUserId,
    entries: words.map((w) => ({ term: w.term, lemma: w.lemma, kind: w.kind })),
    kind: "manual",
    via: "reassign",
    context: cap.text,
  });
  db.prepare("UPDATE captures SET status = 'moved', updated_at = ? WHERE id = ?").run(nowIso(), captureId);
  // 新抓取保持 active 才能被继续撤销;它的来源由 via='reassign' 表达
  return { ok: true, moved: words.length, newCaptureId: res.captureId };
}

/**
 * 按维度查词。
 * @param {{userId:number, since?:string, until?:string, minCount?:number, maxCount?:number,
 *          status?:string, kind?:string, orderBy?:string, limit?:number}} filter
 */
export function queryWords(db, filter = {}) {
  const where = ["w.user_id = ?"];
  const params = [filter.userId];
  if (filter.since) {
    where.push("w.first_seen_at >= ?");
    params.push(filter.since);
  }
  if (filter.until) {
    where.push("w.first_seen_at <= ?");
    params.push(filter.until);
  }
  if (Number.isFinite(filter.minCount)) {
    where.push("w.seen_count >= ?");
    params.push(filter.minCount);
  }
  if (Number.isFinite(filter.maxCount)) {
    where.push("w.seen_count <= ?");
    params.push(filter.maxCount);
  }
  if (filter.status) {
    where.push("w.status = ?");
    params.push(filter.status);
  }
  if (filter.kind) {
    where.push("w.kind = ?");
    params.push(filter.kind);
  }
  const order = {
    count: "w.seen_count DESC, w.last_seen_at DESC",
    recent: "w.last_seen_at DESC",
    oldest: "w.first_seen_at ASC",
    alpha: "w.lemma ASC",
    stale: "w.last_exam_at IS NOT NULL ASC, w.last_exam_at ASC, w.seen_count DESC",
  }[filter.orderBy || "recent"] || "w.last_seen_at DESC";
  const limit = Number.isFinite(filter.limit) ? Math.max(1, Math.min(2000, filter.limit)) : 50;

  return db
    .prepare(
      `SELECT w.*, d.phonetic, d.pos, d.meaning
       FROM words w LEFT JOIN dict d ON d.term = w.lemma
       WHERE ${where.join(" AND ")}
       ORDER BY ${order}
       LIMIT ?`,
    )
    .all(...params, limit);
}

/**
 * 今日录入次数(用于"今日累计录入 N 词"的正反馈)。
 * created_at 是本地时区 ISO(带 +08:00 偏移),直接取前 10 位比较本地日期;
 * 不用 SQLite 的 date() —— 它会按 UTC 归一,跨零点会算错一天。
 */
export function todayCount(db, userId, dateStr = null) {
  const day = dateStr || localDateString();
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM events WHERE user_id = ? AND substr(created_at, 1, 10) = ?")
    .get(userId, day);
  return row ? row.n : 0;
}

/** 本地日期 YYYY-MM-DD */
export function localDateString(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 库统计(按用户) */
export function stats(db, userId) {  const one = (sql, ...p) => db.prepare(sql).get(...p);
  const total = one("SELECT COUNT(*) AS n FROM words WHERE user_id = ?", userId).n;
  const learned = one("SELECT COUNT(*) AS n FROM words WHERE user_id = ? AND status = 'mastered'", userId).n;
  const half = one("SELECT COUNT(*) AS n FROM words WHERE user_id = ? AND status = 'half'", userId).n;
  const phrases = one("SELECT COUNT(*) AS n FROM words WHERE user_id = ? AND kind = 'phrase'", userId).n;
  const events = one("SELECT COUNT(*) AS n FROM events WHERE user_id = ?", userId).n;
  const dictSize = one("SELECT COUNT(*) AS n FROM dict").n;
  const lastEvent = one("SELECT created_at FROM events WHERE user_id = ? ORDER BY id DESC LIMIT 1", userId);
  const top = db
    .prepare("SELECT term, seen_count FROM words WHERE user_id = ? ORDER BY seen_count DESC, last_seen_at DESC LIMIT 5")
    .all(userId);
  return {
    total,
    learning: total - learned - half,
    mastered: learned,
    half,
    phrases,
    events,
    dictSize,
    lastEventAt: lastEvent ? lastEvent.created_at : null,
    top,
  };
}

/** 手动改掌握状态(词库管理界面/对话工具用) */
export function setStatus(db, userId, term, status) {
  const map = { master: "mastered", mastered: "mastered", learning: "learning", half: "half", 已学会: "mastered", 未掌握: "learning", 半掌握: "half" };
  const next = map[String(status)] || String(status);
  if (!["learning", "half", "mastered"].includes(next)) {
    return { ok: false, error: `未知状态:${status}(可用 learning/half/mastered)` };
  }
  const lemma = String(term).trim().toLowerCase();
  const row = db.prepare("SELECT * FROM words WHERE user_id = ? AND lemma = ?").get(userId, lemma);
  if (!row) return { ok: false, error: `库里没有这个词:${term}` };
  const masteredAt = next === "mastered" ? nowIso() : null;
  const streak = next === "mastered" ? Math.max(row.streak, 3) : 0;
  db.prepare("UPDATE words SET status = ?, mastered_at = ?, streak = ? WHERE id = ?").run(next, masteredAt, streak, row.id);
  return { ok: true, term: row.term, status: next };
}

export function deleteWord(db, userId, term) {
  const lemma = String(term).trim().toLowerCase();
  const row = db.prepare("SELECT * FROM words WHERE user_id = ? AND lemma = ?").get(userId, lemma);
  if (!row) return { ok: false, error: `库里没有这个词:${term}` };
  db.prepare("DELETE FROM events WHERE word_id = ?").run(row.id);
  db.prepare("DELETE FROM words WHERE id = ?").run(row.id);
  return { ok: true, term: row.term };
}

/** 由 events 重算 seen_count / first_seen_at / last_seen_at(索引可重建性) */
export function rebuildCounters(db, userId) {
  const rows = db.prepare("SELECT id FROM words WHERE user_id = ?").all(userId);
  const agg = db.prepare(
    "SELECT COUNT(*) AS n, MIN(created_at) AS first, MAX(created_at) AS last FROM events WHERE word_id = ?",
  );
  const upd = db.prepare("UPDATE words SET seen_count = ?, first_seen_at = ?, last_seen_at = ? WHERE id = ?");
  let n = 0;
  for (const r of rows) {
    const a = agg.get(r.id);
    if (!a || !a.n) continue;
    upd.run(a.n, a.first, a.last, r.id);
    n += 1;
  }
  return { updated: n };
}
