import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { apply, name as pluginName, inject as pluginInject } from "../index.mjs";

/** 最小假 DSH 运行时:只为验证契约(工具注册/设置命名空间/effect 生命周期) */
function fakeRuntime({ llm } = {}) {
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
      return key === "llm" ? llm : undefined;
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

test("注册 11 个工具 + 设置命名空间 + effect 生命周期", () => {
  const dir = tempDir();
  const rt = fakeRuntime();
  try {
    apply(rt.ctx, { dbPath: join(dir, "words.db"), helper: { enabled: false } });
    assert.deepEqual([...rt.tools.keys()].sort(), [
      "wordvault_add",
      "wordvault_capture_clipboard",
      "wordvault_exam_answer",
      "wordvault_exam_paper",
      "wordvault_exam_result",
      "wordvault_exam_start",
      "wordvault_export_cards",
      "wordvault_fix_last",
      "wordvault_make_cards",
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

// ---------------------------------------------------------------- P2 工具链路

/** 假 LLM:对提示词里出现的词逐个返回合格卡片(音节块拆解) */
function cardFakeLlm(segMap) {
  // 注意:提示词是被 JSON.stringify 进消息里的,内层引号会变成 \" —— 直接 includes('"map"') 永远不中
  const hasWord = (prompt, w) => prompt.includes(`\\"${w}\\"`) || prompt.includes(`"${w}"`);
  return {
    stream(options) {
      const prompt = JSON.stringify(options.messages);
      const words = Object.keys(segMap).filter((w) => hasWord(prompt, w));
      const payload = JSON.stringify(
        words.map((w) => ({
          word: w,
          phonetic: `/${w}/`,
          pos: "n.",
          meaning: `${w}的释义`,
          segs: segMap[w],
          story: `${w} 的荒诞句`,
        })),
      );
      async function* gen() {
        yield { type: "text-delta", index: 0, text: payload };
        yield { type: "finish", reason: { kind: "stop" } };
      }
      return gen();
    },
  };
}

const SEGS = {
  map: [{ en: "ma", cn: "马" }, { en: "p", cn: "铺" }],
  plant: [{ en: "plan", cn: "普兰" }, { en: "t", cn: "特" }],
  tomato: [{ en: "to", cn: "特" }, { en: "ma", cn: "马" }, { en: "to", cn: "头" }],
};

test("P2 工具链路:make_cards 生成并入库 → export_cards 出 HTML", async () => {
  const dir = tempDir();
  const rt = fakeRuntime({ llm: cardFakeLlm(SEGS) });
  try {
    apply(rt.ctx, {
      dbPath: join(dir, "words.db"),
      helper: { enabled: false },
      autoTranslate: false,
      outputDir: join(dir, "out"),
      users: [{ name: "用户1" }],
    });
    const exec = {};
    await rt.tools.get("wordvault_add").execute({ text: "map tomato plant", user: "用户1" }, exec);

    const made = JSON.parse(await rt.tools.get("wordvault_make_cards").execute({ user: "用户1", limit: 8 }, exec));
    assert.equal(made.ok, true);
    assert.equal(made.generated, 3, JSON.stringify(made));
    assert.equal(made.failed.length, 0);
    assert.equal(made.cardStats.withCard, 3);

    // 再调一次:没缺的就不重复烧 token
    const again = JSON.parse(await rt.tools.get("wordvault_make_cards").execute({ user: "用户1" }, exec));
    assert.equal(again.generated, 0);
    assert.match(String(again.message), /都已经有了/);

    // 只重做某个词
    const one = JSON.parse(await rt.tools.get("wordvault_make_cards").execute({ user: "用户1", words: "tomato", regenerate: true }, exec));
    assert.equal(one.generated, 1);

    const exported = JSON.parse(await rt.tools.get("wordvault_export_cards").execute({ user: "用户1", format: "html", limit: 8 }, exec));
    assert.equal(exported.ok, true, JSON.stringify(exported));
    assert.equal(exported.cards, 3);
    assert.equal(exported.pages, 1);
    assert.ok(exported.files.html && exported.files.html.endsWith(".html"));
    assert.ok(existsSync(exported.files.html));
    assert.match(readFileSync(exported.files.html, "utf8"), /map/);
  } finally {
    cleanup(dir, rt.effects);
  }
});

test("P2 工具链路:无卡片时 export 自动补生成;生成失败给出可读结论", async () => {
  const dir = tempDir();
  const rt = fakeRuntime({ llm: cardFakeLlm(SEGS) });
  try {
    apply(rt.ctx, { dbPath: join(dir, "words.db"), helper: { enabled: false }, autoTranslate: false, outputDir: join(dir, "out") });
    const exec = {};
    await rt.tools.get("wordvault_add").execute({ text: "map", user: "用户1" }, exec);
    const r = JSON.parse(await rt.tools.get("wordvault_export_cards").execute({ user: "用户1", format: "html" }, exec));
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.generatedNow, 1, "缺卡时应先自动生成");
    assert.equal(r.cards, 1);
  } finally {
    cleanup(dir, rt.effects);
  }

  const dir2 = tempDir();
  const rt2 = fakeRuntime({ llm: null }); // ctx.llm 不可用
  try {
    apply(rt2.ctx, { dbPath: join(dir2, "words.db"), helper: { enabled: false }, autoTranslate: false, outputDir: join(dir2, "out") });
    const exec = {};
    await rt2.tools.get("wordvault_add").execute({ text: "map", user: "用户1" }, exec);
    const bad = JSON.parse(await rt2.tools.get("wordvault_export_cards").execute({ user: "用户1", format: "html" }, exec));
    assert.equal(bad.ok, false);
    assert.match(String(bad.message), /生成失败/);
  } finally {
    cleanup(dir2, rt2.effects);
  }
});

// ---------------------------------------------------------------- P3 考试工具链路

/** 假 LLM:翻译请求返回释义;出题请求返回"含该词的句子 + 三个干扰项" */
function examFakeLlm() {
  return {
    stream(options) {
      const prompt = JSON.stringify(options.messages);
      const isTranslate = prompt.includes("英语词典编辑");
      let payload;
      if (isTranslate) {
        // 翻译提示词里是纯词表(每行一个词),不是 JSON —— 按已知词表筛出本次要翻的词
        const known = ["meet", "share", "make", "plant", "tomato", "map", "world", "photo", "kind", "health", "potato"];
        const terms = known.filter((w) => prompt.includes(w));
        payload = JSON.stringify(terms.map((t) => ({ term: t, phonetic: `/${t}/`, pos: "v.", meaning: `${t}释义` })));
      } else {
        const words = [];
        const re = /\\"word\\":\\"([a-z]+)\\"/g;
        let m;
        while ((m = re.exec(prompt))) words.push(m[1]);
        payload = JSON.stringify(
          words.map((w) => ({ word: w, sentence: `We ${w} at school every day.`, distractors: [`${w}错一`, `${w}错二`, `${w}错三`], pos: "v." })),
        );
      }
      async function* gen() {
        yield { type: "text-delta", index: 0, text: payload };
        yield { type: "finish", reason: { kind: "stop" } };
      }
      return gen();
    },
  };
}

test("P3 工具链路:exam_start → 答题 → 结算 → 出卷", async () => {
  const dir = tempDir();
  const rt = fakeRuntime({ llm: examFakeLlm() });
  try {
    apply(rt.ctx, {
      dbPath: join(dir, "words.db"),
      helper: { enabled: false },
      autoTranslate: false,
      outputDir: join(dir, "out"),
      users: [{ name: "用户1" }],
      exam: { count: 4, batchSize: 4 },
    });
    const exec = {};
    await rt.tools.get("wordvault_add").execute({ text: "meet share make plant", user: "用户1" }, exec);

    const started = JSON.parse(await rt.tools.get("wordvault_exam_start").execute({ user: "用户1", count: 4, paper: true, seed: 11 }, exec));
    assert.equal(started.ok, true, JSON.stringify(started));
    assert.equal(started.questions, 4);
    assert.match(started.url, /^http:\/\/127\.0\.0\.1:\d+\/e\/[0-9a-f]+$/);
    assert.deepEqual(started.answerSpread, [1, 1, 1, 1], `答案位置应均衡,实际 ${started.answerSpread}`);
    assert.equal(started.recheck, 0);
    assert.ok(started.paper && started.paper.paperHtml && existsSync(started.paper.paperHtml));
    assert.ok(existsSync(started.paper.keyHtml));

    // 答题页能打开且不带答案
    const page = await fetch(started.url).then((r) => r.text());
    assert.match(page, /句中的/);
    assert.ok(!page.includes("answerIndex"));

    const sessionId = started.sessionId;
    for (let seq = 1; seq <= 4; seq++) {
      const r = JSON.parse(await rt.tools.get("wordvault_exam_answer").execute({ sessionId, seq, choice: "A" }, exec));
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(typeof r.isCorrect, "boolean");
      assert.ok(["A", "B", "C", "D"].includes(r.correctLetter));
    }

    const result = JSON.parse(await rt.tools.get("wordvault_exam_result").execute({ sessionId }, exec));
    assert.equal(result.total, 4);
    assert.equal(result.answered, 4);
    assert.ok(result.accuracy >= 0 && result.accuracy <= 100);
    assert.equal(result.answerSpread.reduce((a, b) => a + b, 0), 4);

    // 同一题重复作答会被拒
    const dup = await rt.tools.get("wordvault_exam_answer").execute({ sessionId, seq: 1, choice: "B" }, exec);
    assert.match(String(dup), /已经答过/);

    // 换一份卷子也能出(纸笔用)
    const paper = JSON.parse(await rt.tools.get("wordvault_exam_paper").execute({ sessionId, format: "html" }, exec));
    assert.equal(paper.ok, true, JSON.stringify(paper));
    assert.ok(existsSync(paper.files.paperHtml));
    assert.match(readFileSync(paper.files.keyHtml, "utf8"), /参考答案/);
  } finally {
    cleanup(dir, rt.effects);
  }
});
