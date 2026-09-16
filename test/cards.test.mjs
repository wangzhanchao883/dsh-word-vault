import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildCardHtml,
  buildDocxHtml,
  renderCard,
  exportCardSet,
  findBrowser,
  findPandoc,
  PER_PAGE,
  escapeHtml,
} from "../cards.mjs";
import { buildCardPrompt, parseCardOutput, validateCard, generateCards } from "../cardgen.mjs";

const SAMPLE = [
  { word: "hamburger", phonetic: "/ˈhæmbɜːɡə(r)/", pos: "n.", meaning: "汉堡包", segs: [{ en: "ham", cn: "汉" }, { en: "bur", cn: "饱" }, { en: "ger", cn: "哥" }], story: "汉饱哥一口气吞了八个汉堡，最后卡在门框里。" },
  { word: "map", phonetic: "/mæp/", pos: "n.", meaning: "地图", segs: [{ en: "ma", cn: "马" }, { en: "p", cn: "扑" }], story: "马扑到地图上，把整条街压成了褶子。" },
];

function makeWords(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push({ ...SAMPLE[i % SAMPLE.length], word: `${SAMPLE[i % SAMPLE.length].word}${i}` });
  return out;
}

test("高频词角标:达到门槛才印,低频词不印", () => {
  const hot = renderCard({ word: "kinds", segs: [{ en: "ki", cn: "开" }, { en: "nds", cn: "恩兹" }], story: "x", seenCount: 4 }, 1, { highFreqMin: 2 });
  assert.match(hot, /class="freq"/);
  assert.match(hot, /标记 4 次/);
  const cold = renderCard({ word: "map", segs: [], story: "x", seenCount: 1 }, 2, { highFreqMin: 2 });
  assert.ok(!cold.includes('class="freq"'), "只标记 1 次的词不该印角标");
  const noCount = renderCard({ word: "map", segs: [], story: "x" }, 3, { highFreqMin: 2 });
  assert.ok(!noCount.includes('class="freq"'), "拿不到次数时不印");
  const strict = renderCard({ word: "kinds", segs: [], story: "x", seenCount: 4 }, 4, { highFreqMin: 5 });
  assert.ok(!strict.includes('class="freq"'), "门槛设为 5 时 4 次不算高频");
});

test("buildCardHtml / Word 版把频次带进产物,并统计高频卡数", () => {
  const words = [
    { word: "kinds", phonetic: "/k/", pos: "n.", meaning: "种类", segs: [{ en: "ki", cn: "开" }], story: "s1", seenCount: 4 },
    { word: "map", phonetic: "/m/", pos: "n.", meaning: "地图", segs: [{ en: "map", cn: "马铺" }], story: "s2", seenCount: 1 },
  ];
  const built = buildCardHtml({ title: "T", words, highFreqMin: 2 });
  assert.equal(built.highFreqCards, 1);
  assert.equal((built.html.match(/标记 4 次/g) || []).length, 1);
  assert.ok(!built.html.includes("标记 1 次"));

  const docx = buildDocxHtml({ title: "T", words, highFreqMin: 2 });
  assert.match(docx.html, /［标记 4 次］/);
  assert.ok(!docx.html.includes("［标记 1 次］"));
});

test("版式常量:每页 8 张(2 列 × 4 行)", () => {
  assert.equal(PER_PAGE, 8);
});

test("生成卡片 HTML:页眉/页码/卡片数", () => {
  const { html, pages, cards } = buildCardHtml({ title: "趣味单词记忆卡", subtitle: "用户1 · 8 词", words: makeWords(8) });
  assert.equal(pages, 1);
  assert.equal(cards, 8);
  assert.match(html, /<title>趣味单词记忆卡<\/title>/);
  assert.match(html, /第 1 \/ 1 页/);
  assert.match(html, /用户1 · 8 词/);
  assert.equal((html.match(/<div class="card">/g) || []).length, 8);
  assert.equal((html.match(/空位 · 错词重写区/g) || []).length, 0);
  // 四层结构都在
  assert.match(html, /class="idx"/);
  assert.match(html, /class="split"/);
  assert.match(html, /class="story"/);
  assert.match(html, /class="write"/);
  assert.match(html, /已攻下/);
});

test("不足 8 张时空位印成「错词重写区」", () => {
  const { pages, html } = buildCardHtml({ title: "T", words: makeWords(9) });
  assert.equal(pages, 2);
  assert.equal((html.match(/<div class="card">/g) || []).length, 9);
  assert.equal((html.match(/空位 · 错词重写区/g) || []).length, 7);
  assert.match(html, /第 2 \/ 2 页/);
});

