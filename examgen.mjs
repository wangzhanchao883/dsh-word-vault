/**
 * P3 出题:含该词的英文句子 + 单独问那个词 + 四个有迷惑性的中文选项。
 *
 * 用户三条硬要求(2026-09-16):
 *   ① 题干是**包含该词的英文句子**,再单独问这个词是什么意思
 *      例:Nice to meet you. 句中的 meet 是什么意思？
 *   ② ABCD 的正确答案要**错开**:按位置配额均衡分配(不是"随机后碰巧全是 B")
 *   ③ 干扰项要有**迷惑性**:同词性、同语义场,靠常识排除不掉
 *
 * 句子来源:优先用录词时复制下来的原文(events.context),缺了才让模型写。
 * 干扰项来源:同库同词性的其他词义优先,不足由模型补齐。
 */
import { collectText, createUserMsg } from "./translate.mjs";

/** 可复现的伪随机(mulberry32):同一个种子 → 同一份卷子,便于测试与复现 */
export function makeRng(seed = 20260916) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle(list, rng) {
  const arr = [...list];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * 位置配额均衡的答案序列:先按 0,1,2,3 循环铺满,再洗牌,最后打散"连续同一位置"的段。
 * 保证 count=20 时 A/B/C/D 各 5 次(而不是靠随机)。
 */
export function allocateAnswerPositions(count, rng) {
  const n = Math.max(0, Number(count) || 0);
  const base = [];
  for (let i = 0; i < n; i++) base.push(i % 4);
  const arr = shuffle(base, rng);
  // 打散连续 3 个以上同位置(影响观感,也便于孩子不会"连蒙三题同一个位置")
  for (let i = 2; i < arr.length; i++) {
    if (arr[i] === arr[i - 1] && arr[i] === arr[i - 2]) {
      for (let j = i + 1; j < arr.length; j++) {
        if (arr[j] !== arr[i]) {
          [arr[i], arr[j]] = [arr[j], arr[i]];
          break;
        }
      }
    }
  }
  return arr;
}

/** 句子是否"含有该词"(容忍常见屈折: +s/+es/+ed/+ing/去 e+ing/双写+ing) */
export function sentenceHasWord(sentence, word) {
  const w = String(word || "").toLowerCase();
  if (!w) return false;
  const forms = new Set([w, `${w}s`, `${w}es`, `${w}ed`, `${w}ing`, `${w}d`]);
  if (w.endsWith("e")) forms.add(`${w.slice(0, -1)}ing`);
  if (/[^aeiou][aeiou][^aeiouwxy]$/.test(w)) forms.add(`${w}${w.slice(-1)}ing`);
  if (w.endsWith("y")) forms.add(`${w.slice(0, -1)}ies`);
  const text = String(sentence || "").toLowerCase();
  for (const f of forms) {
    if (new RegExp(`(^|[^a-z])${f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`).test(text)) return true;
  }
  return false;
}

/** 清掉句子首尾的对话破折号/项目符号/多余空白(从剪贴板原文里捡出来的常见噪声) */
export function cleanSentence(input) {
  return String(input == null ? "" : input)
    .replace(/\s+/g, " ")
    .replace(/^[\s\-–—•*·>»"“'‘]+/, "")
    .replace(/[\s]+$/, "")
    .trim();
}

/**
 * 句子质量门槛:必须像"一句话",不能只是那个词本身。
 * 实测踩过:录词时复制的 context 可能是裸词("entities")或短标签,出成题就是
 * "句中的 entity 是什么意思？句子:entities" 这种废题。
 */
export function looksLikeSentence(text, minWords = 3, minLen = 8) {
  const s = cleanSentence(text);
  if (s.length < minLen) return false;
  const words = s.split(/\s+/).filter((w) => /[A-Za-z]/.test(w));
  if (words.length < minWords) return false;
  return true;
}

/** 从 context 里挑出一句含该词的英文句子(录词原文优先) */
export function extractSentenceFromContext(context, word) {
  const raw = String(context || "").replace(/\s+/g, " ").trim();
  if (!raw) return null;
  const parts = raw.split(/(?<=[.!?;])\s+/).map((s) => cleanSentence(s)).filter(Boolean);
  const pool = parts.length ? parts : [cleanSentence(raw)];
  const hits = pool.filter((s) => sentenceHasWord(s, word) && looksLikeSentence(s));
  if (!hits.length) {
    // 退化:整段里含该词也行(取整段,别切碎),但要求不太长
    const whole = cleanSentence(raw);
    if (sentenceHasWord(whole, word) && looksLikeSentence(whole) && whole.length <= 160) return whole;
    return null;
  }
  // 取最短的一句(通常是词表/短句),但至少要有一定长度
  hits.sort((a, b) => a.length - b.length);
  const pick = hits.find((s) => s.length >= 12) || hits[0];
  return pick.length > 200 ? `${pick.slice(0, 197)}…` : pick;
}

/** 释义拆成义项变体(处理"马铃薯;土豆"这种多义项),用于查重 */
export function meaningVariants(text) {
  return String(text == null ? "" : text)
    .split(/[;；,，、/／|]/)
    .map((s) => s.replace(/[\s()（）\[\]【】]/g, "").trim())
    .filter(Boolean);
}

/**
 * 两个释义是否"撞义":义项完全相同,或一个包含另一个(如「土豆」与「马铃薯;土豆」)。
 * 这是防止出现两个都对/明显重复的选项 —— 只比字符串相等会漏掉多义项写法。
 */
export function meaningsConflict(a, b) {
  const A = meaningVariants(a);
  const B = meaningVariants(b);
  for (const x of A) {
    for (const y of B) {
      if (x === y) return true;
      if (x.length >= 2 && y.length >= 2 && (x.includes(y) || y.includes(x))) return true;
    }
  }
  return false;
}

/**
 * 选考哪些词。
 * @param {{db:any, queryWords:Function, userId:number, scope:object, count:number, recheckRatio:number}} args
 */
export function pickExamWords({ db, queryWords, userId, scope = {}, count = 10, recheckRatio = 0.1 }) {
  const base = queryWords(db, {
    userId,
    kind: "word",
    since: scope.since,
    until: scope.until,
    minCount: scope.minCount,
    maxCount: scope.maxCount,
    status: scope.status && scope.status !== "all" ? scope.status : undefined,
    orderBy: scope.orderBy || "stale",
    limit: 2000,
  });
  // 排除词(垃圾词/专名等):用户可点名不要考
  const exclude = new Set(
    (Array.isArray(scope.excludeWords) ? scope.excludeWords : String(scope.excludeWords || "").split(/[\s,，、]+/))
      .map((w) => String(w).trim().toLowerCase())
      .filter(Boolean),
  );
  const usable = exclude.size ? base.filter((r) => !exclude.has(String(r.lemma).toLowerCase())) : base;
  const learning = usable.filter((r) => r.status !== "mastered");
  const mastered = usable.filter((r) => r.status === "mastered");

  const rng = makeRng(scope.seed || 20260916);
  // 明确指定 status='mastered' 时,已学会词就是**主池**(用于专项复查),不再当抽样
  if (scope.status === "mastered") {
    const primary = shuffle(mastered, rng).slice(0, count);
    return {
      picked: primary.map((row) => ({ row, recheck: true })),
      pool: { learning: learning.length, mastered: mastered.length, matched: usable.length, excluded: base.length - usable.length },
      recheckRatio: 1,
    };
  }

  const wantRecheck = scope.includeMastered === false
    ? 0
    : Math.min(mastered.length, Math.max(1, Math.round(count * recheckRatio)));
  const recheck = shuffle(mastered, rng).slice(0, wantRecheck);
  const recheckIds = new Set(recheck.map((r) => r.id));

  const primary = shuffle(learning.filter((r) => !recheckIds.has(r.id)), rng).slice(0, Math.max(0, count - recheck.length));
  const picked = shuffle([...primary.map((r) => ({ row: r, recheck: false })), ...recheck.map((r) => ({ row: r, recheck: true }))], rng);
  return {
    picked,
    pool: { learning: learning.length, mastered: mastered.length, matched: usable.length, excluded: base.length - usable.length },
    recheckRatio,
  };
}

/** 同库同词性的其他词义(干扰项优先来源) */
export function libraryDistractorPool(db, userId, pos, excludeLemma) {
  const rows = db
    .prepare(
      `SELECT w.lemma, d.meaning, d.pos FROM words w JOIN dict d ON d.term = w.lemma
       WHERE w.user_id = ? AND w.kind = 'word' AND w.lemma <> ? AND d.meaning <> ''`,
    )
    .all(userId, String(excludeLemma || "").toLowerCase());
  const norm = (p) => String(p || "").toLowerCase().replace(/[.\s]/g, "");
  const wantPos = norm(pos);
  const samePos = [];
  const others = [];
  const seen = new Set();
  for (const r of rows) {
    const m = String(r.meaning).trim();
    if (!m || seen.has(m)) continue;
    seen.add(m);
    (wantPos && norm(r.pos) === wantPos ? samePos : others).push({ word: r.lemma, meaning: m, pos: r.pos });
  }
  return { samePos, others };
}

/** 出题提示词 */
export function buildExamPrompt(items, opts = {}) {
  const payload = items.map((it) => ({
    word: it.word,
    pos: it.pos || "",
    meaning: it.meaning || "",
    ...(it.sentence ? { given_sentence: it.sentence } : {}),
  }));
  return [
    "你是英语老师，出一份「英译汉」单选题。考点是：给出一个**含该词的英文句子**，再单独问这个词在这句里是什么意思。",
    "",
    "=== 每题要产出 ===",
    '{"word":"原词小写","sentence":"一句含该词的英文句子","distractors":["错误释义1","错误释义2","错误释义3"],"pos":"词性缩写"}',
    "",
    "=== 句子规则 ===",
    "S1. 如果给了 given_sentence，就**原样沿用**，不要改写。",
    "S2. 没给就自己写一句：**必须原样出现这个单词**，≤12 个英文单词，内容用学生熟悉的场景（学校、家里、食堂、操场、宠物）。",
    "    只能加常见后缀（-s/-es/-ed/-ing）；**不许换成派生词**：health 不能写成 healthy，kind 不能写成 kindness，",
    "    eight 不能写成 eighteen。",
    '    正例: health → "Good health comes from sleep and vegetables."   eight → "I get up at eight every morning."',
    '    反例: health → "Eating well keeps you healthy."（句子里没有出现 health）',
    "S3. 句子要能体现该词在这个语境里的**具体词义**，不要写成词典例句般的空话。",
    "",
    "=== 干扰项规则（决定这份卷子有没有用）===",
    "D1. 给 3 个**错误的中文释义**，必须与正确答案**同词性、同语义场**，看起来都像对的。",
    '    例: 考 meet(v. 遇见) → 好的干扰项:"错过" / "送别" / "邀请"；坏的是:"苹果" / "蓝色的" / "跑得快"',
    '    例: 考 tomato(n. 西红柿) → 好的干扰项:"土豆" / "黄瓜" / "辣椒"；坏的是:"吃" / "厨房" / "好吃"',
    "D2. 干扰项**不能**与正确答案同义或近义到无法区分（不能出现两个都对的选项）。",
    "    正确答案若用分号列出多个义项（如「马铃薯;土豆」），干扰项**不能**出现其中任何一项（「土豆」也不行）。",
    "D3. 三个干扰项之间也不能重复或近义。",
    "D4. 干扰项只写释义本身，不要带词性、不要带英文、不要带解释。",
    "",
    "=== 输出格式 ===",
    "只输出 JSON 数组，不要解释文字、不要 markdown 代码块。顺序与输入一致。",
    "",
    "单词列表(JSON):",
    JSON.stringify(payload),
    opts.libraryHint ? `\n可参考的同类词义(库内,可选作干扰项素材):${JSON.stringify(opts.libraryHint)}` : "",
  ].join("\n");
}

/** 宽松解析 */
export function parseExamOutput(text) {
  if (typeof text !== "string" || !text.trim()) return [];
  let s = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  const a = s.indexOf("[");
  const b = s.lastIndexOf("]");
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  try {
    const data = JSON.parse(s);
    return Array.isArray(data) ? data : data && Array.isArray(data.questions) ? data.questions : [];
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

/** 选项展示用:义项最多留 2 个(避免正确答案比干扰项长一截、被一眼认出) */
export function trimMeaning(text, maxVariants = 2) {
  const parts = String(text == null ? "" : text).split(/[;；]/).map((s) => s.trim()).filter(Boolean);
  if (parts.length <= maxVariants) return String(text == null ? "" : text).trim();
  return parts.slice(0, maxVariants).join(";");
}

/**
 * 组装一道题:句子(原文优先) + 干扰项(库内同词性优先,模型补齐) + 位置由调用方给定。
 * @returns {{ok:boolean, question?:object, issues:string[]}}
 */
export function composeQuestion({ item, raw, answerIndex, pool, rng }) {
  const issues = [];
  const word = clean(item.word).toLowerCase();
  const correct = trimMeaning(clean(item.meaning));
  if (!correct) issues.push("该词没有释义(先补翻译再出题)");

  // 句子:原文优先 → 模型句 → 都不可用则不合格
  let sentence = cleanSentence(item.sentence);
  let sentenceSrc = sentence ? "context" : "";
  if (sentence && !sentenceHasWord(sentence, word)) {
    issues.push("给定的原文句子里没有该词,已弃用");
    sentence = "";
    sentenceSrc = "";
  }
  if (!sentence) {
    const m = cleanSentence(raw && raw.sentence);
    if (m && sentenceHasWord(m, word)) {
      sentence = m;
      sentenceSrc = "llm";
    } else {
      issues.push("缺少包含该词的句子");
    }
  }

  // 干扰项:先用库内同词性词义(最多 2 个),再用模型补
  const take = [];
  const takeSources = [];
  const pushDistractor = (text, src) => {
    const t = trimMeaning(clean(text));
    if (!t) return false;
    if (meaningsConflict(correct, t)) return false;        // 不能与正确答案撞义
    if (take.some((x) => meaningsConflict(x, t))) return false; // 干扰项之间也不能撞义
    take.push(t);
    takeSources.push(src);
    return true;
  };
  const poolSame = shuffle(pool.samePos || [], rng);
  for (const cand of poolSame) {
    if (take.length >= 2) break;
    pushDistractor(cand.meaning, "library");
  }
  const modelDistractors = Array.isArray(raw && raw.distractors) ? raw.distractors : [];
  for (const d of modelDistractors) {
    if (take.length >= 3) break;
    pushDistractor(d, "llm");
  }
  // 还差 → 用库内其它词义兜底(宁可词性不同,也不要凑不满 4 个选项)
  if (take.length < 3) {
    for (const cand of shuffle(pool.others || [], rng)) {
      if (take.length >= 3) break;
      pushDistractor(cand.meaning, "library-other");
    }
  }
  if (take.length < 3) issues.push(`干扰项不足(只有 ${take.length} 个)`);
  if (!sentence || !correct) return { ok: false, issues };

  const options = [...take];
  options.splice(answerIndex, 0, correct);
  return {
    ok: true,
    question: {
      word,
      sentence,
      sentenceSrc,
      correctMeaning: correct,
      options,
      answerIndex,
      optionSources: (() => {
        const src = [...takeSources];
        src.splice(answerIndex, 0, "correct");
        return src;
      })(),
      issues,
    },
  };
}

/** 补句子:只针对"模型写的句子不含原词"的失败,来一次窄指令调用(成功率很高) */
export function buildSentenceRepairPrompt(words) {
  return [
    "给下面每个英语单词各写一句英文句子，只为补句子，不要做别的。",
    "硬要求:",
    "1. 句子里必须**原样出现这个词**（只允许加 -s / -es / -ed / -ing 后缀）；",
    "   **不许用派生词替换**：health 不能写成 healthy，kind 不能写成 kindness，eight 不能写成 eighteen。",
    "2. 每句 5~10 个英文单词，用学生熟悉的场景。",
    '3. 只输出 JSON 数组，形如 [{"word":"health","sentence":"..."}]，顺序与输入一致，不要解释。',
    "",
    "单词列表(JSON):",
    JSON.stringify(words.map((w) => (typeof w === "string" ? w : w.word))),
  ].join("\n");
}

/** 从补句子的输出里取回 word → sentence */
export function parseSentenceRepair(text, wanted) {
  const out = new Map();
  for (const it of parseExamOutput(text)) {
    const w = clean(it && it.word).toLowerCase();
    const s = clean(it && it.sentence);
    if (!w || !s) continue;
    if (Array.isArray(wanted) && wanted.length && !wanted.includes(w)) continue;
    out.set(w, s);
  }
  return out;
}

/**
 * 出题主流程。
 * @param {{llm:any, provider:string, model:string, db:any, queryWords:Function, userId:number,
 *          scope:object, count:number, recheckRatio?:number, batchSize?:number, logger?:any,
 *          signal?:AbortSignal, existingSentences?:Function}} args
 */
export async function generateExam({
  llm, provider, model, db, queryWords, userId, scope = {}, count = 10,
  recheckRatio = 0.1, batchSize = 6, logger, signal, findSentence,
}) {
  const rng = makeRng(scope.seed || 20260916);
  const picked = pickExamWords({ db, queryWords, userId, scope, count, recheckRatio });
  if (!picked.picked.length) {
    return { questions: [], failures: [], pool: picked.pool, reason: "这个范围里没有可考的词" };
  }

  // 组题素材:原文句子 + 释义
  const items = picked.picked.map(({ row, recheck }) => {
    const sentence = findSentence ? findSentence(row) : "";
    return {
      word: row.lemma,
      meaning: row.card_meaning || row.meaning || "",
      pos: row.card_pos || row.pos || "",
      sentence: sentence || "",
      row,
      recheck,
    };
  });

  const positions = allocateAnswerPositions(items.length, rng);
  const questions = [];
  let failures = [];
  const rawMap = new Map(); // word → 第一轮模型给的原句/干扰项,补句子后还要复用
  const okWords = new Set();

  const size = Math.max(1, Math.min(12, Number(batchSize) || 6));
  for (let i = 0; i < items.length; i += size) {
    const batch = items.slice(i, i + size);
    let parsed = [];
    if (llm && typeof llm.stream === "function") {
      try {
        const prompt = buildExamPrompt(batch, {
          libraryHint: (() => {
            const pool = libraryDistractorPool(db, userId, batch[0].pos, batch[0].word);
            return pool.samePos.slice(0, 8).map((x) => x.meaning);
          })(),
        });
        const text = await collectText(
          llm,
          { provider, model, messages: [await createUserMsg(prompt)], maxTokens: Math.min(6000, 500 * batch.length + 300), temperature: 0.7 },
          signal,
        );
        parsed = parseExamOutput(text);
      } catch (err) {
        if (logger) logger.warn(`dsh-word-vault: 出题调用失败 - ${err && err.message ? err.message : err}`);
      }
    }
    const byWord = new Map(parsed.map((p) => [clean(p && p.word).toLowerCase(), p]));
    for (const [k, v] of byWord) rawMap.set(k, v);

    for (const item of batch) {
      const idx = items.indexOf(item);
      const pool = libraryDistractorPool(db, userId, item.pos, item.word);
      const composed = composeQuestion({ item, raw: byWord.get(item.word), answerIndex: positions[idx], pool, rng });
      if (composed.ok) {
        questions.push({ ...composed.question, wordId: item.row.id, isRecheck: item.recheck, pos: item.pos || (byWord.get(item.word) || {}).pos || "" });
        okWords.add(item.word);
      } else {
        failures.push({ word: item.word, reasons: composed.issues });
      }
    }
  }

  // 补句子重试:实测最常见的失败是"模型把词换成了派生词"(health→healthy),窄指令再问一次成功率很高
  const sentenceFails = failures.filter((f) => f.reasons.some((r) => r.includes("缺少包含该词的句子")));
  if (sentenceFails.length && llm && typeof llm.stream === "function") {
    const wanted = sentenceFails.map((f) => f.word);
    let repaired = new Map();
    try {
      const text = await collectText(
        llm,
        {
          provider,
          model,
          messages: [await createUserMsg(buildSentenceRepairPrompt(wanted))],
          maxTokens: 1500,
          temperature: 0.5,
        },
        signal,
      );
      repaired = parseSentenceRepair(text, wanted);
    } catch (err) {
      if (logger) logger.warn(`dsh-word-vault: 补句子调用失败 - ${err && err.message ? err.message : err}`);
    }
    const stillFailing = [];
    for (const f of sentenceFails) {
      const item = items.find((it) => it.word === f.word);
      const s = repaired.get(f.word);
      if (item && s && sentenceHasWord(s, item.word)) {
        const idx = items.indexOf(item);
        const pool = libraryDistractorPool(db, userId, item.pos, item.word);
        const composed = composeQuestion({
          item: { ...item, sentence: s },
          raw: rawMap.get(f.word),
          answerIndex: positions[idx],
          pool,
          rng,
        });
        if (composed.ok) {
          questions.push({ ...composed.question, wordId: item.row.id, isRecheck: item.recheck, pos: item.pos });
          okWords.add(item.word);
          if (logger) logger.info(`dsh-word-vault: 补句子救回 ${item.word}`);
          continue;
        }
        stillFailing.push({ word: f.word, reasons: composed.issues });
      } else {
        stillFailing.push({ word: f.word, reasons: [...f.reasons, "补句子仍未包含原词"] });
      }
    }
    // 非句子类失败原样保留
    failures = failures.filter((f) => !f.reasons.some((r) => r.includes("缺少包含该词的句子"))).concat(stillFailing);
  }

  // 保序输出(与选词顺序一致),便于试卷与位置分布可预期
  questions.sort((a, b) => items.findIndex((i) => i.word === a.word) - items.findIndex((i) => i.word === b.word));

  if (logger) {
    logger.info(`dsh-word-vault: 出题 ${questions.length}/${items.length} 道,不合格 ${failures.length},候选池 ${JSON.stringify(picked.pool)}`);
  }
  return { questions, failures, pool: picked.pool, recheckRatio };
}

/** 可打印试卷 HTML(题目页 + 答案页分开) */
export function buildPaperHtml({ sessionId, title = "英语单词测验", subtitle = "", questions = [], includeAnswers = false }) {
  const esc = (v) => String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const LETTERS = ["A", "B", "C", "D"];
  const cards = questions
    .map((q, i) => {
      const opts = (q.options || [])
        .map((o, oi) => `<div class="opt"><b>${LETTERS[oi]}.</b> ${esc(o)}</div>`)
        .join("");
      return `<div class="q">
  <div class="stem"><span class="no">${i + 1}.</span> <span class="sent">${esc(q.sentence)}</span></div>
  <div class="ask">句中的 <b>${esc(q.word)}</b> 是什么意思？${q.isRecheck ? ' <span class="rc">(复查)</span>' : ""}</div>
  <div class="opts">${opts}</div>
  <div class="blank">答案：____________</div>
</div>`;
    })
    .join("\n");

  const answerRows = includeAnswers
    ? `<h2>参考答案</h2><table class="key"><tr><th>题号</th><th>单词</th><th>正确答案</th><th>释义</th></tr>${questions
        .map((q, i) => `<tr><td>${i + 1}</td><td>${esc(q.word)}</td><td>${LETTERS[q.answerIndex]}</td><td>${esc(q.correctMeaning)}</td></tr>`)
        .join("")}</table>`
    : "";

  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(title)}</title><style>
@page { size: A4; margin: 12mm; }
* { box-sizing: border-box; }
body { font-family: "Microsoft YaHei","微软雅黑",sans-serif; color: #1b2a3a; margin: 0; }
h1 { font-size: 16pt; margin: 0 0 2mm 0; border-bottom: 1.4pt solid #1b2a3a; padding-bottom: 1.5mm; }
h1 small { font-size: 9pt; font-weight: 400; color: #7a8b9c; margin-left: 3mm; }
.tip { font-size: 9pt; color: #5c6f82; margin: 0 0 4mm 0; }
.q { border: 1pt solid #cfdbe6; border-radius: 2mm; padding: 2.6mm 3.2mm; margin-bottom: 3mm; page-break-inside: avoid; }
.stem { font-size: 11pt; font-family: "Segoe UI", Arial, sans-serif; }
.no { font-weight: 700; color: #1f5a94; }
.ask { font-size: 10pt; margin: 1.2mm 0 1.6mm 0; color: #23313f; }
.rc { color: #c0392b; font-size: 8.5pt; }
.opts { display: flex; flex-wrap: wrap; gap: 2mm 6mm; font-size: 10pt; }
.opt { min-width: 40mm; }
.opt b { color: #1f5a94; }
.blank { margin-top: 1.6mm; font-size: 9pt; color: #8798a8; }
table.key { border-collapse: collapse; font-size: 10pt; margin-top: 3mm; }
table.key th, table.key td { border: 0.8pt solid #9fb3c6; padding: 1.2mm 3mm; text-align: left; }
</style></head><body>
<h1>${esc(title)}<small>${esc(subtitle)}</small></h1>
<div class="tip">共 ${questions.length} 题。每题给出一个含该词的英文句子，请选出该词在句中的正确中文释义。</div>
${cards}
${answerRows}
</body></html>`;
}
