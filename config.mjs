/**
 * 配置默认值与归一化。
 *
 * 铁律:任何可调参数都不硬编码在业务逻辑里——全部经 Schemastery schema + settings 命名空间暴露,
 * 判断标准是「cordis.yml / 设置页能不能改」。本文件只放默认值与合并校验。
 *
 * 录入架构(2026-09-16 定案):用户照常 Ctrl+C,常驻助手只读剪贴板 → 入默认库 → 浮窗可改库/撤销。
 * 不做全局热键、不注入按键、不写剪贴板(跨进程写剪贴板会互锁)。
 */

export const DEFAULT_CONFIG = {
  /** 总开关:关掉后不落库、不起助手进程,工具返回停用说明 */
  enabled: true,
  /** SQLite 库文件路径(沿用用户既有 英语趣味单词 目录约定) */
  dbPath: "D:\\workout\\AI助理\\英语趣味单词\\单词库\\words.db",
  /** 记忆卡词表 JSON 目录(与 workbuddy 专家包同一约定) */
  wordsDir: "D:\\workout\\AI助理\\英语趣味单词\\words",
  /** 产物输出目录(记忆卡 HTML/PDF/Word) */
  outputDir: "D:\\workout\\AI助理\\英语趣味单词\\输出",
  /** 剪贴板截图落盘目录(拍照/截图通道用) */
  imageDir: "D:\\workout\\AI助理\\英语趣味单词\\截图",
  /** 拍照识别(P4):照片目录、裁剪产物目录与判据参数 */
  photo: {
    /** 你往里丢照片的目录(可在设置页改);也可以直接在对话里发照片 */
    dir: "D:\\workout\\AI助理\\英语趣味单词\\拍照",
    /** 裁剪块与联络图落盘目录 */
    outDir: "D:\\workout\\AI助理\\英语趣味单词\\拍照处理",
    /** 是否递归子目录 */
    recursive: true,
    /** 已处理的照片是否保留逐块裁剪 PNG(联络图总是保留) */
    keepCrops: true,
    /** 掩码:算作"标记墨迹"的最低饱和度(荧光笔/红笔都是饱和色,铅笔手写不饱和) */
    satMin: 40,
    /** 裁剪时上方多留多少像素(红线/红圈在词的下方或四周,必须把词带进来) */
    padUp: 30,
    /** 单个裁剪块的最大高度 */
    maxCropH: 160,
    /** 裁剪块内印刷黑字至少要占多少比例的列(剔除空白边距与插图) */
    minDarkSpread: 0.45,
    /** 每次最多处理几张新照片(防止一次丢 50 张把时间拉满) */
    maxPerRun: 8,
  },
  /** 翻译/生成用的提供方与模型 */
  provider: "deepseek-official",
  model: "deepseek-v4-flash",
  /** 录入时是否立刻调模型翻译(关掉则只记词形,稍后用工具补翻译) */
  autoTranslate: true,
  /** 录入用户列表与默认归属(Ctrl+C 自动进默认库) */
  users: [
    { name: "用户1", enabled: true },
    { name: "用户2", enabled: true },
  ],
  defaultUser: "用户1",
  /** 切词规则 */
  words: {
    /** 追加的停用词(除内置表之外) */
    extraStopwords: [],
    /** 是否把 2~5 词的整条短语另存为「词组」条目 */
    keepPhrases: true,
    /** 单次录入最多入库多少个词,防止误复制长文灌库 */
    maxWordsPerCapture: 30,
  },
  /** 高频词门槛:累计被录入(被标记)达到这个次数就算高频,查询/出片据此标记与筛选 */
  highFreqMin: 2,
  /** 常驻剪贴板助手 */
  helper: {
    enabled: true,
    /** 剪贴板轮询间隔(ms) */
    clipPollMs: 350,
    /** 少于这个长度忽略 */
    minLen: 2,
    /** 超过这个长度忽略(防长文灌库) */
    maxLen: 400,
    /** 复制后是否**自动**入默认库(默认 false:弹窗点选才入库,避免把普通复制当生词录进来) */
    autoCommit: false,
    /** 弹窗等待多久没人点就自动消失(ms;0=一直等) */
    promptTimeoutMs: 20000,
    /** 是否显示点选弹窗 */
    showDialog: true,
    /** 是否显示常驻小条(监听状态 + 今日累计) */
    showFloatWindow: true,
    /** 小条相对所在屏幕右上角的偏移(距右边缘 / 距顶部) */
    floatOffsetX: 40,
    floatOffsetY: 40,
    /** 小条是否自动淡化(鼠标移开后降低不透明度) */
    floatAutoHide: false,
    /** 是否把剪贴板里的图片也交给插件(拍照通道) */
    watchImages: true,
  },
  /** 每批入库后保留的日志条数上限(供 wordvault_status 回看) */
  logTail: 200,
  /** 记忆卡输出 */
  cards: {
    /** 卡片页眉主标题 */
    title: "趣味单词记忆卡",
    /** 页眉副标题(留空则自动写"用户 · N 词 · 拆词荒诞梗") */
    subtitle: "",
    /** 每次让模型处理多少个词(太大质量下降、太小费 token) */
    batchSize: 8,
  },
  /** 考试 */
  exam: {
    /** 默认出多少题 */
    count: 10,
    /** 已学会词的抽查比例(答错自动摘牌) */
    recheckRatio: 0.1,
    /** 答题服务空闲多久自动关闭(分钟) */
    minutes: 30,
    /** 出题时每次交给模型几个词 */
    batchSize: 6,
  },
};