test("长单词自动缩小字号(.word.long)", () => {
  const short = renderCard({ word: "map", segs: [], story: "x" }, 1);
  const long = renderCard({ word: "interesting", segs: [], story: "x" }, 2);
  assert.match(short, /class="word"/);
  assert.match(long, /class="word long"/);
});

test("HTML 转义:词面里的尖括号不会破版", () => {
  assert.equal(escapeHtml('<b>&"x"'), "&lt;b&gt;&amp;&quot;x&quot;");
  const html = renderCard({ word: "<script>", segs: [{ en: "<a>", cn: "<中>" }], story: "<b>坏</b>" }, 1);
  assert.ok(!html.includes("<script>"));
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;a&gt;/);
});

test("拆解块按 en/cn 成对渲染", () => {
  const html = renderCard(SAMPLE[0], 1);
  assert.equal((html.match(/class="seg"/g) || []).length, 3);
  assert.match(html, /<span class="en">ham<\/span><span class="cn">汉<\/span>/);
});

test("Word 版用表格排版且带勾选框", () => {
  const { html, cards } = buildDocxHtml({ title: "趣味单词记忆卡", subtitle: "s", words: SAMPLE });
  assert.equal(cards, 2);
  assert.match(html, /<table/);
  assert.match(html, /☐ 已攻下/);
  assert.match(html, /hamburger/);
  assert.match(html, /挑战：盖住上面/);
});

