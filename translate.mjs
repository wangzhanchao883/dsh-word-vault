/**
 * 批量翻译:走 ctx.llm.stream(插件自带模型调用能力,不需要开对话)。
 *
 * 一次调用翻一整批词,返回 {term: {phonetic, pos, meaning}}。
 * 失败不抛给上层:返回空 Map,调用方仍会只存词形(释义留空,稍后可补翻)。
 */
import { randomUUID } from "node:crypto";

export const PLUGIN_SOURCE = { kind: "plugin", plugin: "dsh-word-vault" };

/**
 * 消息构造:优先用官方 createUserMessage(带稳定 MessageId 与冻结),
 * 如果插件目录里没有 @deepseek-ai/dsh-llm(未装依赖),退化成等价结构,
 * 保证录入/翻译链路不会因为一个可选依赖缺失而整体瘫痪。
 */
let cachedFactory;
async function loadFactory() {
  if (cachedFactory !== undefined) return cachedFactory;
  try {
    const mod = await import("@deepseek-ai/dsh-llm");
    cachedFactory = typeof mod.createUserMessage === "function" ? mod.createUserMessage : null;
  } catch {
    cachedFactory = null;
  }
  return cachedFactory;
}

export async function createUserMsg(text) {
  const factory = await loadFactory();
  const content = [{ type: "text", text }];
  if (factory) return factory({ content, source: PLUGIN_SOURCE });
  return { id: randomUUID(), role: "user", content, source: PLUGIN_SOURCE };
}

/** 构造翻译提示词:要求严格 JSON,方便解析;严禁编造音标(拿不准留空) */
export function buildTranslatePrompt(words) {
  const list = words.map((w) => w.term || w).join("\n");
  return [
    "你是英语词典编辑。为下面每个英文单词/短语给出中文释义。",
    "要求:",
    "1. 只输出 JSON 数组,不要任何解释文字、不要 markdown 代码块。",
    '2. 每项形如 {"term":"单词(原样小写)","phonetic":"/音标/","pos":"词性缩写如 n./v./adj./adv./prep./phr.","meaning":"中文释义,多个义项用;分隔,不超过12字"}',
    "3. phonetic 拿不准就留空字符串,绝不编造。",
    "4. 短语给整体释义,pos 用 phr.。",
    "5. term 必须与输入完全一致(小写)。",
    "",
    "单词列表:",
    list,
  ].join("\n");
}

/** 宽松解析:容忍代码块围栏、前后废话、单对象包裹 */
export function parseTranslateOutput(text) {
  if (typeof text !== "string" || !text.trim()) return [];
  let s = text.trim();
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  const start = s.indexOf("[");
  const end = s.lastIndexOf("]");
  if (start >= 0 && end > start) s = s.slice(start, end + 1);
  let data;
  try {
    data = JSON.parse(s);
  } catch {
    // 退而求其次:逐行找 JSON 对象
    const out = [];
    for (const line of text.split(/\r?\n/)) {
      const a = line.indexOf("{");
      const b = line.lastIndexOf("}");
      if (a >= 0 && b > a) {
        try {
          out.push(JSON.parse(line.slice(a, b + 1)));
        } catch {
          /* 跳过坏行 */
        }
      }
    }
    return out;
  }
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.words)) return data.words;
  if (data && typeof data === "object") return [data];
  return [];
}

/** 流式取回完整文本(记忆卡生成模块也复用它) */
export async function collectText(llm, options, signal) {
  // 翻译 / 出卡 / 出题都是"照规则干活",不需要思考链。
  // 实测教训(2026-09-16):宿主模型带推理(High)时,推理 token 会挤占 maxTokens,
  // 6 个词 4500 预算被推理吃光 -> JSON 没输出 -> 全部报"模型未返回该词";
  // 而且推理明显更慢。DSH 支持 off|low|high|max,这里默认 off,调用方可用 options.reasoningEffort 覆盖。
  const opts = options && options.reasoningEffort ? options : { ...options, reasoningEffort: "off" };
  let out = "";
  for await (const chunk of llm.stream({ ...opts, signal })) {
    if (!chunk || typeof chunk !== "object") continue;
    if (chunk.type === "text-delta" && typeof chunk.text === "string") out += chunk.text;
    if (chunk.type === "finish" && chunk.reason && chunk.reason.kind === "error") {
      const failure = chunk.reason.failure;
      throw new Error(`llm finish error: ${failure && failure.code ? failure.code : "unknown"}`);
    }
  }
  return out;
}

/**
 * 批量翻译。
 *
 * 实测教训(2026-09-16):之前是"整批一次调用,失败就整批丢"——照片整批录入时出现过
 * 两批共 51 个词全部没释义(调用异常被静默吞掉),卡都出不了。所以现在:
 *   ① 分批(默认 12 个/次),一批失败不牵连其它批;
 *   ② 未返回的词**再重试一轮**(窄批次,成功率高);
 *   ③ 返回值里带上 missing,调用方能看到"还没翻译成功的词"。
 *
 * @param {{llm:any, provider:string, model:string, words:Array<{term:string}>, signal?:AbortSignal,
 *          logger?:any, batchSize?:number}} args
 * @returns {Promise<Map<string,{phonetic:string,pos:string,meaning:string}>>}
 */
export async function translateWords({ llm, provider, model, words, signal, logger, batchSize = 12 }) {
  const result = new Map();
  const list = [
    ...new Set(
      (Array.isArray(words) ? words : [])
        .map((w) => String(w && w.term ? w.term : w).trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  if (!list.length) return result;
  if (!llm || typeof llm.stream !== "function") {
    if (logger) logger.warn("dsh-word-vault: ctx.llm 不可用,跳过翻译(只记词形)");
    return result;
  }

  const size = Math.max(1, Math.min(30, Number(batchSize) || 12));
  const chunk = (arr) => {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  };

  const ask = async (terms) => {
    const raw = await collectText(
      llm,
      {
        provider,
        model,
        messages: [await createUserMsg(buildTranslatePrompt(terms))],
        maxTokens: Math.min(4000, 140 * terms.length + 300),
      },
      signal,
    );
    for (const item of parseTranslateOutput(raw)) {
      const term = String(item && item.term ? item.term : "").trim().toLowerCase();
      if (!term) continue;
      result.set(term, {
        phonetic: String(item.phonetic || ""),
        pos: String(item.pos || ""),
        meaning: String(item.meaning || ""),
      });
    }
  };

  for (const part of chunk(list)) {
    try {
      await ask(part);
    } catch (err) {
      if (logger) logger.warn(`dsh-word-vault: 翻译调用失败(${part.length} 词) - ${err && err.message ? err.message : err}`);
    }
  }

  // 未返回的词重试一轮:一次调用失败/被截断不该让整批词丢掉释义
  const missing = list.filter((t) => !result.has(t));
  if (missing.length) {
    if (logger) logger.info(`dsh-word-vault: 翻译重试 ${missing.length} 个未返回的词`);
    for (const part of chunk(missing)) {
      try {
        await ask(part);
      } catch (err) {
        if (logger) logger.warn(`dsh-word-vault: 翻译重试失败(${part.length} 词) - ${err && err.message ? err.message : err}`);
      }
    }
  }

  const stillMissing = list.filter((t) => !result.has(t));
  if (logger) {
    logger.info(
      `dsh-word-vault: 翻译 ${result.size}/${list.length} 条` +
        (stillMissing.length ? `,未成功 ${stillMissing.length} 个:${stillMissing.slice(0, 8).join(",")}${stillMissing.length > 8 ? "…" : ""}` : ""),
    );
  }
  return result;
}
