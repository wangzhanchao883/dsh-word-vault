/**
 * 记忆卡内容生成:让 LLM 为每个词产出「拆解块(segs) + 一句荒诞梗(story) + 音标/词性/释义」。
 *
 * 方法论照搬 workbuddy 专家包 funny-word-cards:
 *   · 定位铁律:这是**拼写提取辅助**,不是词义教学;卡片永远保留正确音标与拼写,绝不为梗牺牲读音
 *   · 拆解三法:谐音拆(主力) / 词根·合成拆 / 拼写对比法(短词专用)
 *   · 短词(≤4 字母)严禁硬凑谐音(house→"豪斯"这种记不住还污染发音),改用"只差一个字母"锚点
 *   · 梗四判据:① 拆完能看见画面 ② 挂回单词本义 ③ 用学生熟悉的场景 ④ 尽量时新
 *   · 禁用:万能恋爱鸡汤、只有语气词、病痛/死亡/灾难暗黑梗、任何贬低学习者的话
 *   · 梗句一句话说完,40 字以内;宁可短而狠
 *
 * 代码侧硬校验(不信模型的自述):
 *   · segs 顺序拼接必须**恰好等于原词**(忽略大小写/空白),否则该词标记为不合格,可一键重做
 *   · 音标必须形如 /.../,否则清空(宁缺勿造)
 *   · story 超长则截断并在失败项里记录
 */
import { collectText, createUserMsg } from "./translate.mjs";

export const CARD_SYSTEM_HINT = "英语记忆卡设计师:谐音拆词 + 一句荒诞梗钉住拼写";

/** 构造一批词的提示词 */
export function buildCardPrompt(items) {
  const payload = (Array.isArray(items) ? items : []).map((it) => ({
    word: String(it.word || "").toLowerCase(),
    ...(it.meaning ? { known_meaning: it.meaning } : {}),
    ...(it.phonetic ? { known_phonetic: it.phonetic } : {}),
  }));
  return [
    "你是英语记忆卡设计师。为下面每个单词设计「拆解块」和「一句荒诞梗」，用来钉住拼写。",
    "",
    "=== 拆解块规则(最重要,违反即废) ===",
    "A. segs 必须按**读音音节**切块，每块 2~4 个字母，整词 2~4 块。",
    "B. **严禁逐字母硬拆**：绝大多数块都是单字母 = 不合格。",
    '   反例(不合格): map → m摸 / a啊 / p铺        health → h喝 / e鹅 / a啊 / l乐 / t踢 / h好',
    '   正例(合格):   tomato → to特 / ma马 / to头     potato → po破 / ta塔 / to头',
    '                hamburger → ham汉 / bur饱 / ger哥  interesting → in因 / te特 / res热 / ting听',
    "C. 每块配 1 个汉字音(最多 2 个)，必须**贴近该块的真实读音**；宁可少拆不要硬凑。",
    "D. 3~4 个字母的短词通常拆不出好谐音：**走拼写对比法**——segs 只给 2 块以内，",
    '   把「只差一个字母」的对比写进 story(例：house 房子 / horse 马 只差一个字母)。',
    "",
    "=== 荒诞句规则 ===",
    "E. 一句话说完，**40 字以内**，必须能看见一个画面，并且挂回单词本义。",
    "F. 用学生熟悉的场景(游戏/食堂/同学/家长钱包/校园日常)；荒诞但不丧、好笑但不低俗。",
    "G. 禁用:万能恋爱鸡汤、只有语气词的梗、病痛/死亡/灾难等暗黑梗、任何贬低学习者的话。",
    "",
    "=== 其他 ===",
    "H. 只输出 JSON 数组，不要解释文字、不要 markdown 代码块。",
    'I. 每项格式:{"word":"原词小写","phonetic":"/音标/","pos":"词性缩写","meaning":"中文释义(不超过12字)","segs":[{"en":"字母片段","cn":"中文音"}],"story":"一句话荒诞梗"}',
    "J. segs 的 en 按顺序拼接必须**恰好等于原词**(不能多字母、不能少字母、不能改字母)。",
    "K. 音标拿不准就留空字符串，**绝不编造**；若给了 known_phonetic/known_meaning 就沿用。",
    "L. word 必须与输入完全一致(小写)。",
    "",
    "单词列表(JSON):",
    JSON.stringify(payload),
  ].join("\n");
}

/** 宽松解析:容忍代码块围栏/前后废话/逐行对象 */
export function parseCardOutput(text) {
  if (typeof text !== "string" || !text.trim()) return [];
  let s = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  const a = s.indexOf("[");
  const b = s.lastIndexOf("]");
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  try {
    const data = JSON.parse(s);
    return Array.isArray(data) ? data : data && Array.isArray(data.cards) ? data.cards : data && typeof data === "object" ? [data] : [];
  } catch {
    const out = [];
    for (const line of text.split(/\r?\n/)) {
      const i = line.indexOf("{");
      const j = line.lastIndexOf("}");
      if (i >= 0 && j > i) {
        try {
          out.push(JSON.parse(line.slice(i, j + 1)));
        } catch {
          /* 跳过坏行 */
        }
      }
    }
    return out;
  }
}

