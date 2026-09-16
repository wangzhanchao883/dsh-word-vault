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

export const SCHEMA_VERSION = 4;

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
-- 记忆卡内容(拆词 + 荒诞梗)。落库的意义:出片可复现、可只重生成某几个词、不重复烧 token。
-- segs 存 JSON 数组 [{en,cn}];卡片主词用词元 lemma,与 words.lemma 对齐。
CREATE TABLE IF NOT EXISTS cards (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  word_id    INTEGER NOT NULL REFERENCES words(id),
  term       TEXT NOT NULL,
  phonetic   TEXT NOT NULL DEFAULT '',
  pos        TEXT NOT NULL DEFAULT '',
  meaning    TEXT NOT NULL DEFAULT '',
  segs       TEXT NOT NULL DEFAULT '[]',
  story      TEXT NOT NULL DEFAULT '',
  model      TEXT NOT NULL DEFAULT '',
  source     TEXT NOT NULL DEFAULT 'llm',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, word_id)
);
CREATE INDEX IF NOT EXISTS idx_cards_user ON cards(user_id);
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
-- 一场考试的题目(题干句子 + 四个选项 + 答案位置)。答案存库,判分以库为准,页面改不了分。
CREATE TABLE IF NOT EXISTS exam_questions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    INTEGER NOT NULL REFERENCES exam_sessions(id),
  seq           INTEGER NOT NULL,
  word_id       INTEGER NOT NULL REFERENCES words(id),
  prompt_word   TEXT NOT NULL,
  sentence      TEXT NOT NULL DEFAULT '',
  sentence_src  TEXT NOT NULL DEFAULT '',
  correct_meaning TEXT NOT NULL,
  options       TEXT NOT NULL DEFAULT '[]',
  answer_index  INTEGER NOT NULL DEFAULT 0,
  chosen_index  INTEGER,
  is_correct    INTEGER,
  is_recheck    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  answered_at   TEXT,
  UNIQUE (session_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_exam_q_session ON exam_questions(session_id, seq);
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
  const scols = db.prepare("PRAGMA table_info(exam_sessions)").all().map((c) => c.name);
  if (!scols.includes("status")) db.exec("ALTER TABLE exam_sessions ADD COLUMN status TEXT NOT NULL DEFAULT 'open'");
  if (!scols.includes("token")) db.exec("ALTER TABLE exam_sessions ADD COLUMN token TEXT NOT NULL DEFAULT ''");
  if (!scols.includes("served_at")) db.exec("ALTER TABLE exam_sessions ADD COLUMN served_at TEXT");
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
      `SELECT w.*, d.phonetic, d.pos, d.meaning,
              c.id AS card_id, c.term AS card_term, c.phonetic AS card_phonetic,
              c.pos AS card_pos, c.meaning AS card_meaning, c.segs AS card_segs,
              c.story AS card_story, c.model AS card_model, c.source AS card_source,
              c.updated_at AS card_updated_at
       FROM words w
       LEFT JOIN dict d ON d.term = w.lemma
       LEFT JOIN cards c ON c.word_id = w.id AND c.user_id = w.user_id
       WHERE ${where.join(" AND ")}
       ORDER BY ${order}
       LIMIT ?`,
    )
    .all(...params, limit);
}

/**
 * 写/更新一张记忆卡。同一 (user, word) 只有一张,重复生成即覆盖(便于"只重做某几个词")。
 * @returns {{ok:boolean, created:boolean, wordId:number}}
 */