/** 助手浮窗与状态文案(中文放配置里,ps1 保持纯 ASCII 源码) */
export const UI_TEXT = {
  // 常驻小条
  title: "生词库监听中",
  ready: "复制英文 → 弹窗点选入库",
  today: "今日累计 {0} 词",
  // 点选弹窗
  promptTitle: "生词入库 · 识别到 {0} 词",
  promptEmpty: "没识别到英文生词",
  promptMore: "…等 {0} 词",
  ignoreLabel: "忽略",
  pending: "处理中…",
  // 结果反馈
  okTitle: "✔ 已录入成功",
  okBody: "{0} 词 → {1}",
  okToday: "今日累计录入 {0} 词",
  failTitle: "✘ 录入失败",
  ignored: "已忽略,未入库",
  // 忽略原因(小条上显示)
  emptyMsg: "剪贴板没有文字",
  longMsg: "文本过长(像整篇文章)",
  noWordMsg: "没找到英文单词",
};

function pickString(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function pickBool(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function pickNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (min !== undefined && n < min) return min;
  if (max !== undefined && n > max) return max;
  return n;
}

/** 归一化一个用户条目;非法条目返回 null */
export function normalizeUser(raw) {
  if (!raw || typeof raw !== "object") return null;
  const name = pickString(raw.name, "");
  if (!name) return null;
  return { name, enabled: pickBool(raw.enabled, true) };
}

/** 把任意输入(插件 config / settings 扁平值)归一化成完整配置 */
export function resolveConfig(input = {}) {
  const src = input && typeof input === "object" ? input : {};
  const helperSrc = src.helper && typeof src.helper === "object" ? src.helper : {};
  const wordsSrc = src.words && typeof src.words === "object" ? src.words : {};
  const cardsSrc = src.cards && typeof src.cards === "object" ? src.cards : {};
  const examSrc = src.exam && typeof src.exam === "object" ? src.exam : {};
  const photoSrc = src.photo && typeof src.photo === "object" ? src.photo : {};

  const users = Array.isArray(src.users)
    ? src.users.map(normalizeUser).filter(Boolean)
    : DEFAULT_CONFIG.users.map((u) => ({ ...u }));
  const finalUsers = users.length ? users : DEFAULT_CONFIG.users.map((u) => ({ ...u }));
  const defaultUser = pickString(src.defaultUser, finalUsers[0].name);
  const knownDefault = finalUsers.some((u) => u.name === defaultUser) ? defaultUser : finalUsers[0].name;

  return {
    enabled: pickBool(src.enabled, DEFAULT_CONFIG.enabled),
    dbPath: pickString(src.dbPath, DEFAULT_CONFIG.dbPath),
    wordsDir: pickString(src.wordsDir, DEFAULT_CONFIG.wordsDir),
    outputDir: pickString(src.outputDir, DEFAULT_CONFIG.outputDir),
    imageDir: pickString(src.imageDir, DEFAULT_CONFIG.imageDir),
    provider: pickString(src.provider, DEFAULT_CONFIG.provider),
    model: pickString(src.model, DEFAULT_CONFIG.model),
    autoTranslate: pickBool(src.autoTranslate, DEFAULT_CONFIG.autoTranslate),
    users: finalUsers,
    defaultUser: knownDefault,
    words: {
      extraStopwords: Array.isArray(wordsSrc.extraStopwords)
        ? wordsSrc.extraStopwords.map((s) => String(s).toLowerCase()).filter(Boolean)
        : [],
      keepPhrases: pickBool(wordsSrc.keepPhrases, DEFAULT_CONFIG.words.keepPhrases),
      maxWordsPerCapture: pickNumber(wordsSrc.maxWordsPerCapture, DEFAULT_CONFIG.words.maxWordsPerCapture, 1, 500),
    },
    helper: {
      enabled: pickBool(helperSrc.enabled, DEFAULT_CONFIG.helper.enabled),
      clipPollMs: pickNumber(helperSrc.clipPollMs, DEFAULT_CONFIG.helper.clipPollMs, 100, 5000),
      minLen: pickNumber(helperSrc.minLen, DEFAULT_CONFIG.helper.minLen, 1, 100),
      maxLen: pickNumber(helperSrc.maxLen, DEFAULT_CONFIG.helper.maxLen, 10, 20000),
      autoCommit: pickBool(helperSrc.autoCommit, DEFAULT_CONFIG.helper.autoCommit),
      promptTimeoutMs: pickNumber(helperSrc.promptTimeoutMs, DEFAULT_CONFIG.helper.promptTimeoutMs, 0, 300000),
      showDialog: pickBool(helperSrc.showDialog, DEFAULT_CONFIG.helper.showDialog),
      showFloatWindow: pickBool(helperSrc.showFloatWindow, DEFAULT_CONFIG.helper.showFloatWindow),
      floatOffsetX: pickNumber(helperSrc.floatOffsetX, DEFAULT_CONFIG.helper.floatOffsetX, 0, 4096),
      floatOffsetY: pickNumber(helperSrc.floatOffsetY, DEFAULT_CONFIG.helper.floatOffsetY, 0, 4096),
      floatAutoHide: pickBool(helperSrc.floatAutoHide, DEFAULT_CONFIG.helper.floatAutoHide),
      watchImages: pickBool(helperSrc.watchImages, DEFAULT_CONFIG.helper.watchImages),
    },
    logTail: pickNumber(src.logTail, DEFAULT_CONFIG.logTail, 10, 5000),
    highFreqMin: pickNumber(src.highFreqMin, DEFAULT_CONFIG.highFreqMin, 1, 100),
    cards: {
      title: pickString(cardsSrc.title, DEFAULT_CONFIG.cards.title),
      subtitle: typeof cardsSrc.subtitle === "string" ? cardsSrc.subtitle.trim() : DEFAULT_CONFIG.cards.subtitle,
      batchSize: pickNumber(cardsSrc.batchSize, DEFAULT_CONFIG.cards.batchSize, 1, 20),
    },
    exam: {
      count: pickNumber(examSrc.count, DEFAULT_CONFIG.exam.count, 1, 100),
      recheckRatio: pickNumber(examSrc.recheckRatio, DEFAULT_CONFIG.exam.recheckRatio, 0, 1),
      minutes: pickNumber(examSrc.minutes, DEFAULT_CONFIG.exam.minutes, 1, 600),
      batchSize: pickNumber(examSrc.batchSize, DEFAULT_CONFIG.exam.batchSize, 1, 12),
    },
    photo: {
      dir: pickString(photoSrc.dir, DEFAULT_CONFIG.photo.dir),
      outDir: pickString(photoSrc.outDir, DEFAULT_CONFIG.photo.outDir),
      recursive: photoSrc.recursive === undefined ? DEFAULT_CONFIG.photo.recursive : !!photoSrc.recursive,
      keepCrops: photoSrc.keepCrops === undefined ? DEFAULT_CONFIG.photo.keepCrops : !!photoSrc.keepCrops,
      satMin: pickNumber(photoSrc.satMin, DEFAULT_CONFIG.photo.satMin, 5, 200),
      padUp: pickNumber(photoSrc.padUp, DEFAULT_CONFIG.photo.padUp, 0, 200),
      maxCropH: pickNumber(photoSrc.maxCropH, DEFAULT_CONFIG.photo.maxCropH, 40, 600),
      minDarkSpread: pickNumber(photoSrc.minDarkSpread, DEFAULT_CONFIG.photo.minDarkSpread, 0, 1),
      maxPerRun: pickNumber(photoSrc.maxPerRun, DEFAULT_CONFIG.photo.maxPerRun, 1, 50),
    },
  };
}

/**
 * 由配置生成给 PowerShell 助手的配置对象(键名与 ps1 一一对应)。
 * @param {object} config resolveConfig 的结果
 * @param {{queuePath:string,statusPath:string,resultPath:string,commandPath:string,triggerPath:string,debugPath:string}} paths
 * @param {boolean} debug
 */
export function helperConfig(config, paths, debug = false) {
  return {
    queuePath: paths.queuePath,
    statusPath: paths.statusPath,
    resultPath: paths.resultPath,
    commandPath: paths.commandPath,
    triggerPath: paths.triggerPath,
    debugPath: paths.debugPath,
    imageDir: config.helper.watchImages ? config.imageDir : "",
    /** 弹窗点选模式:上传文本后等 prompt 文件,不直接落库 */
    promptPath: paths.promptPath,
    promptMode: !config.helper.autoCommit && config.helper.showDialog,
    autoCommit: config.helper.autoCommit,
    defaultUser: config.defaultUser,
    promptTimeoutMs: config.helper.promptTimeoutMs,
    showDialog: config.helper.showDialog,
    clipPollMs: config.helper.clipPollMs,
    minLen: config.helper.minLen,
    maxLen: config.helper.maxLen,
    showFloatWindow: config.helper.showFloatWindow,
    floatOffsetX: config.helper.floatOffsetX,
    floatOffsetY: config.helper.floatOffsetY,
    floatAutoHide: config.helper.floatAutoHide,
    debug,
    ui: UI_TEXT,
    users: config.users.map((u) => ({ name: u.name, enabled: u.enabled })),
  };
}
