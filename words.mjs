/**
 * 文本 → 生词候选:切词、规范化、停用词过滤、轻度词形还原、词组识别。
 *
 * 设计要点(依据样本实测决策):
 * - 拖选/照片里拿到的常是句子或短语,直接入库会把 to/the/a 这类功能词灌满库 → 必须过滤停用词。
 * - 词形还原只做保守规则(复数/过去式/现在分词),不引入词典依赖;还原结果与原型都存在库里。
 * - 明显不是生词的标签类词(Tel/E-mail 等)走 NOT_WORDS 黑名单,P4 再叠加词表校验。
 */

/** 功能词:不作为生词入库(用户可在设置里追加,见 config.extraStopwords) */
export const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "so", "if", "then", "than", "as", "because", "while", "when",
  "where", "why", "how", "what", "which", "who", "whom", "whose", "that", "this", "these", "those",
  "there", "here", "is", "am", "are", "was", "were", "be", "been", "being", "do", "does", "did",
  "done", "have", "has", "had", "having", "will", "would", "shall", "should", "can", "could", "may",
  "might", "must", "not", "no", "yes", "of", "in", "on", "at", "to", "for", "from", "by", "with",
  "about", "into", "over", "under", "after", "before", "up", "down", "out", "off", "again", "very",
  "too", "also", "just", "only", "all", "any", "both", "each", "few", "more", "most", "other",
  "some", "such", "own", "same", "i", "you", "he", "she", "it", "we", "they", "me", "him", "her",
  "us", "them", "my", "your", "his", "its", "our", "their", "mine", "yours", "hers", "ours",
  "theirs", "myself", "yourself", "himself", "herself", "itself", "ourselves", "themselves", "s",
  "t", "re", "ve", "ll", "d", "m", "let", "get", "got", "one", "two",
]);

/** 非词汇:印刷体但不是生词(样张里 Tel:/E-mail: 就是这类),避免污染库 */
export const NOT_WORDS = new Set([
  "tel", "telephone", "email", "e", "fax", "http", "https", "www", "com", "cn", "net", "org",
  "mr", "mrs", "ms", "dr", "unit", "starter", "section", "page", "grade", "class", "name", "date",
  "time", "score", "total", "answer", "answers", "question", "questions", "word", "words",
  "english", "chinese", "reading", "listening", "writing", "speaking", "exercise", "exercises",
]);

/**
 * 例外表:形态规则会算错的常见词直接钉死。
 * 复数规则没有词典就无法百分百正确(house→houses 与 bus→buses 形式上无法区分),
 * 所以宁可保守 + 例外表,也不引入词表依赖。
 */
const LEMMA_EXCEPTIONS = new Map([
  ["shoes", "shoe"], ["toes", "toe"], ["houses", "house"], ["buses", "bus"], ["phrases", "phrase"],
  ["cases", "case"], ["noses", "nose"], ["roses", "rose"], ["courses", "course"], ["horses", "horse"],
  ["purses", "purse"], ["nurses", "nurse"], ["causes", "cause"], ["uses", "use"], ["cheeses", "cheese"],
  ["series", "series"], ["species", "species"], ["movies", "movie"], ["cookies", "cookie"],
  ["pies", "pie"], ["ties", "tie"], ["lies", "lie"], ["dies", "die"],
]);

/** 这些词以 s 结尾但不是复数,原样保留 */
const NOT_PLURAL = new Set([
  "bus", "glass", "grass", "class", "dress", "address", "business", "illness", "happiness", "news",
  "series", "species", "physics", "maths", "politics", "this", "his", "us", "yes", "plus", "campus",
  "always", "perhaps", "across", "because",
]);