const clean = (v) => String(v == null ? "" : v).trim();

/**
 * 校验并修正一张卡。
 * 硬失败(hardFail,必须重做): 拆解拼不回原词、缺拆解、缺梗句
 * 质量告警(qualityIssues,先重试一次;仍不合格也保留卡片但标记 low):
 *   · 逐字母硬拆(单字母块占比 ≥ 50% 且块数 ≥ 3)
 *   · 拆解块过多(> 4)
 *   · 中文音过长(> 2 字)
 * @returns {{ok:boolean, low:boolean, card:object, issues:string[], qualityIssues:string[]}}
 */
export function validateCard(raw, expectedWord) {
  const issues = [];
  const qualityIssues = [];
  const word = clean(raw && raw.word).toLowerCase() || String(expectedWord || "").toLowerCase();
  const segs = (Array.isArray(raw && raw.segs) ? raw.segs : [])
    .map((s) => ({ en: clean(s && s.en), cn: clean(s && s.cn) }))
    .filter((s) => s.en && s.cn);

  const joined = segs.map((s) => s.en).join("").toLowerCase();
  if (!segs.length) issues.push("缺少拆解块");
  else if (joined !== word) issues.push(`拆解拼接为 "${joined}"，与原词 "${word}" 不一致`);

  if (segs.length) {
    const singles = segs.filter((s) => s.en.length === 1).length;
    if (segs.length > 4) qualityIssues.push(`拆解块过多(${segs.length} 块),应控制在 2~4 块`);
    if (segs.length >= 3 && singles / segs.length >= 0.5) {
      qualityIssues.push(`疑似逐字母硬拆(${singles}/${segs.length} 块是单字母),应按音节切块`);
    }
    const longCn = segs.filter((s) => s.cn.length > 2).length;
    if (longCn) qualityIssues.push(`有 ${longCn} 个中文音超过 2 字`);
  }

  let phonetic = clean(raw && raw.phonetic);
  if (phonetic && !/^\/.*\/$/.test(phonetic)) {
    issues.push("音标格式不合法,已清空");
    phonetic = "";
  }

  let story = clean(raw && raw.story);
  if (story.length > 60) {
    issues.push("梗句超过 60 字,已截断");
    story = `${story.slice(0, 58)}…`;
  }
  if (!story) issues.push("缺少荒诞句");

  const card = {
    word,
    phonetic,
    pos: clean(raw && raw.pos),
    meaning: clean(raw && raw.meaning),
    segs,
    story,
  };
  const hardFail = !card.segs.length || joined !== word || !story;
  return {
    ok: !hardFail,
    low: !hardFail && qualityIssues.length > 0,
    card,
    issues: [...issues, ...qualityIssues],
    qualityIssues,
  };
}

/**
 * 批量生成记忆卡内容。
 * @param {{llm:any, provider:string, model:string, items:Array<{word,meaning?,phonetic?}>, batchSize?:number, logger?:any, signal?:AbortSignal, retryBad?:boolean}} args
 * @returns {Promise<{cards:Array, failures:Array<{word:string, reasons:string[]}>, model:string}>}
 */
