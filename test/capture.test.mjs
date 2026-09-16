import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveConfig } from "../config.mjs";
import { openDb, closeDb, ensureUser, queryWords, stats, getCapture } from "../db.mjs";
import { CaptureService } from "../capture.mjs";
import { buildTranslatePrompt, parseTranslateOutput } from "../translate.mjs";

function tempEnv() {
  const dir = mkdtempSync(join(tmpdir(), "wordvault-cap-"));
  const dbPath = join(dir, "words.db");
  const db = openDb(dbPath);
  const config = resolveConfig({ dbPath, defaultUser: "用户1", users: [{ name: "用户1" }, { name: "用户2" }] });
  return { dir, db, config };
}

/** 假 LLM:按术语返回固定释义,不打网络 */
function fakeLlm(table) {
  return {
    stream(options) {
      const promptText = JSON.stringify(options.messages);
      const hits = Object.entries(table).filter(([term]) => promptText.includes(term));
      const payload = JSON.stringify(hits.map(([term, v]) => ({ term, ...v })));
      async function* gen() {
        yield { type: "text-delta", index: 0, text: payload };
        yield { type: "finish", reason: { kind: "stop" } };
      }
      return gen();
    },
  };
}

test("翻译提示词包含全部词,解析容忍代码块围栏", () => {
  const p = buildTranslatePrompt([{ term: "plant" }, { term: "world" }]);
  assert.match(p, /plant/);
  assert.match(p, /world/);
  const parsed = parseTranslateOutput('```json\n[{"term":"plant","meaning":"植物"}]\n```');
  assert.deepEqual(parsed, [{ term: "plant", meaning: "植物" }]);
  assert.deepEqual(parseTranslateOutput('前言\n[{"term":"a"}]\n后记').length, 1);
  assert.deepEqual(parseTranslateOutput("{}"), [{}]);
  assert.deepEqual(parseTranslateOutput("完全不是 JSON"), []);
});

