import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { openDb, closeDb, ensureUser, recordEntries, queryWords, stats, cardStats, renameUser, userOverview } from "../db.mjs";
import { registerWebUi, WEB_PATH } from "../web.mjs";

const here = dirname(fileURLToPath(import.meta.url));

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "wv-user-"));
  const db = openDb(join(dir, "words.db"));
  const a = ensureUser(db, "用户1");
  const b = ensureUser(db, "用户2");
  recordEntries(db, { userId: a.id, entries: [{ term: "map", lemma: "map" }, { term: "kinds", lemma: "kind" }], kind: "hotkey", via: "clipboard", context: "map kinds" });
  recordEntries(db, { userId: b.id, entries: [{ term: "river", lemma: "river" }], kind: "hotkey", via: "clipboard", context: "river" });
  return { dir, db, a, b };
}

test("改用户库名:词条跟着走,撞名/空名/超长被拒", () => {
  const s = setup();
  try {
    const before = stats(s.db, s.a.id);
    assert.equal(before.total, 2);

    const r = renameUser(s.db, { from: "用户1", to: "哥哥" });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.to, "哥哥");
    // 词条挂在 user_id 上,所以改名后词数不变
    const after = stats(s.db, s.a.id);
    assert.equal(after.total, 2);
    assert.deepEqual(queryWords(s.db, { userId: s.a.id, orderBy: "alpha" }).map((w) => w.lemma), ["kind", "map"]);
    assert.equal(s.db.prepare("SELECT name FROM users WHERE id = ?").get(s.a.id).name, "哥哥");

    // 撞名
    const clash = renameUser(s.db, { from: "用户2", to: "哥哥" });
    assert.equal(clash.ok, false);
    assert.match(clash.error, /已经有一个叫/);
    // 空名 / 超长 / 不存在
    assert.equal(renameUser(s.db, { from: "哥哥", to: "  " }).ok, false);
    assert.equal(renameUser(s.db, { from: "哥哥", to: "x".repeat(25) }).ok, false);
    assert.equal(renameUser(s.db, { from: "查无此人", to: "小明" }).ok, false);
    // 同名视为成功且不变
    const same = renameUser(s.db, { from: "哥哥", to: "哥哥" });
    assert.equal(same.ok, true);
    assert.equal(same.unchanged, true);
  } finally {
    closeDb(s.db);
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("用户库总览:带词数 / 事件数 / 已学会数", () => {
  const s = setup();
  try {
    const list = userOverview(s.db);
    assert.equal(list.length, 2);
    const one = list.find((u) => u.name === "用户1");
    assert.equal(one.words, 2);
    assert.equal(one.events, 2);
    assert.equal(one.mastered, 0);
    assert.equal(list.find((u) => u.name === "用户2").words, 1);
  } finally {
    closeDb(s.db);
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("改名片:经 HTTP 端到端,并同步设置里的用户列表与默认库", async () => {
  const s = setup();
  const calls = [];
  const written = [];
  let flat = { users: [{ name: "用户1", enabled: true }, { name: "用户2", enabled: true }], defaultUser: "用户1" };
  // 用真实 db 的改名 + 假 settings 写入,复刻 index.mjs 里 renameUser action 的语义
  const actions = {
    renameUser: async ({ from, to }) => {
      calls.push({ from, to });
      const r = renameUser(s.db, { from, to });
      if (!r.ok) return r;
      if (r.unchanged) return { ...r, users: userOverview(s.db) };
      const nextUsers = (flat.users || []).map((u) => (u.name === from ? { ...u, name: to } : u));
      const nextDefault = flat.defaultUser === from ? to : flat.defaultUser;
      written.push({ users: nextUsers, defaultUser: nextDefault });
      flat = { ...flat, users: nextUsers, defaultUser: nextDefault };
      return { ...r, users: userOverview(s.db), defaultUser: nextDefault };
    },
  };
  let route = null;
  const ctx = {
    logger: { info() {}, warn() {} },
    effect: () => () => {},
    inject: (names, cb) => cb({ webServer: { register: (r) => { route = r; return () => {}; } } }),
  };
  registerWebUi(ctx, {
    db: s.db, queryWords, stats, cardStats,
    liveConfig: { defaultUser: "用户1", highFreqMin: 2 },
    logger: ctx.logger,
    actions,
    getSettings: () => flat,
    writeSettings: async (patch) => { written.push(patch); flat = { ...flat, ...patch }; },
    userOverview: () => userOverview(s.db),
  });
  const srv = createServer((req, res) => route.handler(req, res));
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}${WEB_PATH}`;
  const post = async (p, body) => {
    const res = await fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  };
  try {
    // 设置接口带出用户总览
    const got = await (await fetch(base + "/api/settings")).json();
    assert.equal(got.users.length, 2);
    assert.ok(got.users.every((u) => typeof u.words === "number"));

    const r = await post("/api/users/rename", { from: "用户1", to: "妹妹" });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.to, "妹妹");
    assert.equal(r.data.defaultUser, "妹妹", "默认库应跟着改");
    assert.equal(s.db.prepare("SELECT name FROM users WHERE id = ?").get(s.a.id).name, "妹妹");
    assert.deepEqual(written[0].users.map((u) => u.name), ["妹妹", "用户2"]);
    assert.equal(r.data.users.find((u) => u.name === "妹妹").words, 2);

    // 撞名 -> 400
    const clash = await post("/api/users/rename", { from: "用户2", to: "妹妹" });
    assert.equal(clash.status, 400);
    assert.match(clash.data.error, /已经有一个叫/);

    // 设置页有改名牌
    const page = await (await fetch(base + "/settings")).text();
    assert.match(page, /用户库改名/);
    assert.match(page, /data-do-rename/);
    assert.match(page, /\/api\/users\/rename/);
  } finally {
    await new Promise((r) => srv.close(r));
    closeDb(s.db);
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("原生设置面板:有用户库改名分组,并调用同一个宿主路由", () => {
  const src = readFileSync(join(here, "..", "client.js"), "utf8");
  assert.ok(src.includes("function RenameRow"), "应有改名行组件");
  assert.ok(src.includes("gUsers"), "应有用户库分组标题");
  assert.ok(src.includes("/api/users/rename"), "改名应走宿主路由(库名与设置一起改)");
  assert.ok(src.includes("v.users"), "应渲染设置里的用户列表");
  assert.ok(src.includes("wv-btn"), "应有改名按钮样式");
});
