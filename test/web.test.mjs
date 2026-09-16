import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildLibraryPayload, buildLibraryPageHtml, registerWebUi, resolveScope, WEB_PATH, GROUP_LABELS } from "../web.mjs";
import { openDb, closeDb, ensureUser, recordEntries, queryWords, stats, cardStats, upsertCard, createExamSession, addExamQuestion, answerExamQuestion } from "../db.mjs";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "wv-web-"));
  const db = openDb(join(dir, "words.db"));
  const u = ensureUser(db, "用户1");
  // kind 记两次(高频)、plant 两次(高频)、map 一次(已记住) -> 覆盖三组
  recordEntries(db, {
    userId: u.id,
    entries: [{ term: "kinds", lemma: "kind" }, { term: "plants", lemma: "plant" }],
    kind: "hotkey",
    via: "clipboard",
    context: "Animals and plants have different kinds.",
  });
  recordEntries(db, { userId: u.id, entries: [{ term: "map", lemma: "map" }], kind: "hotkey", via: "manual", context: "This is a map." });
  // 再来一批:kind 与 plant 各 +1(都成高频),river 只出现一次
  recordEntries(db, {
    userId: u.id,
    entries: [{ term: "kinds", lemma: "kind" }, { term: "plants", lemma: "plant" }, { term: "river", lemma: "river" }],
    kind: "hotkey",
    via: "manual",
    context: "kinds plants river",
  });
  db.prepare("UPDATE words SET status = 'mastered', streak = 3 WHERE lemma = 'map'").run();
  return { dir, db, userId: u.id };
}

const payload = (s, extra = {}) =>
  buildLibraryPayload({
    db: s.db, queryWords, stats, cardStats, userId: s.userId, userName: "用户1", highFreqMin: 2, ...extra,
  });

