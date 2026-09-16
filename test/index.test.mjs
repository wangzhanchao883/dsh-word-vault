import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { apply, name as pluginName, inject as pluginInject } from "../index.mjs";

/** 最小假 DSH 运行时:只为验证契约(工具注册/设置命名空间/effect 生命周期) */
function fakeRuntime() {
  const tools = new Map();
  const effects = [];
  const settingsNamespaces = [];
  const logger = { info() {}, warn() {}, error() {}, debug() {} };
  const ctx = {
    logger,
    effect(fn) {
      const disposer = fn();
      effects.push(disposer);
      return () => {};
    },
    inject(names, cb) {
      cb(ctx);
    },
    get(key) {
      return key === "llm" ? undefined : undefined;
    },
    tools: {
      register(tool) {
        tools.set(tool.name, tool);
        return () => {};
      },
    },
    settings: {
      register(ns, schema, opts) {
        settingsNamespaces.push({ ns, schema, opts });
        return { get: () => null, watch: () => {} };
      },
    },
  };
  return { ctx, tools, effects, settingsNamespaces, logger };
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), "wordvault-idx-"));
}

/** 清理:必须先 dispose 插件(关库),再删目录;清理自身失败不能掩盖真正的断言错误 */
function cleanup(dir, disposers) {
  for (const d of disposers) {
    try {
      if (typeof d === "function") d();
    } catch {
      /* 已释放 */
    }
  }
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 120 });
  } catch (err) {
    console.warn(`[cleanup] 临时目录未删除 ${dir}: ${err.code}`);
  }
}

test("插件契约:name/inject/apply 齐全", () => {
  assert.equal(pluginName, "dsh-word-vault");
  assert.deepEqual(pluginInject, ["tools"]);
  assert.equal(typeof apply, "function");
});

test("注册 5 个工具 + 设置命名空间 + effect 生命周期", () => {
  const dir = tempDir();
  const rt = fakeRuntime();
  try {
    apply(rt.ctx, { dbPath: join(dir, "words.db"), helper: { enabled: false } });
    assert.deepEqual([...rt.tools.keys()].sort(), [
      "wordvault_add",
      "wordvault_capture_clipboard",
      "wordvault_fix_last",
      "wordvault_query",
      "wordvault_status",
    ]);
    assert.equal(rt.settingsNamespaces.length, 1);
    assert.equal(rt.settingsNamespaces[0].ns, "dsh-word-vault");
    assert.equal(rt.effects.length, 1);
    assert.equal(typeof rt.effects[0], "function");
    // 卸载 disposer 不应抛错
    rt.effects[0]();
  } finally {
    cleanup(dir, rt.effects);
  }
});

test("工具链路:add → query → status → fix_last(undo)", async () => {
  const dir = tempDir();
  const rt = fakeRuntime();
  try {
    apply(rt.ctx, {
      dbPath: join(dir, "words.db"),
      helper: { enabled: false },
      autoTranslate: false,
      users: [{ name: "用户1" }, { name: "用户2" }],
      defaultUser: "用户1",
    });
    const exec = { signal: undefined };

    const added = JSON.parse(await rt.tools.get("wordvault_add").execute({ text: "Animals and plants share the world with us." }, exec));
    assert.equal(added.ok, true);
    assert.equal(added.user, "用户1");
    assert.equal(added.added, 4);
    assert.deepEqual(added.lemmas.sort(), ["animal", "plant", "share", "world"]);

    const q = JSON.parse(await rt.tools.get("wordvault_query").execute({ user: "用户1", orderBy: "alpha" }, exec));
    assert.equal(q.count, 4);
    assert.deepEqual(q.words.map((w) => w.word), ["animal", "plant", "share", "world"]);

    const st = JSON.parse(await rt.tools.get("wordvault_status").execute({ user: "用户1" }, exec));
    assert.equal(st.stats.total, 4);
    assert.equal(st.stats.mastered, 0);
    assert.equal(st.helper.ready, false);
    assert.match(st.helper.note, /关闭/);

    // 重复录入 → 次数累加
    const again = JSON.parse(await rt.tools.get("wordvault_add").execute({ text: "plants", user: "用户1" }, exec));
    assert.equal(again.repeated, 1);
    const q2 = JSON.parse(await rt.tools.get("wordvault_query").execute({ user: "用户1", minCount: 2 }, exec));
    // 第二次录的是 plants,但计数归到词元 plant 上
    assert.deepEqual(q2.words.map((w) => w.word), ["plant"]);

    // 撤销最近一次(plants)
    const undone = JSON.parse(await rt.tools.get("wordvault_fix_last").execute({ action: "undo" }, exec));
    assert.equal(undone.ok, true);
    const q3 = JSON.parse(await rt.tools.get("wordvault_query").execute({ user: "用户1", minCount: 2 }, exec));
    assert.equal(q3.count, 0);

    // 改库
    const add2 = JSON.parse(await rt.tools.get("wordvault_add").execute({ text: "map", user: "用户1" }, exec));
    const moved = JSON.parse(await rt.tools.get("wordvault_fix_last").execute({ action: "reassign", user: "用户2", captureId: add2.captureId }, exec));
    assert.equal(moved.ok, true);
    const inU2 = JSON.parse(await rt.tools.get("wordvault_query").execute({ user: "用户2" }, exec));
    assert.deepEqual(inU2.words.map((w) => w.word), ["map"]);
    const inU1 = JSON.parse(await rt.tools.get("wordvault_query").execute({ user: "用户1", orderBy: "alpha" }, exec));
    assert.deepEqual(inU1.words.map((w) => w.word), ["animal", "plant", "share", "world"]);
  } finally {
    cleanup(dir, rt.effects);
  }
});

test("助手关闭时 capture_clipboard 给出可操作的失败说明", async () => {
  const dir = tempDir();
  const rt = fakeRuntime();
  try {
    apply(rt.ctx, { dbPath: join(dir, "words.db"), helper: { enabled: false } });
    const msg = await rt.tools.get("wordvault_capture_clipboard").execute({}, {});
    assert.match(msg, /剪贴板助手未启用/);
    assert.match(msg, /wordvault_add/);
  } finally {
    cleanup(dir, rt.effects);
  }
});

test("空输入与停用态给出明确提示", async () => {
  const dir = tempDir();
  const rt = fakeRuntime();
  try {
    apply(rt.ctx, { dbPath: join(dir, "words.db"), helper: { enabled: false } });
    const empty = await rt.tools.get("wordvault_add").execute({ text: "   " }, {});
    assert.match(empty, /缺少 text/);

    const dir2 = tempDir();
    const rt2 = fakeRuntime();
    try {
      apply(rt2.ctx, { dbPath: join(dir2, "words.db"), enabled: false, helper: { enabled: false } });
      const off = await rt2.tools.get("wordvault_add").execute({ text: "map" }, {});
      assert.match(off, /已停用/);
    } finally {
      cleanup(dir2, rt2.effects);
    }
  } finally {
    cleanup(dir, rt.effects);
  }
});