test("ingest:切词入库 + 翻译缓存 + 回执文件", async () => {
  const { dir, db, config } = tempEnv();
  try {
    const u1 = ensureUser(db, "用户1");
    const svc = new CaptureService({
      config,
      db,
      logger: { info() {}, warn() {} },
      getLlm: () => fakeLlm({
        plant: { phonetic: "/plɑːnt/", pos: "n.", meaning: "植物" },
        world: { phonetic: "/wɜːld/", pos: "n.", meaning: "世界" },
      }),
      paths: { dir },
    });
    const r = await svc.ingest("Animals and plants share the world with us.", { user: "用户1", via: "clipboard" });
    assert.equal(r.ok, true);
    assert.equal(r.user, "用户1");
    // terms 是原文形态,lemmas 是归一后的词元
    assert.deepEqual(r.terms.sort(), ["animals", "plants", "share", "world"]);
    assert.deepEqual(r.lemmas.sort(), ["animal", "plant", "share", "world"]);

    const rows = queryWords(db, { userId: u1.id, orderBy: "alpha" });
    assert.deepEqual(rows.map((x) => x.lemma), ["animal", "plant", "share", "world"]);
    const plant = rows.find((x) => x.lemma === "plant");
    assert.equal(plant.meaning, "植物");
    assert.equal(plant.phonetic, "/plɑːnt/");

    // 回执文件供浮窗显示
    const result = JSON.parse(readFileSync(join(dir, "capture-result.json"), "utf8"));
    assert.equal(result.ok, true);
    assert.ok(result.captureId);
    assert.match(result.message, /用户1/);

    // 再录一次:实词命中词典缓存不再翻译(只有新出现的词组才需要翻)
    let lastPrompt = "";
    svc.getLlm = () => ({
      stream(options) {
        lastPrompt = JSON.stringify(options.messages);
        async function* gen() {
          yield { type: "text-delta", index: 0, text: "[]" };
          yield { type: "finish", reason: { kind: "stop" } };
        }
        return gen();
      },
    });
    const r2 = await svc.ingest("plants and world", { user: "用户1", via: "clipboard" });
    assert.equal(r2.ok, true);
    assert.ok(!/\nplant\n/.test(lastPrompt), "已缓存的 plant 不应再送翻译");
    assert.ok(!/\nworld\n/.test(lastPrompt), "已缓存的 world 不应再送翻译");
    assert.equal(queryWords(db, { userId: u1.id }).find((x) => x.lemma === "plant").seen_count, 2);
  } finally {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ingest:功能词/中文/纯符号都不入库", async () => {
  const { dir, db, config } = tempEnv();
  try {
    ensureUser(db, "用户1");
    const svc = new CaptureService({
      config, db, logger: { info() {}, warn() {} }, getLlm: () => null, paths: { dir },
    });

    const onlyStop = await svc.ingest("the of and to", { user: "用户1" });
    assert.equal(onlyStop.ok, false);
    assert.match(onlyStop.message, /没找到英文单词/);

    const chinese = await svc.ingest("这是一段中文", { user: "用户1" });
    assert.equal(chinese.ok, false);
  } finally {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("drain:剪贴板事件在点选模式下只写提示、不入库", async () => {
  const { dir, db, config } = tempEnv();
  try {
    const u1 = ensureUser(db, "用户1");
    const svc = new CaptureService({
      config, db, logger: { info() {}, warn() {} }, getLlm: () => null, paths: { dir },
    });
    svc.queueOffset = 0;
    svc.commandOffset = 0;
    writeFileSync(
      join(dir, "capture-queue.jsonl"),
      `${JSON.stringify({ ts: "2026-09-16T10:00:00", kind: "text", text: "Nice to meet you", via: "clipboard" })}\r\n`,
      "utf8",
    );
    await svc.drain();

    // 还没点选 → 库里必须没有东西
    assert.equal(stats(db, u1.id).events, 0);

    // 但提示文件已经写好,供助手弹窗
    const prompt = JSON.parse(readFileSync(join(dir, "capture-prompt.json"), "utf8"));
    assert.ok(prompt.id);
    assert.deepEqual(prompt.words.sort(), ["meet", "nice", "nice to meet you"]);
    assert.equal(prompt.wordCount, 3);
    assert.equal(svc.pending.size, 1);

    // 点选「用户1」→ 入到用户1
    writeFileSync(join(dir, "capture-commands.jsonl"), `${JSON.stringify({ action: "commit", id: prompt.id, user: "用户1" })}\r\n`, "utf8");
    await svc.drain();
    const rows = queryWords(db, { userId: u1.id, kind: "word", orderBy: "alpha" });
    assert.deepEqual(rows.map((x) => x.lemma), ["meet", "nice"]);
    assert.equal(stats(db, u1.id).phrases, 1);
    assert.equal(stats(db, u1.id).events, 3);
    assert.equal(svc.pending.size, 0);

    // 回执带了今日累计和 kind=commit,弹窗据此显示成功反馈
    const result = JSON.parse(readFileSync(join(dir, "capture-result.json"), "utf8"));
    assert.equal(result.kind, "commit");
    assert.equal(result.todayCount, 3);
    assert.match(result.message, /用户1/);
    assert.equal(result.id, prompt.id);
  } finally {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("点选「忽略」→ 不入库,且待选项被清掉", async () => {
  const { dir, db, config } = tempEnv();
  try {
    const u1 = ensureUser(db, "用户1");
    const svc = new CaptureService({ config, db, logger: { info() {}, warn() {} }, getLlm: () => null, paths: { dir } });
    svc.queueOffset = 0;
    svc.commandOffset = 0;
    writeFileSync(join(dir, "capture-queue.jsonl"), `${JSON.stringify({ kind: "text", text: "share the world", via: "clipboard" })}\r\n`, "utf8");
    await svc.drain();
    const prompt = JSON.parse(readFileSync(join(dir, "capture-prompt.json"), "utf8"));
    assert.equal(svc.pending.size, 1);

    writeFileSync(join(dir, "capture-commands.jsonl"), `${JSON.stringify({ action: "dismiss", id: prompt.id })}\r\n`, "utf8");
    await svc.drain();
    assert.equal(stats(db, u1.id).events, 0);
    assert.equal(svc.pending.size, 0);
    const result = JSON.parse(readFileSync(join(dir, "capture-result.json"), "utf8"));
    assert.equal(result.kind, "dismiss");
    assert.equal(result.ok, true);
  } finally {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("autoCommit=true 时保持旧的自动入库行为", async () => {
  const { dir, db, config } = tempEnv();
  try {
    const u1 = ensureUser(db, "用户1");
    const cfg = { ...config, helper: { ...config.helper, autoCommit: true } };
    const svc = new CaptureService({ config: cfg, db, logger: { info() {}, warn() {} }, getLlm: () => null, paths: { dir } });
    svc.queueOffset = 0;
    svc.commandOffset = 0;
    writeFileSync(join(dir, "capture-queue.jsonl"), `${JSON.stringify({ kind: "text", text: "world map", via: "clipboard" })}\r\n`, "utf8");
    await svc.drain();
    assert.deepEqual(queryWords(db, { userId: u1.id, kind: "word", orderBy: "alpha" }).map((x) => x.lemma), ["map", "world"]);
    assert.equal(svc.pending.size, 0);
    const result = JSON.parse(readFileSync(join(dir, "capture-result.json"), "utf8"));
    assert.equal(result.kind, "auto");
  } finally {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("过期的点选回执给出可读提示", async () => {
  const { dir, db, config } = tempEnv();
  try {
    ensureUser(db, "用户1");
    const svc = new CaptureService({ config, db, logger: { info() {}, warn() {} }, getLlm: () => null, paths: { dir } });
    svc.queueOffset = 0;
    svc.commandOffset = 0;
    writeFileSync(join(dir, "capture-commands.jsonl"), `${JSON.stringify({ action: "commit", id: "p-nope", user: "用户1" })}\r\n`, "utf8");
    await svc.drain();
    const result = JSON.parse(readFileSync(join(dir, "capture-result.json"), "utf8"));
    assert.equal(result.ok, false);
    assert.match(result.message, /过期/);
  } finally {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("命令文件:浮窗的改库/撤销被 host 正确执行", async () => {
  const { dir, db, config } = tempEnv();
  try {
    const u1 = ensureUser(db, "用户1");
    const u2 = ensureUser(db, "用户2");
    const svc = new CaptureService({
      config, db, logger: { info() {}, warn() {} }, getLlm: () => null, paths: { dir },
    });
    svc.queueOffset = 0;
    svc.commandOffset = 0;

    const ing = await svc.ingest("map and bird", { user: "用户1", via: "clipboard" });
    // 2 个实词 + 1 条词组("map and bird" 是 2~5 词短语)
    assert.equal(queryWords(db, { userId: u1.id, kind: "word" }).length, 2);
    assert.equal(queryWords(db, { userId: u1.id, kind: "phrase" }).length, 1);
    assert.equal(svc.lastCaptureId, ing.captureId);

    // 改库:用户1 -> 用户2
    writeFileSync(join(dir, "capture-commands.jsonl"), `${JSON.stringify({ action: "reassign", captureId: ing.captureId, user: "用户2" })}\r\n`, "utf8");
    await svc.drain();
    assert.equal(queryWords(db, { userId: u1.id }).length, 0);
    assert.deepEqual(queryWords(db, { userId: u2.id, kind: "word", orderBy: "alpha" }).map((x) => x.lemma), ["bird", "map"]);
    const movedId = svc.lastCaptureId;
    assert.notEqual(movedId, ing.captureId);

    // 撤销:把改过去的这次也撤掉
    writeFileSync(join(dir, "capture-commands.jsonl"), `${JSON.stringify({ action: "undo", captureId: movedId })}\r\n`, "utf8");
    svc.commandOffset = 0;
    await svc.drain();
    assert.equal(queryWords(db, { userId: u2.id }).length, 0);
    assert.equal(getCapture(db, movedId).status, "undone");
    const result = JSON.parse(readFileSync(join(dir, "capture-result.json"), "utf8"));
    assert.match(result.message, /撤销/);
  } finally {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("图片事件:只落日志与回执,不入库", async () => {
  const { dir, db, config } = tempEnv();
  try {
    const u1 = ensureUser(db, "用户1");
    const svc = new CaptureService({ config, db, logger: { info() {}, warn() {} }, getLlm: () => null, paths: { dir } });
    svc.queueOffset = 0;
    svc.commandOffset = 0;
    writeFileSync(join(dir, "capture-queue.jsonl"), `${JSON.stringify({ kind: "image", imagePath: "C:\\tmp\\a.png", via: "clipboard-image" })}\r\n`, "utf8");
    await svc.drain();
    assert.equal(stats(db, u1.id).events, 0);
    const result = JSON.parse(readFileSync(join(dir, "capture-result.json"), "utf8"));
    assert.match(result.message, /P4/);
    assert.equal(existsSync(join(dir, "capture-result.json")), true);
  } finally {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("requestCapture 写触发文件", () => {
  const { dir, db, config } = tempEnv();
  try {
    const svc = new CaptureService({ config, db, logger: { info() {}, warn() {} }, getLlm: () => null, paths: { dir } });
    const r = svc.requestCapture("用户2");
    assert.equal(r.ok, true);
    assert.equal(readFileSync(join(dir, "capture-trigger.txt"), "utf8"), "用户2");
  } finally {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  }
});