test("exportCardSet 只出 HTML 时不需要浏览器", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wv-cards-"));
  try {
    const out = await exportCardSet({ outDir: dir, stem: "t", title: "T", subtitle: "s", words: SAMPLE, formats: ["html"] });
    assert.equal(out.html.ok, true);
    assert.ok(existsSync(out.html.path));
    assert.equal(out.pages, 1);
    assert.equal(out.cards, 2);
    assert.equal(out.pdf, undefined);
    assert.match(readFileSync(out.html.path, "utf8"), /hamburger/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("exportCardSet 出 PDF + 预览图(需要 Edge/Chrome)", async (t) => {
  if (!findBrowser()) return t.skip("本机没有 Edge/Chrome");
  const dir = mkdtempSync(join(tmpdir(), "wv-pdf-"));
  try {
    const out = await exportCardSet({ outDir: dir, stem: "t", title: "T", subtitle: "s", words: makeWords(8), formats: ["html", "pdf"] });
    assert.equal(out.pdf.ok, true, out.pdf.error || "");
    assert.ok(out.pdf.bytes > 20000, `PDF 太小: ${out.pdf.bytes}`);
    assert.ok(existsSync(out.pdf.path));
    assert.equal(out.preview.ok, true, out.preview.error || "");
    assert.ok(out.preview.bytes > 10000, `预览图太小: ${out.preview.bytes}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("出 Word(需要 pandoc)", async (t) => {
  const pandoc = findPandoc();
  if (pandoc === "pandoc") {
    // PATH 里找不到具体文件时也尝试一次,失败就跳过
  }
  const dir = mkdtempSync(join(tmpdir(), "wv-docx-"));
  try {
    const out = await exportCardSet({ outDir: dir, stem: "t", title: "T", subtitle: "s", words: SAMPLE, formats: ["word"] });
    if (!out.word.ok) return t.skip(`pandoc 不可用: ${out.word.error}`);
    assert.ok(out.word.bytes > 5000, `docx 太小: ${out.word.bytes}`);
    assert.ok(existsSync(out.word.path));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- cardgen

test("提示词包含全部词与硬约束", () => {
  const p = buildCardPrompt([{ word: "map", meaning: "地图" }]);
  assert.match(p, /map/);
  assert.match(p, /地图/);
  assert.match(p, /恰好等于原词/);
  assert.match(p, /短词/);
  assert.match(p, /40 字以内/);
  assert.match(p, /绝不编造/);
});

test("解析:容忍围栏/前后废话/逐行对象", () => {
  assert.deepEqual(parseCardOutput('```json\n[{"word":"map"}]\n```'), [{ word: "map" }]);
  assert.equal(parseCardOutput('前言 [{"word":"a"}] 后记').length, 1);
  assert.equal(parseCardOutput('{"cards":[{"word":"a"}]}').length, 1);
  assert.deepEqual(parseCardOutput("完全不是 JSON"), []);
});

test("校验:拆解必须拼回原词 / 音标格式 / 梗长", () => {
  const good = validateCard({ word: "hamburger", phonetic: "/x/", segs: [{ en: "ham", cn: "汉" }, { en: "burger", cn: "饱哥" }], story: "短句" }, "hamburger");
  assert.equal(good.ok, true);
  assert.deepEqual(good.card.segs.length, 2);

  const mismatch = validateCard({ word: "map", segs: [{ en: "ma", cn: "马" }], story: "x" }, "map");
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.issues.join(), /不一致/);

  const badPhonetic = validateCard({ word: "map", phonetic: "mæp", segs: [{ en: "map", cn: "马扑" }], story: "x" }, "map");
  assert.equal(badPhonetic.ok, true);
  assert.equal(badPhonetic.card.phonetic, "");
  assert.match(badPhonetic.issues.join(), /音标格式/);

  const longStory = validateCard({ word: "map", segs: [{ en: "map", cn: "马扑" }], story: "很".repeat(70) }, "map");
  assert.ok(longStory.card.story.length <= 59);
  assert.match(longStory.issues.join(), /截断/);
});

/** 假 LLM:按调用次序返回预设文本 */
function fakeLlm(...payloads) {
  let i = 0;
  return {
    stream() {
      const text = payloads[Math.min(i, payloads.length - 1)];
      i += 1;
      async function* gen() {
        yield { type: "text-delta", index: 0, text };
        yield { type: "finish", reason: { kind: "stop" } };
      }
      return gen();
    },
  };
}

test("generateCards:正常返回即入库级卡片", async () => {
  const payload = JSON.stringify([
    { word: "map", phonetic: "/mæp/", pos: "n.", meaning: "地图", segs: [{ en: "ma", cn: "马" }, { en: "p", cn: "扑" }], story: "马扑到地图上。" },
  ]);
  const res = await generateCards({ llm: fakeLlm(payload), provider: "p", model: "m", items: [{ word: "map" }] });
  assert.equal(res.cards.length, 1);
  assert.equal(res.failures.length, 0);
  assert.equal(res.cards[0].word, "map");
  assert.equal(res.cards[0].segs.length, 2);
});

test("generateCards:拆解不合格会带着原因重试一次", async () => {
  const bad = JSON.stringify([{ word: "map", segs: [{ en: "wrong", cn: "错" }], story: "x" }]);
  const good = JSON.stringify([{ word: "map", segs: [{ en: "ma", cn: "马" }, { en: "p", cn: "铺" }], story: "重试后的梗" }]);
  const res = await generateCards({ llm: fakeLlm(bad, good), provider: "p", model: "m", items: [{ word: "map" }] });
  assert.equal(res.cards.length, 1);
  assert.equal(res.cards[0].story, "重试后的梗");
  assert.equal(res.cards[0].low, false);
  assert.equal(res.failures.length, 0);
});

test("质量闸门:逐字母硬拆会被判 low 并重试,仍不合格也保留卡片", async () => {
  const letterByLetter = JSON.stringify([
    { word: "health", segs: [{ en: "h", cn: "喝" }, { en: "e", cn: "鹅" }, { en: "a", cn: "啊" }, { en: "l", cn: "乐" }, { en: "t", cn: "踢" }, { en: "h", cn: "好" }], story: "逐字母的梗" },
  ]);
  // 两次都返回同一份逐字母结果 → 保留但标记 low,并进 lowQuality,而不是丢词
  const res = await generateCards({ llm: fakeLlm(letterByLetter, letterByLetter), provider: "p", model: "m", items: [{ word: "health" }] });
  assert.equal(res.cards.length, 1);
  assert.equal(res.cards[0].low, true);
  assert.equal(res.failures.length, 0);
  assert.equal(res.lowQuality.length, 1);
  assert.match(res.lowQuality[0].issues.join(), /逐字母|块过多/);
});

test("质量闸门:音节块拆解直接通过(不触发重试)", async () => {
  const good = JSON.stringify([
    { word: "tomato", segs: [{ en: "to", cn: "特" }, { en: "ma", cn: "马" }, { en: "to", cn: "头" }], story: "特马头" },
  ]);
  const res = await generateCards({ llm: fakeLlm(good), provider: "p", model: "m", items: [{ word: "tomato" }] });
  assert.equal(res.cards.length, 1);
  assert.equal(res.cards[0].low, false);
  assert.equal(res.lowQuality.length, 0);
});

test("generateCards:模型漏词记为失败项", async () => {
  const payload = JSON.stringify([{ word: "map", segs: [{ en: "map", cn: "马扑" }], story: "x" }]);
  const res = await generateCards({ llm: fakeLlm(payload), provider: "p", model: "m", items: [{ word: "map" }, { word: "plant" }] });
  assert.equal(res.cards.length, 1);
  assert.equal(res.failures.length, 1);
  assert.equal(res.failures[0].word, "plant");
});

test("generateCards:ctx.llm 不可用时给出可读失败", async () => {
  const res = await generateCards({ llm: null, provider: "p", model: "m", items: [{ word: "map" }] });
  assert.equal(res.cards.length, 0);
  assert.match(res.failures[0].reasons.join(), /ctx.llm 不可用/);
});
