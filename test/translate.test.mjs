import { test } from "node:test";
import assert from "node:assert/strict";

import { translateWords, buildTranslatePrompt, parseTranslateOutput } from "../translate.mjs";

/** 假 LLM:可指定第几次调用抛错,其余调用按提示词里的词返回释义
 *  注意:翻译提示词里是**纯词表(每行一个词)**,不是 JSON —— 按测试词形 w01/w02… 提取。 */
function fakeLlm({ failCalls = [], partial = 0 } = {}) {
  let call = 0;
  return {
    stream(options) {
      call += 1;
      const prompt = JSON.stringify(options.messages);
      // 提示词被 JSON.stringify 后换行变成 \n,前一个字符是字母 n -> \b 词边界不成立,
      // 所以这里不能加 \b(否则一个都匹配不到);测试词形 w01/w02 在提示词里唯一,直接匹配即可。
      const words = [...new Set(prompt.match(/w\d{2}/g) || [])];
      const n = call;
      async function* gen() {
        if (failCalls.includes(n)) throw new Error(`mock failure on call ${n}`);
        const list = partial > 0 ? words.slice(0, partial) : words;
        yield { type: "text-delta", index: 0, text: JSON.stringify(list.map((w) => ({ term: w, phonetic: `/${w}/`, pos: "n.", meaning: `${w}义` }))) };
        yield { type: "finish", reason: { kind: "stop" } };
      }
      return gen();
    },
  };
}

const WORDS = (n) => Array.from({ length: n }, (_, i) => ({ term: `w${String(i + 1).padStart(2, "0")}` }));

test("翻译提示词与解析的基本契约", () => {
  const p = buildTranslatePrompt(["map", "river"]);
  assert.match(p, /map/);
  assert.match(p, /river/);
  assert.match(p, /term/);
  const parsed = parseTranslateOutput('[{"term":"map","meaning":"地图"}]');
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].meaning, "地图");
});

test("分批调用:某批彻底失败也不牵连其它批(实测过的整批丢词问题)", async () => {
  // 20 个词、每批 10:第 1 批失败,第 2 批成功 -> 至少拿到 10 个,而不是 0 个
  // 调用序:1=第1批(失败) 2=第2批(成功) 3=重试第1批(也失败) -> 只剩第2批的 10 个
  const llm = fakeLlm({ failCalls: [1, 3] });
  const map = await translateWords({ llm, provider: "p", model: "m", words: WORDS(20), batchSize: 10, logger: { info() {}, warn() {} } });
  assert.equal(map.size, 10, `应保住成功的那一批,实际 ${map.size}`);
  assert.equal(map.get("w20").meaning, "w20义");
});

test("未返回的词会重试一轮:首轮失败的那批被救回", async () => {
  // 20 个词、每批 10:第 1 批首轮失败 -> 重试成功 -> 20 个齐全
  const llm = fakeLlm({ failCalls: [1] });
  const map = await translateWords({ llm, provider: "p", model: "m", words: WORDS(20), batchSize: 10, logger: { info() {}, warn() {} } });
  assert.equal(map.size, 20, `重试后应补齐,实际 ${map.size}`);
});

test("模型只返回一部分时,重试补齐剩余(不会只拿一半就收工)", async () => {
  // 每次调用只回前 3 个词:8 个词分 2 批(4/批) -> 首轮 6 个 -> 重试补 2 个 -> 8 个
  const llm = fakeLlm({ partial: 3 });
  const map = await translateWords({ llm, provider: "p", model: "m", words: WORDS(8), batchSize: 4, logger: { info() {}, warn() {} } });
  assert.equal(map.size, 8, `重试后应补齐 8 个,实际 ${map.size}`);
});

test("ctx.llm 不可用/全程失败:返回空 map 且不抛异常", async () => {
  const none = await translateWords({ llm: null, provider: "p", model: "m", words: WORDS(3) });
  assert.equal(none.size, 0);
  const allFail = fakeLlm({ failCalls: [1, 2, 3, 4, 5, 6] });
  const map = await translateWords({ allFail, llm: allFail, provider: "p", model: "m", words: WORDS(4), batchSize: 2, logger: { info() {}, warn() {} } });
  assert.equal(map.size, 0);
});

test("重复词只翻一次", async () => {
  const llm = fakeLlm({});
  const map = await translateWords({ llm, provider: "p", model: "m", words: [{ term: "w01" }, { term: "W01" }, { term: " w01 " }], batchSize: 10 });
  assert.equal(map.size, 1);
});

test("模型调用默认关闭推理(实测:推理 token 会挤占输出预算且更慢)", async () => {
  const { collectText } = await import("../translate.mjs");
  const seen = [];
  const fakeLlm = {
    stream(options) {
      seen.push(options);
      async function* gen() {
        yield { type: "text-delta", index: 0, text: "ok" };
        yield { type: "finish", reason: { kind: "stop" } };
      }
      return gen();
    },
  };
  await collectText(fakeLlm, { provider: "p", model: "m", messages: [] });
  assert.equal(seen[0].reasoningEffort, "off", "默认应为 off");
  await collectText(fakeLlm, { provider: "p", model: "m", messages: [], reasoningEffort: "high" });
  assert.equal(seen[1].reasoningEffort, "high", "显式指定时应被尊重");
});
