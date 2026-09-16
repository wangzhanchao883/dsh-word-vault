import { test } from "node:test";
import assert from "node:assert/strict";
import { extractCandidates, lemmaOf, isCandidate, trimToken, uniqueWords } from "../words.mjs";

test("trimToken 去掉首尾噪声但保留内部连字符", () => {
  assert.equal(trimToken("(carrots"), "carrots");
  assert.equal(trimToken("photos."), "photos");
  assert.equal(trimToken("E-mail:"), "E-mail");
  // 所有格残留 's 由停用词表挡掉,不靠 trimToken 处理
  assert.equal(isCandidate(trimToken("'s")), false);
});

test("lemmaOf 保守还原:常规形态能还原,例外不动", () => {
  assert.equal(lemmaOf("photos"), "photo");
  assert.equal(lemmaOf("tomatoes"), "tomato");
  assert.equal(lemmaOf("babies"), "baby");
  assert.equal(lemmaOf("makes"), "make");
  assert.equal(lemmaOf("eating"), "eat");
  assert.equal(lemmaOf("visited"), "visit");
  assert.equal(lemmaOf("planned"), "plan");
  assert.equal(lemmaOf("business"), "business");
  assert.equal(lemmaOf("grass"), "grass");
  assert.equal(lemmaOf("us"), "us");
  assert.equal(lemmaOf("houses"), "house");
  assert.equal(lemmaOf("glasses"), "glass");
  assert.equal(lemmaOf("watches"), "watch");
  assert.equal(lemmaOf("boxes"), "box");
  assert.equal(lemmaOf("potatoes"), "potato");
  assert.equal(lemmaOf("shoes"), "shoe");
});

test("停用词与非词汇被过滤,实词保留", () => {
  assert.equal(isCandidate("the"), false);
  assert.equal(isCandidate("Tel"), false);
  assert.equal(isCandidate("picture"), true);
  assert.equal(isCandidate("a"), false);
});

test("样张 25 题:印刷句子里只留实词", () => {
  const r = extractCandidates("Animals and plants share the world with us.");
  const words = r.words.map((w) => w.lemma);
  assert.deepEqual(words.sort(), ["animal", "plant", "share", "world"]);
  assert.ok(r.dropped.includes("the"));
  assert.ok(r.dropped.includes("with"));
});

test("样张 19 题:短语整条识别,同时切出实词", () => {
  const r = extractCandidates("Nice to meet you");
  assert.deepEqual(r.words.map((w) => w.lemma).sort(), ["meet", "nice"]);
  assert.deepEqual(r.phrases, ["nice to meet you"]);
});

test("样张 30 题:手写答案 baby chickens 能被切出(chickens→chicken)", () => {
  const r = extractCandidates("baby chickens");
  assert.deepEqual(r.words.map((w) => w.lemma).sort(), ["baby", "chicken"]);
  assert.deepEqual(r.phrases, ["baby chickens"]);
});

test("样张词框:tomato, that, kind, plant, potato 只剩实词", () => {
  const r = extractCandidates("tomato, that, kind, plant, potato");
  assert.deepEqual(r.words.map((w) => w.lemma).sort(), ["kind", "plant", "potato", "tomato"]);
});

test("样张 27 题:in a yard 只留 yard", () => {
  const r = extractCandidates("in a yard");
  assert.deepEqual(r.words.map((w) => w.lemma), ["yard"]);
});

test("样张 28 题:listen to music 只留 listen/music 且识别为词组", () => {
  const r = extractCandidates("listen to music");
  assert.deepEqual(r.words.map((w) => w.lemma).sort(), ["listen", "music"]);
  assert.deepEqual(r.phrases, ["listen to music"]);
});

test("样张 32 题:带标点的整句不误判为词组", () => {
  const r = extractCandidates("This is a map.");
  assert.deepEqual(r.words.map((w) => w.lemma), ["map"]);
  assert.deepEqual(r.phrases, []);
});

test("同一段里重复出现的词只算一次", () => {
  const r = extractCandidates("yard yard Yard yards");
  assert.equal(r.words.length, 1);
  assert.equal(r.words[0].lemma, "yard");
});

test("extraStopwords 生效", () => {
  const r = extractCandidates("happy birthday", { extraStopwords: ["happy"] });
  assert.deepEqual(r.words.map((w) => w.lemma), ["birthday"]);
});

test("uniqueWords 按 lemma 去重", () => {
  const r = uniqueWords([{ word: "photos" }, { word: "photo" }, { word: "maps", lemma: "map" }]);
  assert.deepEqual(r.map((x) => x.lemma), ["photo", "map"]);
});
