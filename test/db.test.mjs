import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, closeDb, ensureUser, listUsers, findUser, upsertDict, getDict, recordEntries, queryWords, stats, setStatus, deleteWord, rebuildCounters, getCapture, listCaptures, undoCapture, reassignCapture, upsertCard, getCard } from "../db.mjs";

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), "wordvault-"));
  return { dir, path: join(dir, "words.db") };
}

test("建库/建用户幂等", () => {
  const { dir, path } = tempDb();
  const db = openDb(path);
  try {
    const u1 = ensureUser(db, "用户1", "dbl:ctrl");
    const u1again = ensureUser(db, "用户1", "dbl:ctrl");
    assert.equal(u1.id, u1again.id);
    ensureUser(db, "用户2", "key:f9");
    assert.equal(listUsers(db).length, 2);
    assert.equal(findUser(db, "用户2").hotkey, "key:f9");
    assert.equal(findUser(db, 1).name, "用户1");
  } finally {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("录入:新词计数 1,重复录入累加,同一批内去重", () => {
  const { dir, path } = tempDb();
  const db = openDb(path);
  try {
    const u = ensureUser(db, "用户1", "dbl:ctrl");
    const first = recordEntries(db, {
      userId: u.id,
      kind: "hotkey",
      via: "dblctrl",
      context: "Animals and plants share the world with us.",
      entries: [
        { term: "plants", lemma: "plant" },
        { term: "world", lemma: "world" },
      ],
    });
    assert.deepEqual(first.items.map((i) => i.status), ["new", "new"]);
    assert.equal(first.items[0].seenCount, 1);

    const second = recordEntries(db, {
      userId: u.id,
      kind: "hotkey",
      via: "f9",
      entries: [{ term: "plant", lemma: "plant" }],
    });
    assert.equal(second.items[0].status, "repeat");
    assert.equal(second.items[0].seenCount, 2);

    const rows = queryWords(db, { userId: u.id, orderBy: "count" });
    assert.equal(rows.length, 2);
    assert.equal(rows[0].lemma, "plant");
    assert.equal(rows[0].seen_count, 2);
    assert.equal(rows[0].term, "plant");
  } finally {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("词组与单词分开计数(kind 维度)", () => {
  const { dir, path } = tempDb();
  const db = openDb(path);
  try {
    const u = ensureUser(db, "用户1");
    recordEntries(db, { userId: u.id, entries: [{ term: "nice to meet you", lemma: "nice to meet you", kind: "phrase" }] });
    recordEntries(db, { userId: u.id, entries: [{ term: "nice", lemma: "nice" }] });
    const words = queryWords(db, { userId: u.id, kind: "word" });
    const phrases = queryWords(db, { userId: u.id, kind: "phrase" });
    assert.equal(words.length, 1);
    assert.equal(phrases.length, 1);
    assert.equal(stats(db, u.id).phrases, 1);
  } finally {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("词典缓存:已有释义不被空值覆盖,force 可覆盖", () => {
  const { dir, path } = tempDb();
  const db = openDb(path);
  try {
    upsertDict(db, [{ term: "plant", kind: "word", phonetic: "/plɑːnt/", pos: "n.", meaning: "植物", source: "llm" }]);
    upsertDict(db, [{ term: "plant", meaning: "", phonetic: "" }]);
    let d = getDict(db, ["plant"]).get("plant");
    assert.equal(d.meaning, "植物");
    assert.equal(d.phonetic, "/plɑːnt/");
    upsertDict(db, [{ term: "plant", meaning: "工厂" }], { force: true });
    d = getDict(db, ["plant"]).get("plant");
    assert.equal(d.meaning, "工厂");
  } finally {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("维度筛选:时间区间 / 次数区间 / 学会状态", () => {
  const { dir, path } = tempDb();
  const db = openDb(path);
  try {
    const u = ensureUser(db, "用户1");
    recordEntries(db, { userId: u.id, entries: [{ term: "map", lemma: "map" }, { term: "bird", lemma: "bird" }] });
    recordEntries(db, { userId: u.id, entries: [{ term: "map", lemma: "map" }] });
    recordEntries(db, { userId: u.id, entries: [{ term: "map", lemma: "map" }] });

    assert.equal(queryWords(db, { userId: u.id, minCount: 2 }).length, 1);
    assert.equal(queryWords(db, { userId: u.id, maxCount: 1 }).length, 1);
    assert.equal(queryWords(db, { userId: u.id, since: "2000-01-01" }).length, 2);
    assert.equal(queryWords(db, { userId: u.id, since: "2999-01-01" }).length, 0);

    setStatus(db, u.id, "map", "mastered");
    assert.equal(queryWords(db, { userId: u.id, status: "mastered" }).length, 1);
    assert.equal(stats(db, u.id).mastered, 1);
    setStatus(db, u.id, "map", "learning");
    assert.equal(stats(db, u.id).mastered, 0);
  } finally {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("删词连带清 event", () => {
  const { dir, path } = tempDb();
  const db = openDb(path);
  try {
    const u = ensureUser(db, "用户1");
    recordEntries(db, { userId: u.id, entries: [{ term: "yard", lemma: "yard" }] });
    assert.equal(stats(db, u.id).events, 1);
    const r = deleteWord(db, u.id, "yard");
    assert.equal(r.ok, true);
    assert.equal(queryWords(db, { userId: u.id }).length, 0);
    assert.equal(stats(db, u.id).events, 0);
  } finally {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("counters 可由 events 重建", () => {
  const { dir, path } = tempDb();
  const db = openDb(path);
  try {
    const u = ensureUser(db, "用户1");
    recordEntries(db, { userId: u.id, entries: [{ term: "share", lemma: "share" }] });
    recordEntries(db, { userId: u.id, entries: [{ term: "share", lemma: "share" }] });
    db.prepare("UPDATE words SET seen_count = 99 WHERE user_id = ?").run(u.id);
    const r = rebuildCounters(db, u.id);
    assert.equal(r.updated, 1);
    assert.equal(queryWords(db, { userId: u.id })[0].seen_count, 2);
  } finally {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("每次录入生成一条 capture 记录", () => {
  const { dir, path } = tempDb();
  const db = openDb(path);
  try {
    const u = ensureUser(db, "用户1");
    const r = recordEntries(db, {
      userId: u.id,
      via: "clipboard",
      context: "Animals and plants share the world with us.",
      entries: [{ term: "plant", lemma: "plant" }, { term: "world", lemma: "world" }],
    });
    const cap = getCapture(db, r.captureId);
    assert.equal(cap.user_id, u.id);
    assert.equal(cap.item_count, 2);
    assert.equal(cap.status, "active");
    assert.match(cap.text, /Animals and plants/);
    assert.equal(listCaptures(db, u.id).length, 1);
  } finally {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("撤销:新建的词整条删除,老词计数回退", () => {
  const { dir, path } = tempDb();
  const db = openDb(path);
  try {
    const u = ensureUser(db, "用户1");
    // 第一次录入 plant(新建)
    const first = recordEntries(db, { userId: u.id, via: "clipboard", entries: [{ term: "plant", lemma: "plant" }] });
    // 第二次录入 plant(重复) + world(新建)
    const second = recordEntries(db, {
      userId: u.id,
      via: "clipboard",
      entries: [{ term: "plant", lemma: "plant" }, { term: "world", lemma: "world" }],
    });
    assert.equal(queryWords(db, { userId: u.id }).length, 2);

    const undo = undoCapture(db, second.captureId);
    assert.equal(undo.ok, true);
    assert.equal(undo.removedWords, 1);      // world 是这次新建的 -> 删除
    assert.equal(undo.adjustedWords, 1);     // plant 计数 2 -> 1
    const rows = queryWords(db, { userId: u.id });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].lemma, "plant");
    assert.equal(rows[0].seen_count, 1);
    assert.equal(stats(db, u.id).events, 1);

    // 撤销第一次 -> plant 也没了
    const undo2 = undoCapture(db, first.captureId);
    assert.equal(undo2.ok, true);
    assert.equal(undo2.removedWords, 1);
    assert.equal(queryWords(db, { userId: u.id }).length, 0);

    // 重复撤销被拒绝
    const undo3 = undoCapture(db, first.captureId);
    assert.equal(undo3.ok, false);
    assert.match(undo3.error, /undone/);
  } finally {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("改库:从用户1挪到用户2,原库清空、新库命中", () => {
  const { dir, path } = tempDb();
  const db = openDb(path);
  try {
    const u1 = ensureUser(db, "用户1");
    const u2 = ensureUser(db, "用户2");
    const r = recordEntries(db, {
      userId: u1.id,
      via: "clipboard",
      entries: [{ term: "map", lemma: "map" }, { term: "bird", lemma: "bird" }],
    });
    const moved = reassignCapture(db, r.captureId, u2.id);
    assert.equal(moved.ok, true);
    assert.equal(moved.moved, 2);
    assert.equal(queryWords(db, { userId: u1.id }).length, 0);
    const inU2 = queryWords(db, { userId: u2.id, orderBy: "alpha" });
    assert.deepEqual(inU2.map((w) => w.lemma), ["bird", "map"]);
    assert.equal(getCapture(db, r.captureId).status, "moved");
    // 同库改库被拒绝
    const same = reassignCapture(db, moved.newCaptureId, u2.id);
    assert.equal(same.ok, false);
  } finally {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("故事锁:重生成卡片时保留原 story,只更新事实字段;newStory 才换", () => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), "wv-lock-")), "w.db"));
  const u = ensureUser(db, "u1");
  recordEntries(db, { userId: u.id, entries: [{ term: "potato", lemma: "potato" }], kind: "hotkey", via: "clipboard", context: "potato" });
  const row = queryWords(db, { userId: u.id, limit: 5 })[0];
  upsertCard(db, { userId: u.id, wordId: row.id, term: "potato", phonetic: "/pəˈteɪtoʊ/", pos: "n.", meaning: "土豆", segs: [{ en: "po", cn: "破" }], story: "第一版故事" });
  // 重生成(默认):事实字段更新,故事保留
  const r2 = upsertCard(db, { userId: u.id, wordId: row.id, term: "potato", phonetic: "/pəˈteɪtoʊ/", pos: "n.", meaning: "马铃薯", segs: [{ en: "po", cn: "破" }, { en: "ta", cn: "塔" }], story: "第二版故事(不该出现)" });
  const got = getCard(db, u.id, row.id);
  assert.equal(got.story, "第一版故事", "默认必须保留原故事");
  assert.equal(r2.storyLocked, true);
  assert.equal(got.meaning, "马铃薯", "事实字段仍要更新");
  assert.match(got.segs, /ta/, "拆解块仍要更新");
  // 显式换梗
  upsertCard(db, { userId: u.id, wordId: row.id, term: "potato", meaning: "马铃薯", segs: [{ en: "po", cn: "破" }], story: "第三版故事", newStory: true });
  assert.equal(getCard(db, u.id, row.id).story, "第三版故事", "newStory 时应换");
  closeDb(db);
});
