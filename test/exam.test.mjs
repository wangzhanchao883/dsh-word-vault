import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  allocateAnswerPositions,
  sentenceHasWord,
  extractSentenceFromContext,
  libraryDistractorPool,
  composeQuestion,
  generateExam,
  buildPaperHtml,
  makeRng,
  meaningsConflict,
  meaningVariants,
  trimMeaning,
  pickExamWords,
  buildSentenceRepairPrompt,
  parseSentenceRepair,
  looksLikeSentence,
} from "../examgen.mjs";
import { parseChoice, buildExamPageHtml } from "../exam.mjs";
import {
  openDb,
  closeDb,
  ensureUser,
  recordEntries,
  queryWords,
  upsertDict,
  createExamSession,
  addExamQuestion,
  listExamQuestions,
  answerExamQuestion,
  examSummary,
  finishExamSession,
  answerPositionSpread,
  listExamSessions,
} from "../db.mjs";

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), "wv-exam-"));
  return { dir, path: join(dir, "words.db") };
}

function seedWords(db, userId, list) {
  recordEntries(db, {
    userId,
    entries: list.map((w) => ({ term: w.word, lemma: w.word, kind: "word" })),
    kind: "hotkey",
    via: "test",
    context: list.map((w) => w.context || "").join(" "),
  });
  upsertDict(db, list.map((w) => ({ term: w.word, kind: "word", pos: w.pos || "n.", meaning: w.meaning || "", phonetic: "" })));
  return queryWords(db, { userId, kind: "word", orderBy: "alpha" });
}

// ---------------------------------------------------------------- 位置配额

test("答案位置:20 题时 A/B/C/D 各 5 次,且不出现连续 3 个同位置", () => {
  const pos = allocateAnswerPositions(20, makeRng(42));
  assert.equal(pos.length, 20);
  const spread = [0, 0, 0, 0];
  for (const p of pos) spread[p] += 1;
  assert.deepEqual(spread, [5, 5, 5, 5]);
  for (let i = 2; i < pos.length; i++) {
    assert.ok(!(pos[i] === pos[i - 1] && pos[i] === pos[i - 2]), `第 ${i + 1} 题起连续三个同位置:${pos.join("")}`);
  }
});

test("答案位置:10 题时四个位置都有,且总量均衡(3/3/2/2)", () => {
  const pos = allocateAnswerPositions(10, makeRng(7));
  const spread = [0, 0, 0, 0];
  for (const p of pos) spread[p] += 1;
  assert.deepEqual([...spread].sort(), [2, 2, 3, 3]);
  assert.ok(spread.every((n) => n > 0), "每个位置至少出现一次");
});

test("答案位置:同种子可复现", () => {
  assert.deepEqual(allocateAnswerPositions(12, makeRng(2026)), allocateAnswerPositions(12, makeRng(2026)));
});

// ---------------------------------------------------------------- 句子

test("句子含词判定:容忍常见屈折", () => {
  assert.ok(sentenceHasWord("Nice to meet you.", "meet"));
  assert.ok(sentenceHasWord("She makes a salad.", "make"));
  assert.ok(sentenceHasWord("They are playing in the yard.", "play"));
  assert.ok(sentenceHasWord("Animals and plants share the world.", "plant"));
  assert.ok(!sentenceHasWord("Nice to see you.", "meet"));
});

test("从录入原文里挑出含该词的那句(并清掉对话破折号)", () => {
  const ctx = "— Mum, that is my friend, Jenny. — Nice to meet you, Jenny. What are those?";
  assert.equal(extractSentenceFromContext(ctx, "meet"), "Nice to meet you, Jenny.");
  assert.equal(extractSentenceFromContext(ctx, "banana"), null);
  assert.equal(extractSentenceFromContext("", "meet"), null);
});

test("含词判定:屈折形式也算(meeting 含 meet)", () => {
  assert.ok(sentenceHasWord("A meeting room.", "meet"));
});

test("原文里没有该词时返回 null(交给模型写)", () => {
  assert.equal(extractSentenceFromContext("Children are playing in a yard.", "tomato"), null);
});

