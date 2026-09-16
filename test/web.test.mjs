import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildLibraryPayload, buildLibraryPageHtml, registerWebUi, WEB_PATH, GROUP_LABELS } from "../web.mjs";
import { openDb, closeDb, ensureUser, recordEntries, queryWords, stats, cardStats } from "../db.mjs";

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
      const badMethod = await fetch(`http://127.0.0.1:${port}${WEB_PATH}/api/library`, { method: "POST" }).then((r) => r.status);
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