test("分组计数:全部/已记住/没记住/高频易错", () => {
  const s = setup();
  try {
    const p = payload(s);
    assert.equal(p.total, 4, JSON.stringify(p.rows.map((r) => r.word)));
    assert.equal(p.groups.all, 4);
    assert.equal(p.groups.mastered, 1, "map 已记住");
    assert.equal(p.groups.learning, 3);
    // 高频 = 标记 ≥2 次:kind(2)、plant(2);其中未学会的才算高频易错
    assert.equal(p.groups.hot, 2);
    assert.deepEqual(
      p.rows.filter((r) => r.highFreq).map((r) => r.word).sort(),
      ["kind", "plant"],
    );
    assert.equal(p.rows.find((r) => r.word === "map").highFreq, false);
    assert.equal(p.highFreqMin, 2);
    assert.ok(p.generatedAt);
    assert.ok(GROUP_LABELS.hot.includes("高频"));
  } finally {
    closeDb(s.db);
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("高频词计数按全库统计:切到任一分组都不变", () => {
  const s = setup();
  try {
    const all = payload(s);
    assert.equal(all.groups.highFreq, 2, "全库高频词 2 个");
    assert.equal(all.groups.hot, 2);
    // 切到"已记住"(只有 map,不是高频)后,高频词计数仍应是全库的 2
    const mastered = payload(s, { group: "mastered" });
    assert.equal(mastered.rows.length, 1);
    assert.equal(mastered.groups.highFreq, 2);
    assert.equal(mastered.groups.all, 4);
    // 搜索过滤也不影响这些计数
    const searched = payload(s, { q: "river" });
    assert.equal(searched.rows.length, 1);
    assert.equal(searched.groups.highFreq, 2);
  } finally {
    closeDb(s.db);
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("三组视图的筛选结果正确", () => {
  const s = setup();
  try {
    assert.deepEqual(payload(s, { group: "mastered" }).rows.map((r) => r.word), ["map"]);
    assert.deepEqual(payload(s, { group: "learning" }).rows.map((r) => r.word).sort(), ["kind", "plant", "river"]);
    assert.deepEqual(payload(s, { group: "hot" }).rows.map((r) => r.word).sort(), ["kind", "plant"]);
    assert.equal(payload(s, { group: "hot" }).groupLabel, GROUP_LABELS.hot);
    assert.equal(payload(s, { group: "nonsense" }).groupLabel, GROUP_LABELS.all);
  } finally {
    closeDb(s.db);
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("排序:默认按标记次数降序,也支持字母/时间", () => {
  const s = setup();
  try {
    const byCount = payload(s).rows.map((r) => `${r.word}:${r.seenCount}`);
    assert.deepEqual(byCount, ["kind:2", "plant:2", "map:1", "river:1"]);
    const byAlpha = payload(s, { sort: "alpha" }).rows.map((r) => r.word);
    assert.deepEqual(byAlpha, ["kind", "map", "plant", "river"]);
    assert.equal(payload(s, { sort: "alpha" }).sortLabel, "字母序");
  } finally {
    closeDb(s.db);
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("搜索:单词/词性/释义都能命中(大小写不敏感)", () => {
  const s = setup();
  try {
    assert.deepEqual(payload(s, { q: "KIND" }).rows.map((r) => r.word), ["kind"]);
    assert.equal(payload(s, { q: "river" }).rows.length, 1);
    assert.equal(payload(s, { q: "不存在的词" }).rows.length, 0);
    // 释义命中(测试里没插词典,这里插一条再搜)
    const s2 = setup();
    try {
      s2.db.prepare("INSERT INTO dict(term,kind,phonetic,pos,meaning,source,created_at,updated_at) VALUES('map','word','/mæp/','n.','地图','test','x','x')").run();
      assert.equal(payload(s2, { q: "地图" }).rows.length, 1);
    } finally {
      closeDb(s2.db);
      rmSync(s2.dir, { recursive: true, force: true });
    }
  } finally {
    closeDb(s.db);
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("来源列:带出最近一次录入的 via 与原文片段", () => {
  const s = setup();
  try {
    const kind = payload(s).rows.find((r) => r.word === "kind");
    assert.equal(kind.via, "manual", "应取最近一次(via=manual)");
    assert.match(kind.context, /kinds plants river/);
    const map = payload(s).rows.find((r) => r.word === "map");
    assert.equal(map.via, "manual");
    assert.match(map.context, /This is a map/);
    assert.equal(kind.statusLabel, "没记住");
    assert.equal(map.statusLabel, "已记住");
  } finally {
    closeDb(s.db);
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("总览页脚本语法自检:页面里的 JS 必须能被解析(防大括号/引号写坏)", () => {
  const html = buildLibraryPageHtml({ userName: "用户1", highFreqMin: 2 });
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(m, "页面里应有内联脚本");
  const script = m[1];
  assert.doesNotThrow(() => new Function(script), "页面脚本语法错误");
  for (const fn of ["function renderRows", "function startEdit", "async function doDelete", "async function doAction", "async function markSelected", "async function load"]) {
    assert.ok(script.includes(fn), `页面脚本缺少 ${fn}`);
  }
  const open = (script.match(/{/g) || []).length;
  const close = (script.match(/}/g) || []).length;
  assert.equal(open, close, `大括号不配平:${open} vs ${close}`);
});

test("resolveScope:页面筛选 → 查询范围的映射", () => {
  assert.deepEqual(resolveScope({ group: "all", limit: 8 }), { orderBy: "count", words: undefined, limit: 8 });
  assert.equal(resolveScope({ group: "mastered" }).status, "mastered");
  assert.equal(resolveScope({ group: "learning" }).status, "learning");
  const hot = resolveScope({ group: "hot", highFreqMin: 3 });
  assert.equal(hot.status, "learning");
  assert.equal(hot.minCount, 3, "高频易错 = 未学会 且 次数≥阈值");
  assert.equal(resolveScope({ q: " kinds ", limit: 5 }).words, "kinds");
  assert.equal(resolveScope({ limit: 9999 }).limit, 200, "上限夹住");
  assert.equal(resolveScope({ limit: 0 }).limit, 8, "缺省 8");
  assert.equal(resolveScope({ sort: "alpha" }).orderBy, "alpha");
});

test("总览页 HTML:自包含、指向同源 API、含四个分组", () => {
  const html = buildLibraryPageHtml({ userName: "用户1", highFreqMin: 2 });
  assert.match(html, /英语生词库/);
  // 页面把路由前缀与子路径拼接(JSON.stringify(WEB_PATH) + '/api/library'),所以分段断言
  assert.ok(html.includes(WEB_PATH), "应包含路由前缀");
  assert.ok(html.includes("/api/library"), "应包含 API 子路径");
  for (const label of Object.values(GROUP_LABELS)) assert.ok(html.includes(label), `页面缺少分组 ${label}`);
  assert.ok(!/src="http/.test(html), "不应引用外部资源");
  assert.match(html, /标记次数/);
});

test("registerWebUi:有 webServer 时注册路由并可通过 HTTP 取到数据", async () => {
  const s = setup();
  // 用一个最小假 webServer 收集路由,再用真 http server 跑它 —— 复用宿主同款 (req,res) 签名
  let route = null;
  const effects = [];
  const ctx = {
    logger: { info() {}, warn() {} },
    effect(fn) {
      effects.push(fn());
      return () => {};
    },
    inject(names, cb) {
      assert.deepEqual(names, ["webServer"]);
      cb({ webServer: { register: (r) => { route = r; return () => { route = null; }; } } });
    },
  };
  try {
    const ok = registerWebUi(ctx, { db: s.db, queryWords, stats, cardStats, liveConfig: { defaultUser: "用户1", highFreqMin: 2 }, logger: ctx.logger });
    assert.equal(ok, true);
    assert.ok(route, "应注册路由");
    assert.equal(route.kind, "prefix");
    assert.equal(route.path, WEB_PATH);
    assert.equal(effects.length, 1, "应挂一个 effect(注册即 effect)");

    const srv = createServer((req, res) => route.handler(req, res));
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const port = srv.address().port;
    try {
      const page = await fetch(`http://127.0.0.1:${port}${WEB_PATH}`).then((r) => r.text());
      assert.match(page, /英语生词库/);

      const data = await fetch(`http://127.0.0.1:${port}${WEB_PATH}/api/library?group=hot`).then((r) => r.json());
      assert.equal(data.groups.hot, 2);
      assert.deepEqual(data.rows.map((r) => r.word).sort(), ["kind", "plant"]);
      assert.equal(data.user, "用户1");

      const missing = await fetch(`http://127.0.0.1:${port}${WEB_PATH}/api/nope`).then((r) => r.status);
      assert.equal(missing, 404);
      // 写操作必须带 JSON Content-Type(挡简单表单式跨站提交)
      const badType = await fetch(`http://127.0.0.1:${port}${WEB_PATH}/api/word/mastery`, { method: "POST", body: "x=1" }).then((r) => r.status);
      assert.equal(badType, 415);
      const badMethod = await fetch(`http://127.0.0.1:${port}${WEB_PATH}/api/library`, { method: "PUT" }).then((r) => r.status);
      assert.equal(badMethod, 405);
      const badUser = await fetch(`http://127.0.0.1:${port}${WEB_PATH}/api/library?user=不存在`).then((r) => r.status);
      assert.equal(badUser, 404);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  } finally {
    closeDb(s.db);
    rmSync(s.dir, { recursive: true, force: true });
  }
});

/** 把词库路由挂到一个真实 http 服务上(与宿主同款 (req,res) 签名) */
async function mountRoute(db, actions = {}) {
  let route = null;
  const ctx = {
    logger: { info() {}, warn() {} },
    effect() {
      return () => {};
    },
    inject(names, cb) {
      cb({ webServer: { register: (r) => { route = r; return () => {}; } } });
    },
  };
  registerWebUi(ctx, { db, queryWords, stats, cardStats, liveConfig: { defaultUser: "用户1", highFreqMin: 2, exam: { count: 4 } }, logger: ctx.logger, actions });
  assert.ok(route, "路由应已注册");
  const srv = createServer((req, res) => route.handler(req, res));
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  const base = `http://127.0.0.1:${port}${WEB_PATH}`;
  const post = async (path, body) => {
    const res = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  };
  return { base, post, close: () => new Promise((r) => srv.close(r)) };
}

test("写操作:改释义 / 手动掌握度 / 删除预览 / 删除(连带清理,外键回归)", async () => {
  const s = setup();
  const word = s.db.prepare("SELECT * FROM words WHERE lemma = 'plant'").get();
  // 给这个词造卡片 + 考试记录:老 deleteWord 在这种词上会 FOREIGN KEY 报错
  upsertCard(s.db, { userId: s.userId, wordId: word.id, term: "plant", segs: [{ en: "plant", cn: "普兰" }], story: "s" });
  const sess = createExamSession(s.db, { userId: s.userId, scope: {}, count: 1 });
  addExamQuestion(s.db, { sessionId: sess.id, seq: 1, wordId: word.id, promptWord: "plant", sentence: "A plant.", correctMeaning: "植物", options: ["植物", "x", "y", "z"], answerIndex: 0 });
  answerExamQuestion(s.db, { sessionId: sess.id, seq: 1, chosenIndex: 0 });

  const r = await mountRoute(s.db);
  try {
    // 改释义
    const up = await r.post("/api/word/update", { word: "plant", meaning: "植物；种植", pos: "n.", phonetic: "/plɑːnt/" });
    assert.equal(up.status, 200, JSON.stringify(up.data));
    assert.equal(s.db.prepare("SELECT meaning FROM dict WHERE term='plant'").get().meaning, "植物；种植");
    assert.equal(s.db.prepare("SELECT source FROM dict WHERE term='plant'").get().source, "manual");
    assert.equal((await r.post("/api/word/update", { word: "nosuchword", meaning: "x" })).status, 404);
    assert.equal((await r.post("/api/word/update", { meaning: "x" })).status, 400);

    // 手动掌握度
    assert.equal((await r.post("/api/word/mastery", { word: "plant", mastered: true })).status, 200);
    assert.equal(s.db.prepare("SELECT status FROM words WHERE lemma='plant'").get().status, "mastered");
    assert.equal((await r.post("/api/word/mastery", { word: "plant", mastered: false })).status, 200);
    assert.equal(s.db.prepare("SELECT status FROM words WHERE lemma='plant'").get().status, "learning");
    assert.equal((await r.post("/api/word/mastery", { word: "nosuchword", mastered: true })).status, 404);

    // 删除预览:必须列出连带影响
    const pv = await r.post("/api/words/delete-preview", { words: ["plant", "nosuchword"] });
    assert.equal(pv.status, 200);
    const hit = pv.data.impact.find((x) => x.lemma === "plant");
    assert.equal(hit.found, true);
    assert.equal(hit.cards, 1);
    assert.equal(hit.examQuestions, 1);
    assert.equal(hit.examAnswers, 1);
    assert.ok(hit.events >= 2, "plant 录过两次");
    assert.equal(pv.data.impact.find((x) => x.lemma === "nosuchword").found, false);

    // 删除:连带清理,且不报外键错
    const del = await r.post("/api/words/delete", { words: ["plant"] });
    assert.equal(del.status, 200, JSON.stringify(del.data));
    assert.equal(del.data.deleted.length, 1);
    assert.equal(del.data.removed.cards, 1);
    assert.equal(del.data.removed.examQuestions, 1);
    assert.equal(del.data.removed.examAnswers, 1);
    assert.equal(s.db.prepare("SELECT COUNT(*) n FROM words WHERE lemma='plant'").get().n, 0);
    assert.equal(s.db.prepare("SELECT COUNT(*) n FROM cards WHERE word_id=?").get(word.id).n, 0);
    assert.equal(s.db.prepare("SELECT COUNT(*) n FROM exam_questions WHERE word_id=?").get(word.id).n, 0);
    assert.equal(s.db.prepare("SELECT COUNT(*) n FROM exam_answers WHERE word_id=?").get(word.id).n, 0);
    assert.equal((await r.post("/api/words/delete", { words: ["nosuchword"] })).status, 404);
  } finally {
    await r.close();
    closeDb(s.db);
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("动作:出卡/出卷走注入的实现,按分组与搜索解析范围", async () => {
  const s = setup();
  const seen = [];
  const actions = {
    cards: async (req) => {
      seen.push({ kind: "cards", ...req });
      return { ok: true, cards: 2, files: { html: "X:/a.html", pdf: "X:/a.pdf" } };
    },
    exam: async (req) => {
      seen.push({ kind: "exam", ...req });
      return { ok: true, questions: 4, url: "http://127.0.0.1:1/e/tok", files: { paperPdf: "X:/p.pdf" } };
    },
  };
  const r = await mountRoute(s.db, actions);
  try {
    const c = await r.post("/api/actions/cards", { group: "hot", q: "", sort: "count", limit: 5 });
    assert.equal(c.status, 200);
    assert.equal(c.data.cards, 2);
    assert.equal(seen[0].kind, "cards");
    assert.equal(seen[0].status, "learning", "高频易错 = 未学会");
    assert.equal(seen[0].minCount, 2);
    assert.equal(seen[0].limit, 5);

    const e = await r.post("/api/actions/exam", { group: "all", q: "kind", count: 3, mode: "answer" });
    assert.equal(e.status, 200);
    assert.match(e.data.url, /^http:/);
    assert.equal(seen[1].kind, "exam");
    assert.equal(seen[1].mode, "answer");
    assert.equal(seen[1].words, "kind", "搜索词按指定词处理");
    assert.equal(seen[1].limit, 3);
  } finally {
    await r.close();
    closeDb(s.db);
    rmSync(s.dir, { recursive: true, force: true });
  }

  // 没注入实现时给出可读的 501
  const s2 = setup();
  const r2 = await mountRoute(s2.db, {});
  try {
    const res = await r2.post("/api/actions/cards", { group: "all" });
    assert.equal(res.status, 501);
    assert.match(res.data.error, /不支持出卡/);
  } finally {
    await r2.close();
    closeDb(s2.db);
    rmSync(s2.dir, { recursive: true, force: true });
  }
});

test("registerWebUi:没有 webServer 服务时静默跳过(不影响 headless)", () => {
  const s = setup();
  try {
    let called = false;
    const ctx = {
      logger: { info() {}, warn() {} },
      effect() {
        return () => {};
      },
      inject() {
        called = true; // 服务不存在 -> 回调不会被调用
      },
    };
    const ok = registerWebUi(ctx, { db: s.db, queryWords, stats, cardStats, liveConfig: { defaultUser: "用户1", highFreqMin: 2 }, logger: ctx.logger });
    assert.equal(ok, false);
    assert.equal(called, true, "应尝试注入 webServer");
  } finally {
    closeDb(s.db);
    rmSync(s.dir, { recursive: true, force: true });
  }
});