export async function generateCards({ llm, provider, model, items, batchSize = 8, logger, signal, retryBad = true }) {
  const cards = [];
  const failures = [];
  const lowQuality = [];
  const list = (Array.isArray(items) ? items : []).filter((it) => it && it.word);
  if (!list.length) return { cards, failures, lowQuality, model };
  if (!llm || typeof llm.stream !== "function") {
    return { cards, failures: list.map((it) => ({ word: it.word, reasons: ["ctx.llm 不可用"] })), lowQuality, model };
  }

  const size = Math.max(1, Math.min(20, Number(batchSize) || 8));
  const batches = [];
  for (let i = 0; i < list.length; i += size) batches.push(list.slice(i, i + size));

  const askOnce = async (batch, extraHint) => {
    const prompt = buildCardPrompt(batch) + (extraHint ? `\n\n上一次的问题，请特别注意:\n${extraHint}` : "");
    const raw = await collectText(
      llm,
      {
        provider,
        model,
        messages: [await createUserMsg(prompt)],
        // 预算要给足:宿主的模型可能带推理(reasoning),推理 token 也算在 maxTokens 里,
      // 预算太小会把 JSON 挤掉,表现就是"模型未返回该词"(实测 6 词 4500 全部失败)
      maxTokens: Math.min(16000, 2500 * batch.length + 2000),
        temperature: 0.9,
      },
      signal,
    );
    return parseCardOutput(raw);
  };

  /**
   * 调一次,失败了就**对半拆开**再各试一次。
   * 为什么:实测宿主的模型调用偶发失败(超时/截断/限流),整批丢会让用户看到"卡片少了很多"
   * 却不知道原因;拆半重试能把大部分词救回来,救不回的才记失败。
   */
  const askBatchResilient = async (batch) => {
    const isEmpty = (list) => !Array.isArray(list) || list.length === 0;
    try {
      const parsed = await askOnce(batch, "");
      // 调用没抛错但一个词都没解析出来 = 同样失败(实测:模型返回的形状不被接受时会这样),
      // 必须走拆半重试,否则用户看到的就是"6 个词全部 模型未返回该词"
      if (!isEmpty(parsed)) return { parsed, error: "" };
      if (logger) logger.warn(`dsh-word-vault: 记忆卡批次解析为空(${batch.length} 词),拆半重试`);
      if (batch.length <= 1) {
        const again = await askOnce(batch, "");
        return { parsed: again, error: isEmpty(again) ? "模型返回内容无法解析" : "" };
      }
      const half = Math.ceil(batch.length / 2);
      const out = [];
      for (const part of [batch.slice(0, half), batch.slice(half)]) {
        try {
          out.push(...(await askOnce(part, "")));
        } catch (err2) {
          if (logger) logger.warn(`dsh-word-vault: 半批失败 - ${err2 && err2.message ? err2.message : err2}`);
        }
      }
      return { parsed: out, error: out.length ? "" : "模型返回内容无法解析" };
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      if (logger) logger.warn(`dsh-word-vault: 记忆卡批次失败(${batch.length} 词),拆半重试 - ${msg}`);
      if (batch.length <= 1) {
        try {
          return { parsed: await askOnce(batch, ""), error: "" };
        } catch (err2) {
          return { parsed: [], error: err2 && err2.message ? err2.message : String(err2) };
        }
      }
      const half = Math.ceil(batch.length / 2);
      const parts = [batch.slice(0, half), batch.slice(half)];
      const out = [];
      let lastErr = msg;
      for (const part of parts) {
        try {
          out.push(...(await askOnce(part, "")));
        } catch (err2) {
          lastErr = err2 && err2.message ? err2.message : String(err2);
          if (logger) logger.warn(`dsh-word-vault: 记忆卡半批仍失败(${part.length} 词) - ${lastErr}`);
        }
      }
      return { parsed: out, error: lastErr };
    }
  };

  for (const batch of batches) {
    const asked = await askBatchResilient(batch);
    const parsed = asked.parsed;
    const callError = asked.error;
    const byWord = new Map(parsed.map((p) => [clean(p && p.word).toLowerCase(), p]));
    const bad = []; // 硬失败 或 质量不合格 → 都值得重试一次
    for (const item of batch) {
      const key = String(item.word).toLowerCase();
      const raw = byWord.get(key);
      if (!raw) {
        // 调用失败时把**真实错误**带上(否则界面只显示"生成失败",没法排查)
        failures.push({ word: key, reasons: [callError ? `模型调用失败:${callError}` : "模型未返回该词"] });
        continue;
      }
      const v = validateCard(raw, key);
      if (v.ok && !v.low) cards.push({ ...v.card, issues: v.issues, low: false });
      else bad.push({ item, raw, v });
    }

    /** 收尾:硬失败记为失败;质量不合格保留卡片但打 low 标记(不丢词) */
    const settle = (b, v) => {
      const key = String(b.item.word).toLowerCase();
      if (v.ok) {
        cards.push({ ...v.card, issues: v.issues, low: v.low });
        if (v.low) lowQuality.push({ word: key, issues: v.qualityIssues });
        return;
      }
      // 重试反而把硬约束搞坏了 → 退回第一次的结果(只要它可用)
      if (b.v.ok) {
        cards.push({ ...b.v.card, issues: b.v.issues, low: b.v.low });
        if (b.v.low) lowQuality.push({ word: key, issues: b.v.qualityIssues });
        return;
      }
      failures.push({ word: key, reasons: v.issues });
    };

    if (bad.length && retryBad) {
      try {
        const retryParsed = await askOnce(
          bad.map((b) => b.item),
          bad.map((b) => `- ${b.item.word}: ${b.v.issues.join("；")}`).join("\n"),
        );
        const retryMap = new Map(retryParsed.map((p) => [clean(p && p.word).toLowerCase(), p]));
        for (const b of bad) {
          const key = String(b.item.word).toLowerCase();
          const raw2 = retryMap.get(key) || b.raw;
          settle(b, validateCard(raw2, key));
        }
      } catch (err) {
        for (const b of bad) settle(b, b.v);
        if (logger) logger.warn(`dsh-word-vault: 记忆卡重试失败 - ${err && err.message ? err.message : err}`);
      }
    } else {
      for (const b of bad) settle(b, b.v);
    }
  }

  if (logger) {
    logger.info(
      `dsh-word-vault: 记忆卡生成 ${cards.length}/${list.length} 张,不合格 ${failures.length},质量待改 ${lowQuality.length}`,
    );
  }
  return { cards, failures, lowQuality, model };
}