test("句子质量门槛:裸词/短标签不算句子(实测踩过 entities 这种)", () => {
  assert.equal(looksLikeSentence("entities"), false);
  assert.equal(looksLikeSentence("structure"), false);
  assert.equal(looksLikeSentence("monorepo"), false);
  assert.equal(looksLikeSentence("a map"), false);
  assert.equal(looksLikeSentence("I have a map."), true);
  // 录词时复制的是裸词 → 不能当成题干
  assert.equal(extractSentenceFromContext("entities", "entity"), null);
  assert.equal(extractSentenceFromContext("geometry", "geometry"), null);
  assert.ok(extractSentenceFromContext("This is a map of China.", "map"));
});

test("选词:支持 excludeWords 排除垃圾词/专名", () => {
  const { dir, path } = tempDb();
  const db = openDb(path);
  try {
    const u = ensureUser(db, "用户1");
    seedWords(db, u.id, [
      { word: "map", pos: "n.", meaning: "地图" },
      { word: "entity", pos: "n.", meaning: "实体" },
      { word: "monorepo", pos: "n.", meaning: "单一代码库" },
    ]);
    const picked = pickExamWords({ db, queryWords, userId: u.id, scope: { excludeWords: "entity monorepo" }, count: 5, recheckRatio: 0 });
    assert.deepEqual(picked.picked.map((p) => p.row.lemma), ["map"]);
    assert.equal(picked.pool.excluded, 2);
  } finally {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- 干扰项

test("同库干扰项池:按词性分组、排除目标词、释义去重", () => {
  const { dir, path } = tempDb();
  const db = openDb(path);
  try {
    const u = ensureUser(db, "用户1");
    seedWords(db, u.id, [
      { word: "tomato", pos: "n.", meaning: "西红柿" },
      { word: "potato", pos: "n.", meaning: "土豆" },
      { word: "plant", pos: "n.", meaning: "植物" },
      { word: "meet", pos: "v.", meaning: "遇见" },
      { word: "share", pos: "v.", meaning: "分享" },
    ]);
    const pool = libraryDistractorPool(db, u.id, "n.", "tomato");
    assert.deepEqual(pool.samePos.map((x) => x.meaning).sort(), ["土豆", "植物"]);
    assert.ok(!pool.samePos.some((x) => x.word === "tomato"));
    assert.deepEqual(pool.others.map((x) => x.meaning).sort(), ["分享", "遇见"]);
  } finally {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("组题:原文句优先 + 库内干扰项优先 + 模型补齐到 4 个选项", () => {
  const { dir, path } = tempDb();
  const db = openDb(path);
  try {
    const u = ensureUser(db, "用户1");
    seedWords(db, u.id, [
      { word: "meet", pos: "v.", meaning: "遇见" },
      { word: "share", pos: "v.", meaning: "分享" },
      { word: "make", pos: "v.", meaning: "制作" },
    ]);
    const pool = libraryDistractorPool(db, u.id, "v.", "meet");
    const composed = composeQuestion({
      item: { word: "meet", meaning: "遇见", pos: "v.", sentence: "Nice to meet you, Jenny." },
      raw: { word: "meet", sentence: "I meet my teacher every morning.", distractors: ["错过", "送别"] },
      answerIndex: 2,
      pool,
      rng: makeRng(1),
    });
    assert.equal(composed.ok, true, JSON.stringify(composed.issues));
    const q = composed.question;
    assert.equal(q.sentence, "Nice to meet you, Jenny."); // 原文优先
    assert.equal(q.sentenceSrc, "context");
    assert.equal(q.options.length, 4);
    assert.equal(q.options[2], "遇见"); // 答案落在指定位置
    assert.equal(new Set(q.options).size, 4, "选项不能重复");
    assert.ok(q.options.filter((o) => o !== "遇见").every((o) => ["土豆", "植物", "分享", "制作", "错过", "送别"].includes(o)));
    assert.equal(q.optionSources[2], "correct");
    assert.ok(q.optionSources.filter((s) => s === "library").length >= 1, "至少混入一个库内词义");
  } finally {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("组题:句子不含该词 → 不合格(不猜)", () => {  const composed = composeQuestion({
    item: { word: "tomato", meaning: "西红柿", pos: "n.", sentence: "I like potatoes." },
    raw: { word: "tomato", sentence: "Tomatoes are red.", distractors: ["土豆", "黄瓜", "辣椒"] },
    answerIndex: 0,
    pool: { samePos: [], others: [] },
    rng: makeRng(1),
  });
  assert.equal(composed.ok, true);
  assert.equal(composed.question.sentence, "Tomatoes are red."); // 弃用了不含该词的原文句
  assert.match(composed.question.issues.join(), /没有该词/);

  const bad = composeQuestion({
    item: { word: "tomato", meaning: "西红柿", pos: "n.", sentence: "I like potatoes." },
    raw: { word: "tomato", sentence: "I like potatoes.", distractors: [] },
    answerIndex: 0,
    pool: { samePos: [], others: [] },
    rng: makeRng(1),
  });
  assert.equal(bad.ok, false);
});

// ---------------------------------------------------------------- 出题主流程

test("释义撞义判定:多义项写法也要拦住", () => {
  assert.deepEqual(meaningVariants("马铃薯;土豆"), ["马铃薯", "土豆"]);
  assert.ok(meaningsConflict("马铃薯;土豆", "土豆"), "子串也算撞义");
  assert.ok(meaningsConflict("院子;庭院", "院子"));
  assert.ok(meaningsConflict("土豆", "马铃薯;土豆"));
  assert.ok(!meaningsConflict("土豆", "胡萝卜"));
  assert.ok(!meaningsConflict("胡萝卜", "白菜"));
});

test("组题:干扰项不能与正确答案撞义(真机演示里出现过的坑)", () => {
  const composed = composeQuestion({
    item: { word: "potato", meaning: "马铃薯;土豆", pos: "n.", sentence: "I like potatoes." },
    raw: { word: "potato", sentence: "I like potatoes.", distractors: ["土豆", "胡萝卜"] },
    answerIndex: 0,
    pool: { samePos: [{ meaning: "鸭子;鸭肉" }], others: [{ meaning: "西红柿" }] },
    rng: makeRng(1),
  });
  assert.equal(composed.ok, true, JSON.stringify(composed.issues));
  const opts = composed.question.options;
  assert.equal(opts.length, 4);
  assert.equal(new Set(opts).size, 4);
  assert.ok(!opts.some((o) => o !== "马铃薯;土豆" && meaningsConflict(o, "马铃薯;土豆")), `选项里混进了与答案撞义的项:${opts.join(" / ")}`);
  assert.ok(opts.includes("胡萝卜"));
  assert.ok(opts.includes("鸭子;鸭肉"));
});

test("选项展示:义项最多留 2 个(避免正确答案比干扰项长一截)", () => {
  assert.equal(trimMeaning("院子;庭院;码"), "院子;庭院");
  assert.equal(trimMeaning("院子;庭院"), "院子;庭院");
  assert.equal(trimMeaning("地图"), "地图");
  const composed = composeQuestion({
    item: { word: "yard", meaning: "院子;庭院;码", pos: "n.", sentence: "They play in the yard." },
    raw: { word: "yard", sentence: "They play in the yard.", distractors: ["厨房", "操场"] },
    answerIndex: 1,
    pool: { samePos: [], others: [] },
    rng: makeRng(2),
  });
  assert.equal(composed.ok, true);
  assert.ok(composed.question.options.every((o) => o.split(/[;；]/).filter(Boolean).length <= 2), composed.question.options.join(" / "));
});

test("选词:scope.status=mastered 时已学会词是主池(专项复查)", () => {
  const { dir, path } = tempDb();
  const db = openDb(path);
  try {
    const u = ensureUser(db, "用户1");
    seedWords(db, u.id, [
      { word: "map", pos: "n.", meaning: "地图" },
      { word: "plant", pos: "n.", meaning: "植物" },
      { word: "photo", pos: "n.", meaning: "照片" },
    ]);
    const rows = queryWords(db, { userId: u.id, kind: "word" });
    db.prepare("UPDATE words SET status = 'mastered', streak = 3 WHERE user_id = ? AND lemma IN ('map','plant')").run(u.id);
    const picked = pickExamWords({ db, queryWords, userId: u.id, scope: { status: "mastered" }, count: 5, recheckRatio: 0.1 });
    assert.equal(picked.picked.length, 2, "两门已学会词都应被选中");
    assert.ok(picked.picked.every((p) => p.recheck === true));
    assert.deepEqual(picked.picked.map((p) => p.row.lemma).sort(), ["map", "plant"]);
    void rows;
  } finally {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  }
});

function examFakeLlm() {
  const hasWord = (prompt, w) => prompt.includes(`\\"${w}\\"`) || prompt.includes(`"${w}"`);
  return {
    stream(options) {
      const prompt = JSON.stringify(options.messages);
      const words = [];
      const re = /\\"word\\":\\"([a-z]+)\\"/g;
      let m;
      while ((m = re.exec(prompt))) words.push(m[1]);
      const payload = JSON.stringify(
        words.map((w) => ({
          word: w,
          sentence: `We ${w} every day at school.`,
          distractors: [`${w}干扰一`, `${w}干扰二`, `${w}干扰三`],
          pos: "v.",
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

test("generateExam:题量/选项/位置分布/句子含词 全部达标", async () => {
  const { dir, path } = tempDb();
  const db = openDb(path);
  try {
    const u = ensureUser(db, "用户1");
    const words = ["meet", "share", "make", "plant", "world", "photo", "kind", "map"];
    seedWords(db, u.id, words.map((w) => ({ word: w, pos: "v.", meaning: `${w}释义` })));
    const gen = await generateExam({
      llm: examFakeLlm(),
      provider: "p",
      model: "m",
      db,
      queryWords,
      userId: u.id,
      scope: { seed: 5 },
      count: 8,
      recheckRatio: 0,
      batchSize: 4,
    });
    assert.equal(gen.questions.length, 8, JSON.stringify(gen.failures));
    const spread = [0, 0, 0, 0];
    for (const q of gen.questions) {
      assert.equal(q.options.length, 4);
      assert.equal(new Set(q.options).size, 4);
      assert.equal(q.options[q.answerIndex], q.correctMeaning);
      assert.ok(sentenceHasWord(q.sentence, q.word), `句子不含 ${q.word}: ${q.sentence}`);
      spread[q.answerIndex] += 1;
    }
    assert.deepEqual(spread, [2, 2, 2, 2], `位置分布应均衡,实际 ${spread}`);
  } finally {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- 判分与掌握

test("补句子:提示词要求原样出现该词、禁用派生词", () => {
  const p = buildSentenceRepairPrompt(["health", "kind"]);
  assert.match(p, /health/);
  assert.match(p, /原样出现/);
  assert.match(p, /health 不能写成 healthy/);
});

test("补句子解析:只收在候选名单里的词", () => {
  const text = '```json\n[{"word":"health","sentence":"Good health comes from sleep."},{"word":"other","sentence":"Other thing."}]\n```';
  const map = parseSentenceRepair(text, ["health"]);
  assert.equal(map.size, 1);
  assert.equal(map.get("health"), "Good health comes from sleep.");
});

test("出题:首轮用派生词写句子的词,会被补句子救回", async () => {
  const { dir, path } = tempDb();
  const db = openDb(path);
  try {
    const u = ensureUser(db, "用户1");
    seedWords(db, u.id, [
      { word: "health", pos: "n.", meaning: "健康" },
      { word: "map", pos: "n.", meaning: "地图" },
    ]);
    let call = 0;
    const llm = {
      stream() {
        call += 1;
        const payload =
          call === 1
            ? JSON.stringify([
                { word: "health", sentence: "Eating well keeps you healthy.", distractors: ["疾病", "疲劳"], pos: "n." },
                { word: "map", sentence: "This is a map of China.", distractors: ["旗帜", "照片"], pos: "n." },
              ])
            : JSON.stringify([{ word: "health", sentence: "Good health comes from sleep.", distractors: ["疾病", "疲劳"], pos: "n." }]);
        async function* gen() {
          yield { type: "text-delta", index: 0, text: payload };
          yield { type: "finish", reason: { kind: "stop" } };
        }
        return gen();
      },
    };
    const gen = await generateExam({
      llm, provider: "p", model: "m", db, queryWords, userId: u.id,
      scope: { seed: 3 }, count: 2, recheckRatio: 0, batchSize: 2,
    });
    assert.equal(gen.questions.length, 2, JSON.stringify(gen.failures));
    assert.equal(call, 2, "应该触发一次补句子调用");
    const health = gen.questions.find((q) => q.word === "health");
    assert.match(health.sentence, /health/);
    assert.equal(health.options.length, 4);
  } finally {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("掌握度:连续 3 次答对 → 已学会;再答错 → 摘牌回 learning", () => {
  const { dir, path } = tempDb();
  const db = openDb(path);
  try {
    const u = ensureUser(db, "用户1");
    seedWords(db, u.id, [{ word: "map", pos: "n.", meaning: "地图" }]);
    const [row] = queryWords(db, { userId: u.id, kind: "word" });
    const oneQuestion = (session, seq, options, answerIndex) => {
      addExamQuestion(db, {
        sessionId: session.id, seq, wordId: row.id, promptWord: "map",
        sentence: "This is a map.", correctMeaning: "地图", options, answerIndex,
      });
    };

    for (let round = 1; round <= 3; round++) {
      const s = createExamSession(db, { userId: u.id, scope: {}, count: 1 });
      oneQuestion(s, 1, ["地图", "土豆", "苹果", "桌子"], 0);
      const r = answerExamQuestion(db, { sessionId: s.id, seq: 1, chosenIndex: 0 });
      assert.equal(r.isCorrect, true);
      assert.equal(r.streak, round);
      assert.equal(r.mastered, round === 3);
    }
    let w = db.prepare("SELECT * FROM words WHERE id = ?").get(row.id);
    assert.equal(w.status, "mastered");
    assert.equal(w.streak, 3);

    // 答错 → 清零 + 摘牌
    const s4 = createExamSession(db, { userId: u.id, scope: {}, count: 1 });
    oneQuestion(s4, 1, ["地图", "土豆", "苹果", "桌子"], 0);
    const wrong = answerExamQuestion(db, { sessionId: s4.id, seq: 1, chosenIndex: 1 });
    assert.equal(wrong.isCorrect, false);
    assert.equal(wrong.demoted, true);
    assert.equal(wrong.streak, 0);
    w = db.prepare("SELECT * FROM words WHERE id = ?").get(row.id);
    assert.equal(w.status, "learning");
    assert.equal(w.streak, 0);
    assert.equal(w.mastered_at, null);
    assert.equal(w.wrong_count, 1);
  } finally {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("判分:同一题不能答两次;结算给出错题清单与位置分布", () => {
  const { dir, path } = tempDb();
  const db = openDb(path);
  try {
    const u = ensureUser(db, "用户1");
    seedWords(db, u.id, [
      { word: "map", pos: "n.", meaning: "地图" },
      { word: "plant", pos: "n.", meaning: "植物" },
    ]);
    const rows = queryWords(db, { userId: u.id, kind: "word", orderBy: "alpha" });
    const s = createExamSession(db, { userId: u.id, scope: { minCount: 1 }, count: 2 });
    addExamQuestion(db, { sessionId: s.id, seq: 1, wordId: rows[0].id, promptWord: rows[0].lemma, sentence: "This is a map.", correctMeaning: "地图", options: ["地图", "桌子", "苹果", "土豆"], answerIndex: 0 });
    addExamQuestion(db, { sessionId: s.id, seq: 2, wordId: rows[1].id, promptWord: rows[1].lemma, sentence: "The plant is green.", correctMeaning: "植物", options: ["植物", "动物", "桌子", "苹果"], answerIndex: 0, isRecheck: true });

    assert.equal(answerExamQuestion(db, { sessionId: s.id, seq: 1, chosenIndex: 0 }).isCorrect, true);
    const dup = answerExamQuestion(db, { sessionId: s.id, seq: 1, chosenIndex: 1 });
    assert.equal(dup.ok, false);
    assert.match(dup.error, /已经答过/);
    assert.equal(answerExamQuestion(db, { sessionId: s.id, seq: 2, chosenIndex: 2 }).isCorrect, false);

    const summary = finishExamSession(db, s.id);
    assert.equal(summary.total, 2);
    assert.equal(summary.answered, 2);
    assert.equal(summary.correct, 1);
    assert.equal(summary.accuracy, 50);
    assert.equal(summary.recheckCount, 1);
    assert.equal(summary.wrong.length, 1);
    assert.equal(summary.wrong[0].word, "plant");
    assert.equal(summary.wrong[0].chose, "桌子");
    assert.equal(summary.wrong[0].right, "植物");
    assert.equal(answerPositionSpread(db, s.id).spread[0], 2);
    assert.equal(listExamSessions(db, u.id, 5)[0].id, s.id);
  } finally {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- 答题页与服务

test("parseChoice:接受 A/B/C/D 与 0-3", () => {
  assert.equal(parseChoice("A"), 0);
  assert.equal(parseChoice("d"), 3);
  assert.equal(parseChoice("2"), 2);
  assert.equal(parseChoice(1), 1);
  assert.equal(parseChoice("E"), -1);
  assert.equal(parseChoice(""), -1);
});

/** 从答题页里抠出初始题目数据(用于断言"页面拿不到答案") */
function extractPageQuestions(html) {
  const m = html.match(/const QS = (\[[\s\S]*?\]);/);
  assert.ok(m, "页面里没有 QS 数据");
  return JSON.parse(m[1]);
}

test("答题页 HTML:初始数据只有题干与选项,不含答案", () => {
  const html = buildExamPageHtml({
    token: "tok123",
    title: "英语单词测验",
    subtitle: "用户1 · 1 题",
    total: 1,
    questions: [{ seq: 1, sentence: "Nice to meet you.", word: "meet", options: ["遇见", "错过", "送别", "邀请"], isRecheck: false }],
  });
  assert.match(html, /Nice to meet you\./);
  assert.match(html, /遇见/);
  const qs = extractPageQuestions(html);
  assert.equal(qs.length, 1);
  assert.deepEqual(Object.keys(qs[0]).sort(), ["isRecheck", "options", "sentence", "seq", "word"]);
  assert.ok(!html.includes("answerIndex"), "初始数据不能带答案下标");
  assert.ok(!html.includes("answer_index"));
});

test("可打印试卷:题目页 + 答案页", () => {
  const qs = [
    { seq: 1, sentence: "Nice to meet you.", word: "meet", options: ["遇见", "错过", "送别", "邀请"], answerIndex: 0, correctMeaning: "遇见", isRecheck: false },
  ];
  const paper = buildPaperHtml({ sessionId: 1, title: "小测", subtitle: "s", questions: qs, includeAnswers: false });
  assert.match(paper, /句中的 <b>meet<\/b> 是什么意思？/);
  assert.ok(!paper.includes("参考答案"));
  const key = buildPaperHtml({ sessionId: 1, title: "小测", subtitle: "s", questions: qs, includeAnswers: true });
  assert.match(key, /参考答案/);
  assert.match(key, /<td>A<\/td>/);
});

test("答题服务:HTTP 端到端(真起服务、真判分)", async () => {
  const { dir, path } = tempDb();
  const db = openDb(path);
  let srv = null;
  try {
    const u = ensureUser(db, "用户1");
    seedWords(db, u.id, [{ word: "map", pos: "n.", meaning: "地图" }]);
    const [row] = queryWords(db, { userId: u.id, kind: "word" });
    const s = createExamSession(db, { userId: u.id, scope: {}, count: 1, token: "tok-e2e" });
    addExamQuestion(db, { sessionId: s.id, seq: 1, wordId: row.id, promptWord: "map", sentence: "This is a map.", correctMeaning: "地图", options: ["地图", "桌子", "苹果", "土豆"], answerIndex: 0 });

    const { startExamServer } = await import("../exam.mjs");
    srv = await startExamServer({ db, sessionId: s.id, title: "小测", subtitle: "s" });
    assert.equal(srv.ok, true, srv.error);
    assert.match(srv.url, /^http:\/\/127\.0\.0\.1:\d+\/e\/tok-e2e$/);

    const page = await fetch(srv.url).then((r) => r.text());
    assert.match(page, /This is a map\./);
    assert.ok(!page.includes("answerIndex"), "服务端下发的初始数据不含答案");

    const badToken = await fetch(`http://127.0.0.1:${srv.port}/e/wrong`).then((r) => r.status);
    assert.equal(badToken, 404);

    const ans = await fetch(`http://127.0.0.1:${srv.port}/api/tok-e2e/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seq: 1, choice: "A" }),
    }).then((r) => r.json());
    assert.equal(ans.ok, true);
    assert.equal(ans.isCorrect, true);
    assert.equal(ans.streak, 1);
    assert.equal(ans.progress.answered, 1);

    const summary = await fetch(`http://127.0.0.1:${srv.port}/api/tok-e2e/finish`, { method: "POST" }).then((r) => r.json());
    assert.equal(summary.correct, 1);
    assert.equal(summary.total, 1);
    assert.equal(listExamQuestions(db, s.id)[0].isCorrect, true);
  } finally {
    if (srv && srv.close) srv.close();
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  }
});