export function upsertCard(db, { userId, wordId, term, phonetic = "", pos = "", meaning = "", segs = [], story = "", model = "", source = "llm" }) {
  const at = nowIso();
  const segsJson = JSON.stringify(Array.isArray(segs) ? segs : []);
  const existing = db.prepare("SELECT id FROM cards WHERE user_id = ? AND word_id = ?").get(userId, wordId);
  if (existing) {
    db.prepare(
      `UPDATE cards SET term = ?, phonetic = ?, pos = ?, meaning = ?, segs = ?, story = ?, model = ?, source = ?, updated_at = ?
       WHERE id = ?`,
    ).run(term, phonetic, pos, meaning, segsJson, story, model, source, at, existing.id);
    return { ok: true, created: false, wordId };
  }
  db.prepare(
    `INSERT INTO cards(user_id, word_id, term, phonetic, pos, meaning, segs, story, model, source, created_at, updated_at)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(userId, wordId, term, phonetic, pos, meaning, segsJson, story, model, source, at, at);
  return { ok: true, created: true, wordId };
}

export function getCard(db, userId, wordId) {
  return db.prepare("SELECT * FROM cards WHERE user_id = ? AND word_id = ?").get(userId, wordId) ?? null;
}

export function deleteCard(db, userId, wordId) {
  const n = db.prepare("DELETE FROM cards WHERE user_id = ? AND word_id = ?").run(userId, wordId);
  return { ok: Number(n.changes) > 0 };
}

/** 记忆卡进度:某用户有卡/无卡的词数 */
export function cardStats(db, userId) {
  const total = db.prepare("SELECT COUNT(*) AS n FROM words WHERE user_id = ?").get(userId).n;
  const withCard = db
    .prepare("SELECT COUNT(*) AS n FROM cards c JOIN words w ON w.id = c.word_id WHERE c.user_id = ? AND w.kind = 'word'")
    .get(userId).n;
  const stale = db
    .prepare(
      `SELECT COUNT(*) AS n FROM cards c JOIN words w ON w.id = c.word_id
       WHERE c.user_id = ? AND c.updated_at < w.last_seen_at`,
    )
    .get(userId).n;
  return { total, withCard, withoutCard: Math.max(0, total - withCard), stale };
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
  const r = deleteWords(db, { userId, terms: [term] });
  if (!r.ok) return { ok: false, error: `库里没有这个词:${term}` };
  return { ok: true, term: r.deleted[0].term, removed: r.removed };
}

/**
 * 删词的"影响预览":删之前先让用户看清会连带清掉什么。
 * 不预览就删是这个项目里最容易后悔的操作(卡片、考试记录都是不可恢复的)。
 */
export function wordDeleteImpact(db, userId, terms) {
  const list = (Array.isArray(terms) ? terms : [terms]).map((t) => String(t || "").trim().toLowerCase()).filter(Boolean);
  const one = (sql) => db.prepare(sql);
  const out = [];
  for (const lemma of list) {
    const row = db.prepare("SELECT * FROM words WHERE user_id = ? AND lemma = ?").get(userId, lemma);
    if (!row) {
      out.push({ lemma, found: false });
      continue;
    }
    out.push({
      lemma,
      found: true,
      id: row.id,
      term: row.term,
      kind: row.kind,
      seenCount: row.seen_count,
      status: row.status,
      events: one("SELECT COUNT(*) AS n FROM events WHERE word_id = ?").get(row.id).n,
      cards: one("SELECT COUNT(*) AS n FROM cards WHERE word_id = ?").get(row.id).n,
      examQuestions: one("SELECT COUNT(*) AS n FROM exam_questions WHERE word_id = ?").get(row.id).n,
      examAnswers: one("SELECT COUNT(*) AS n FROM exam_answers WHERE word_id = ?").get(row.id).n,
    });
  }
  return out;
}

/**
 * 批量删词(含全部连带数据)。
 *
 * 坑(2026-09-16 实测):老的 deleteWord 只删 events + words,而库开了 `PRAGMA foreign_keys = ON`,
 * 于是**任何有记忆卡或考过试的词都删不掉**——SQLite 会直接抛 FOREIGN KEY constraint failed。
 * 所以这里按外键依赖顺序清:exam_answers → exam_questions → cards → events → words。
 *
 * @returns {{ok:boolean, deleted:Array, missing:Array<string>, removed:{events:number,cards:number,examQuestions:number,examAnswers:number}}}
 */
export function deleteWords(db, { userId, terms }) {
  const list = (Array.isArray(terms) ? terms : [terms]).map((t) => String(t || "").trim().toLowerCase()).filter(Boolean);
  const deleted = [];
  const missing = [];
  const removed = { events: 0, cards: 0, examQuestions: 0, examAnswers: 0 };
  const del = {
    answers: db.prepare("DELETE FROM exam_answers WHERE word_id = ?"),
    questions: db.prepare("DELETE FROM exam_questions WHERE word_id = ?"),
    cards: db.prepare("DELETE FROM cards WHERE word_id = ?"),
    events: db.prepare("DELETE FROM events WHERE word_id = ?"),
    words: db.prepare("DELETE FROM words WHERE id = ?"),
  };
  for (const lemma of list) {
    const row = db.prepare("SELECT * FROM words WHERE user_id = ? AND lemma = ?").get(userId, lemma);
    if (!row) {
      missing.push(lemma);
      continue;
    }
    const a = Number(del.answers.run(row.id).changes) || 0;
    const q = Number(del.questions.run(row.id).changes) || 0;
    const c = Number(del.cards.run(row.id).changes) || 0;
    const e = Number(del.events.run(row.id).changes) || 0;
    del.words.run(row.id);
    removed.examAnswers += a;
    removed.examQuestions += q;
    removed.cards += c;
    removed.events += e;
    deleted.push({ lemma, term: row.term, events: e, cards: c, examQuestions: q, examAnswers: a });
  }
  return { ok: deleted.length > 0, deleted, missing, removed };
}

/** 改词条释义(写 dict 这张全局词典缓存;同一 lemma 全库生效) */
export function updateDictMeaning(db, { term, meaning, pos, phonetic }) {
  const key = String(term || "").trim().toLowerCase();
  if (!key) return { ok: false, error: "缺少 term" };
  const at = nowIso();
  const existing = db.prepare("SELECT * FROM dict WHERE term = ?").get(key);
  const next = {
    meaning: meaning === undefined ? (existing ? existing.meaning : "") : String(meaning),
    pos: pos === undefined ? (existing ? existing.pos : "") : String(pos),
    phonetic: phonetic === undefined ? (existing ? existing.phonetic : "") : String(phonetic),
  };
  db.prepare(
    `INSERT INTO dict(term, kind, phonetic, pos, meaning, source, created_at, updated_at)
     VALUES(?, ?, ?, ?, ?, 'manual', ?, ?)
     ON CONFLICT(term) DO UPDATE SET phonetic = excluded.phonetic, pos = excluded.pos,
       meaning = excluded.meaning, source = 'manual', updated_at = excluded.updated_at`,
  ).run(key, existing ? existing.kind : "word", next.phonetic, next.pos, next.meaning, at, at);
  return { ok: true, term: key, ...next };
}

/** 各用户库的总览(给界面用):词数 / 事件数 / 已学会数 */
export function userOverview(db) {
  return listUsers(db).map((u) => ({
    id: u.id,
    name: u.name,
    enabled: !!u.enabled,
    words: db.prepare("SELECT COUNT(*) AS n FROM words WHERE user_id = ? AND kind = 'word'").get(u.id).n,
    phrases: db.prepare("SELECT COUNT(*) AS n FROM words WHERE user_id = ? AND kind = 'phrase'").get(u.id).n,
    mastered: db.prepare("SELECT COUNT(*) AS n FROM words WHERE user_id = ? AND status = 'mastered'").get(u.id).n,
    events: db.prepare("SELECT COUNT(*) AS n FROM events WHERE user_id = ?").get(u.id).n,
    createdAt: u.created_at,
  }));
}

/**
 * 给用户库改名。
 * 词条挂在 user_id 上,所以只改 users.name 即可;但不能和现有名字撞车(否则 findUser 会打架)。
 * @returns {{ok:boolean, error?:string, id?:number, from?:string, to?:string}}
 */
export function renameUser(db, { from, to }) {
  const oldName = String(from || "").trim();
  const newName = String(to || "").trim();
  if (!oldName) return { ok: false, error: "缺少原用户名" };
  if (!newName) return { ok: false, error: "新用户名不能为空" };
  if (newName.length > 24) return { ok: false, error: "新用户名太长（最多 24 字）" };
  if (newName === oldName) return { ok: true, id: null, from: oldName, to: newName, unchanged: true };
  const row = db.prepare("SELECT * FROM users WHERE name = ?").get(oldName);
  if (!row) return { ok: false, error: `没有这个用户库:${oldName}` };
  if (db.prepare("SELECT * FROM users WHERE name = ?").get(newName)) {
    return { ok: false, error: `已经有一个叫「${newName}」的用户库了，换个名字吧` };
  }
  db.prepare("UPDATE users SET name = ? WHERE id = ?").run(newName, row.id);
  return { ok: true, id: row.id, from: oldName, to: newName };
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

/** 该词最近的录入原文(context 里存着用户当时复制的那句) — 出题题干优先用它 */
export function recentContexts(db, wordId, limit = 10) {
  const n = Math.max(1, Math.min(50, Number(limit) || 10));
  return db
    .prepare("SELECT context, via, created_at FROM events WHERE word_id = ? AND context <> '' ORDER BY id DESC LIMIT ?")
    .all(wordId, n);
}

/**
 * ============================ P3 考试 ============================
 *
 * 掌握度唯一口径(2026-09-16 用户确认):
 *   · 答对:streak + 1;streak >= 3 → 该词打「已学会」
 *   · 答错:streak 归零;若原本已学会 → 摘牌回 learning
 * 判分只在 answerExamQuestion 里发生,答案存库,答题页改不了分。
 */

export function createExamSession(db, { userId, scope = {}, count = 0, token = "" }) {
  const at = nowIso();
  const info = db
    .prepare("INSERT INTO exam_sessions(user_id, scope, size, correct, created_at, status, token) VALUES(?, ?, 0, 0, ?, 'open', ?)")
    .run(userId, JSON.stringify(scope || {}), at, token);
  return getExamSession(db, Number(info.lastInsertRowid));
}

export function getExamSession(db, sessionId) {
  return db.prepare("SELECT * FROM exam_sessions WHERE id = ?").get(sessionId) ?? null;
}

export function listExamSessions(db, userId, limit = 10) {
  const n = Math.max(1, Math.min(100, Number(limit) || 10));
  return db.prepare("SELECT * FROM exam_sessions WHERE user_id = ? ORDER BY id DESC LIMIT ?").all(userId, n);
}

export function addExamQuestion(db, {
  sessionId, seq, wordId, promptWord, sentence = "", sentenceSrc = "",
  correctMeaning, options = [], answerIndex = 0, isRecheck = false,
}) {
  const at = nowIso();
  db.prepare(
    `INSERT INTO exam_questions(session_id, seq, word_id, prompt_word, sentence, sentence_src,
       correct_meaning, options, answer_index, is_recheck, created_at)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(sessionId, seq, wordId, promptWord, sentence, sentenceSrc, correctMeaning, JSON.stringify(options), answerIndex, isRecheck ? 1 : 0, at);
  db.prepare("UPDATE exam_sessions SET size = size + 1 WHERE id = ?").run(sessionId);
  return db.prepare("SELECT * FROM exam_questions WHERE session_id = ? AND seq = ?").get(sessionId, seq);
}

/** 题目(带答案,仅供服务端判分/答案页使用) */
export function listExamQuestions(db, sessionId) {
  return db
    .prepare("SELECT q.*, w.lemma, w.seen_count, w.status AS word_status FROM exam_questions q JOIN words w ON w.id = q.word_id WHERE q.session_id = ? ORDER BY q.seq")
    .all(sessionId)
    .map(decodeQuestion);
}

/** 题目(剥掉答案,给答题页) */
export function listExamQuestionsPublic(db, sessionId) {
  return listExamQuestions(db, sessionId).map(({ answerIndex, correctMeaning, ...rest }) => rest);
}

function decodeQuestion(row) {
  let options = [];
  try {
    options = JSON.parse(row.options || "[]");
  } catch {
    options = [];
  }
  return {
    id: row.id,
    sessionId: row.session_id,
    seq: row.seq,
    wordId: row.word_id,
    word: row.prompt_word,
    lemma: row.lemma,
    sentence: row.sentence,
    sentenceSrc: row.sentence_src,
    correctMeaning: row.correct_meaning,
    options,
    answerIndex: row.answer_index,
    chosenIndex: row.chosen_index,
    isCorrect: row.is_correct === null ? null : !!row.is_correct,
    isRecheck: !!row.is_recheck,
    wordStatus: row.word_status,
    seenCount: row.seen_count,
  };
}

/**
 * 判一道题:写答题状态、写答题流水、回写词的 streak/掌握状态。
 * @returns {{ok:boolean, error?:string, isCorrect?:boolean, correctIndex?:number, correctMeaning?:string,
 *            word?:string, streak?:number, status?:string, mastered?:boolean, demoted?:boolean}}
 */
export function answerExamQuestion(db, { sessionId, seq, chosenIndex }) {
  const q = db.prepare("SELECT * FROM exam_questions WHERE session_id = ? AND seq = ?").get(sessionId, seq);
  if (!q) return { ok: false, error: `这场考试没有第 ${seq} 题` };
  if (q.chosen_index !== null && q.chosen_index !== undefined) {
    return { ok: false, error: `第 ${seq} 题已经答过了(选了 ${q.chosen_index})` };
  }
  const at = nowIso();
  const isCorrect = Number(chosenIndex) === Number(q.answer_index);
  const options = (() => {
    try {
      return JSON.parse(q.options || "[]");
    } catch {
      return [];
    }
  })();
  const chosenText = options[Number(chosenIndex)] ?? "";

  db.prepare("UPDATE exam_questions SET chosen_index = ?, is_correct = ?, answered_at = ? WHERE id = ?")
    .run(Number(chosenIndex), isCorrect ? 1 : 0, at, q.id);

  const w = db.prepare("SELECT * FROM words WHERE id = ?").get(q.word_id);
  let streak = w ? w.streak : 0;
  let status = w ? w.status : "learning";
  let mastered = false;
  let demoted = false;
  if (w) {
    if (isCorrect) {
      streak += 1;
      if (streak >= 3 && status !== "mastered") {
        status = "mastered";
        mastered = true;
      }
      db.prepare("UPDATE words SET streak = ?, status = ?, mastered_at = ?, last_exam_at = ? WHERE id = ?")
        .run(streak, status, status === "mastered" ? (w.mastered_at || at) : null, at, w.id);
    } else {
      streak = 0;
      if (status === "mastered") {
        status = "learning";
        demoted = true;
      }
      db.prepare("UPDATE words SET streak = 0, status = ?, mastered_at = NULL, wrong_count = wrong_count + 1, last_exam_at = ? WHERE id = ?")
        .run(status, at, w.id);
    }
  }

  // 答题流水(不可变日志,便于日后分析)
  db.prepare(
    "INSERT INTO exam_answers(session_id, user_id, word_id, prompt, chosen, correct, is_recheck, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(sessionId, q.session_id ? db.prepare("SELECT user_id FROM exam_sessions WHERE id = ?").get(sessionId).user_id : null, q.word_id, q.correct_meaning, chosenText, isCorrect ? 1 : 0, q.is_recheck, at);

  db.prepare("UPDATE exam_sessions SET correct = correct + ? WHERE id = ?").run(isCorrect ? 1 : 0, sessionId);

  return {
    ok: true,
    isCorrect,
    correctIndex: q.answer_index,
    correctMeaning: q.correct_meaning,
    chosenText,
    correctText: options[q.answer_index] ?? "",
    word: q.prompt_word,
    streak,
    status,
    mastered,
    demoted,
  };
}

export function finishExamSession(db, sessionId) {
  const at = nowIso();
  db.prepare("UPDATE exam_sessions SET finished_at = ?, status = 'done' WHERE id = ?").run(at, sessionId);
  return examSummary(db, sessionId);
}

export function examSummary(db, sessionId) {
  const s = getExamSession(db, sessionId);
  if (!s) return null;
  const qs = listExamQuestions(db, sessionId);
  const answered = qs.filter((q) => q.chosenIndex !== null);
  return {
    sessionId,
    status: s.status,
    createdAt: s.created_at,
    finishedAt: s.finished_at,
    scope: (() => {
      try {
        return JSON.parse(s.scope || "{}");
      } catch {
        return {};
      }
    })(),
    total: qs.length,
    answered: answered.length,
    correct: answered.filter((q) => q.isCorrect).length,
    accuracy: answered.length ? Math.round((answered.filter((q) => q.isCorrect).length / answered.length) * 100) : 0,
    recheckCount: qs.filter((q) => q.isRecheck).length,
    wrong: answered
      .filter((q) => !q.isCorrect)
      .map((q) => ({ seq: q.seq, word: q.word, chose: q.options[q.chosenIndex], right: q.correctMeaning, streak: 0 })),
    masteredNow: qs.filter((q) => q.isCorrect).map((q) => q.word),
  };
}

/** 每题答案位置分布(自检"ABCD 是否错开"用) */
export function answerPositionSpread(db, sessionId) {
  const qs = listExamQuestions(db, sessionId);
  const spread = [0, 0, 0, 0];
  for (const q of qs) spread[q.answerIndex] = (spread[q.answerIndex] || 0) + 1;
  return { total: qs.length, spread };
}