/** 去掉首尾非字母,内部保留连字符与撇号 */
export function trimToken(raw) {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/^[^A-Za-z]+/, "")
    .replace(/[^A-Za-z'’-]+$/, "")
    .replace(/^['’-]+|['’-]+$/g, "");
}

/**
 * 保守词形还原:只处理最常见的复数/第三人称单数/过去式/现在分词。
 * 拿不准就原样返回(宁可多存一个形态,也不要把 business 还原成 busines)。
 */
export function lemmaOf(word) {
  const w = word.toLowerCase();
  if (w.length < 4) return w;
  if (LEMMA_EXCEPTIONS.has(w)) return LEMMA_EXCEPTIONS.get(w);
  if (NOT_PLURAL.has(w)) return w;
  if (STOPWORDS.has(w) || NOT_WORDS.has(w)) return w;

  const stripIfWord = (candidate) => (candidate.length >= 3 ? candidate : w);

  // 复数 / 第三人称单数
  if (w.endsWith("ies") && w.length > 4) return stripIfWord(`${w.slice(0, -3)}y`);
  // tomatoes / potatoes / heroes / goes:词干以 o 结尾时去掉 es
  if (/oes$/.test(w) && w.length > 4) return stripIfWord(w.slice(0, -2));
  // glasses / dishes / watches / boxes:去 es;house→houses 是单 s,不会命中这里,走下面的普通 -s
  if (/(ss|sh|ch|x|z)es$/.test(w) && w.length > 4) return stripIfWord(w.slice(0, -2));
  if (w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us") && !w.endsWith("is")) {
    return stripIfWord(w.slice(0, -1));
  }
  // 过去式 / 过去分词
  if (w.endsWith("ied") && w.length > 4) return stripIfWord(`${w.slice(0, -3)}y`);
  if (w.endsWith("ed") && w.length > 4) {
    const base = w.slice(0, -2);
    const undoubled = /([bdfglmnprt])\1$/.test(base) ? base.slice(0, -1) : base;
    if (undoubled.endsWith("e") || undoubled.length >= 3) return stripIfWord(undoubled);
    return stripIfWord(`${undoubled}e`);
  }
  // 现在分词
  if (w.endsWith("ing") && w.length > 5) {
    const base = w.slice(0, -3);
    const undoubled = /([bdfglmnprt])\1$/.test(base) ? base.slice(0, -1) : base;
    if (undoubled.length >= 3) return stripIfWord(undoubled);
    return stripIfWord(`${base}e`);
  }
  return w;
}

/** 一个 token 是否值得作为生词候选 */
export function isCandidate(word, extraStopwords) {
  if (!word || word.length < 2) return false;
  const lower = word.toLowerCase();
  if (STOPWORDS.has(lower) || NOT_WORDS.has(lower)) return false;
  if (extraStopwords && extraStopwords.has(lower)) return false;
  if (/^\d+$/.test(lower)) return false;
  return true;
}

/**
 * 从一段文字里抽出生词候选。
 * @returns {{words: Array<{word:string, lemma:string}>, phrases: string[], dropped: string[]}}
 *   words 按 lemma 去重(保留首次出现的原形),phrases 为 2~5 词的完整短语, dropped 为被过滤掉的词(诊断用)
 */
export function extractCandidates(text, options = {}) {
  const extraStopwords = options.extraStopwords instanceof Set
    ? options.extraStopwords
    : new Set(Array.isArray(options.extraStopwords) ? options.extraStopwords.map((s) => String(s).toLowerCase()) : []);
  const maxPhraseWords = Number.isFinite(options.maxPhraseWords) ? options.maxPhraseWords : 5;

  const raw = typeof text === "string" ? text : "";
  const clean = raw.replace(/[\r\n\t]+/g, " ").trim();
  const matches = clean.match(/[A-Za-z][A-Za-z'’-]*/g) || [];

  const words = [];
  const dropped = [];
  const seen = new Set();
  for (const m of matches) {
    const word = trimToken(m).toLowerCase();
    if (!word) continue;
    if (!isCandidate(word, extraStopwords)) {
      dropped.push(word);
      continue;
    }
    const lemma = lemmaOf(word);
    if (seen.has(lemma)) continue;
    seen.add(lemma);
    words.push({ word, lemma });
  }

  // 词组:整段本身就是 2~maxPhraseWords 个词的短语(不含句子标点),且至少一个非停用词
  const phrases = [];
  const isShort = matches.length >= 2 && matches.length <= maxPhraseWords && !/[.!?;:]/.test(clean);
  if (isShort && words.length > 0) {
    const normalized = matches.map((m) => trimToken(m).toLowerCase()).filter(Boolean).join(" ");
    if (normalized) phrases.push(normalized);
  }

  return { words, phrases, dropped };
}

/** 从候选里生成待翻译词表(去重、去空) */
export function uniqueWords(list) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    const word = trimToken(String(item && item.word ? item.word : item)).toLowerCase();
    if (!word) continue;
    const lemma = item && item.lemma ? item.lemma : lemmaOf(word);
    if (seen.has(lemma)) continue;
    seen.add(lemma);
    out.push({ word, lemma });
  }
  return out;
}
