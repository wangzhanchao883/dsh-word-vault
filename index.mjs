/**
 * dsh-word-vault —— 英语生词库(多用户)DSH 插件。
 *
 * P1 已交付:
 *   · 录入通道①:常驻助手监听剪贴板(用户照常 Ctrl+C,鼠标处弹窗点选归属;浮窗可改库/撤销)
 *   · 录入通道③:对话/斜杠场景下的 wordvault_add 工具(任何环境都能录,不依赖助手)
 *   · node:sqlite 落库 + LLM 批量翻译 + 词典缓存 + 维度查询统计
 *
 * P2 已交付:
 *   · 记忆卡内容生成(拆词 + 荒诞梗,照搬 workbuddy 专家包方法论)并落 cards 表
 *   · 出片:HTML / PDF(Edge headless) / Word(pandoc) + 首页预览 PNG
 *
 * 后续:P3 考试闭环 / P4 拍照通道 / P5 词库管理界面。
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";
import { dirname, join } from "node:path";

import { DEFAULT_CONFIG, resolveConfig } from "./config.mjs";
import {
  openDb,
  closeDb,
  ensureUser,
  listUsers,
  findUser,
  queryWords,
  stats,
  listCaptures,
  undoCapture,
  reassignCapture,
  upsertCard,
  cardStats,
  upsertDict,
} from "./db.mjs";
import { CaptureService } from "./capture.mjs";
import { generateCards } from "./cardgen.mjs";
import { exportCardSet } from "./cards.mjs";

export const name = "dsh-word-vault";
export const inject = ["tools"];

const SETTINGS_NS = "dsh-word-vault";

/**
 * 扁平 schema:settings 客户端的 set(field, value) 只支持单段路径,
 * 所以把 users / helper / words 拍平,host 侧再映射回插件结构。
 */
const settingsSchema = z.object({
  enabled: z.boolean().default(DEFAULT_CONFIG.enabled),
  dbPath: z.string().default(DEFAULT_CONFIG.dbPath),
  wordsDir: z.string().default(DEFAULT_CONFIG.wordsDir),
  outputDir: z.string().default(DEFAULT_CONFIG.outputDir),
  imageDir: z.string().default(DEFAULT_CONFIG.imageDir),
  provider: z.string().default(DEFAULT_CONFIG.provider),
  model: z.string().default(DEFAULT_CONFIG.model),
  autoTranslate: z.boolean().default(DEFAULT_CONFIG.autoTranslate),
  defaultUser: z.string().default(DEFAULT_CONFIG.defaultUser),
  users: z.array(z.object({
    name: z.string(),
    enabled: z.boolean().default(true),
  })).default([]),
  helperEnabled: z.boolean().default(DEFAULT_CONFIG.helper.enabled),
  /** 复制后是否自动入默认库(默认 false:弹窗点选才入库,避免把普通复制当生词录进来) */
  autoCommit: z.boolean().default(DEFAULT_CONFIG.helper.autoCommit),
  /** 弹窗等待多久没人点就自动消失(ms;0=一直等) */
  promptTimeoutMs: z.number().min(0).max(300000).default(DEFAULT_CONFIG.helper.promptTimeoutMs),
  showDialog: z.boolean().default(DEFAULT_CONFIG.helper.showDialog),
  clipPollMs: z.number().min(100).max(5000).default(DEFAULT_CONFIG.helper.clipPollMs),
  minLen: z.number().min(1).max(100).default(DEFAULT_CONFIG.helper.minLen),
  maxLen: z.number().min(10).max(20000).default(DEFAULT_CONFIG.helper.maxLen),
  showFloatWindow: z.boolean().default(DEFAULT_CONFIG.helper.showFloatWindow),
  floatOffsetX: z.number().min(0).max(4096).default(DEFAULT_CONFIG.helper.floatOffsetX),
  floatOffsetY: z.number().min(0).max(4096).default(DEFAULT_CONFIG.helper.floatOffsetY),
  floatAutoHide: z.boolean().default(DEFAULT_CONFIG.helper.floatAutoHide),
  watchImages: z.boolean().default(DEFAULT_CONFIG.helper.watchImages),
  keepPhrases: z.boolean().default(DEFAULT_CONFIG.words.keepPhrases),
  maxWordsPerCapture: z.number().min(1).max(500).default(DEFAULT_CONFIG.words.maxWordsPerCapture),
  extraStopwords: z.array(z.string()).default([]),
  cardsTitle: z.string().default(DEFAULT_CONFIG.cards.title),
  cardsSubtitle: z.string().default(DEFAULT_CONFIG.cards.subtitle),
  cardsBatchSize: z.number().min(1).max(20).default(DEFAULT_CONFIG.cards.batchSize),
});

/** 插件嵌套结构 → 扁平 settings 结构 */
function toFlat(config) {
  return {
    enabled: config.enabled,
    dbPath: config.dbPath,
    wordsDir: config.wordsDir,
    outputDir: config.outputDir,
    imageDir: config.imageDir,
    provider: config.provider,
    model: config.model,
    autoTranslate: config.autoTranslate,
    defaultUser: config.defaultUser,
    users: config.users ?? [],
    helperEnabled: config.helper.enabled,
    autoCommit: config.helper.autoCommit,
    promptTimeoutMs: config.helper.promptTimeoutMs,
    showDialog: config.helper.showDialog,
    clipPollMs: config.helper.clipPollMs,
    minLen: config.helper.minLen,
    maxLen: config.helper.maxLen,
    showFloatWindow: config.helper.showFloatWindow,
    floatOffsetX: config.helper.floatOffsetX,
    floatOffsetY: config.helper.floatOffsetY,
    floatAutoHide: config.helper.floatAutoHide,
    watchImages: config.helper.watchImages,
    keepPhrases: config.words.keepPhrases,
    maxWordsPerCapture: config.words.maxWordsPerCapture,
    extraStopwords: config.words.extraStopwords ?? [],
    cardsTitle: config.cards.title,
    cardsSubtitle: config.cards.subtitle,
    cardsBatchSize: config.cards.batchSize,
  };
}

/** 扁平 settings 结构 → 插件嵌套结构 */
function fromFlat(flat) {
  return resolveConfig({
    enabled: flat.enabled,
    dbPath: flat.dbPath,
    wordsDir: flat.wordsDir,
    outputDir: flat.outputDir,
    imageDir: flat.imageDir,
    provider: flat.provider,
    model: flat.model,
    autoTranslate: flat.autoTranslate,
    defaultUser: flat.defaultUser,
    users: flat.users,
    helper: {
      enabled: flat.helperEnabled,
      autoCommit: flat.autoCommit,
      promptTimeoutMs: flat.promptTimeoutMs,
      showDialog: flat.showDialog,
      clipPollMs: flat.clipPollMs,
      minLen: flat.minLen,
      maxLen: flat.maxLen,
      showFloatWindow: flat.showFloatWindow,
      floatOffsetX: flat.floatOffsetX,
      floatOffsetY: flat.floatOffsetY,
      floatAutoHide: flat.floatAutoHide,
      watchImages: flat.watchImages,
    },
    words: {
      keepPhrases: flat.keepPhrases,
      maxWordsPerCapture: flat.maxWordsPerCapture,
      extraStopwords: flat.extraStopwords,
    },
    cards: {
      title: flat.cardsTitle,
      subtitle: flat.cardsSubtitle,
      batchSize: flat.cardsBatchSize,
    },
  });
}

/** 统一走这个构造函数:纯文本工具(返回值即 JSON/文本,渲染为文本卡片) */
function textTool(definition) {
  return defineTool({
    ...definition,
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: value }],
    },
    presentCall: (args) => ({ card: "generic", kind: "text", title: definition.name, rawInput: args }),
  });
}

function json(value) {
  return JSON.stringify(value, null, 2);
}

export function apply(ctx, input = {}) {
  let liveConfig = resolveConfig(input);
  let db = null;
  let service = null;

  const runtimeDir = () => join(dirname(liveConfig.dbPath), "word-vault-runtime");

  /** 打开库并建用户(幂等) */
  const open = () => {
    if (db) return db;
    db = openDb(liveConfig.dbPath);
    for (const u of liveConfig.users) ensureUser(db, u.name, "", u.enabled);
    ensureUser(db, liveConfig.defaultUser, "", true);
    return db;
  };

  const stopService = () => {
    if (service) {
      try {
        service.dispose();
      } catch (err) {
        ctx.logger.warn(`dsh-word-vault: 助手停止失败 - ${err.message}`);
      }
      service = null;
    }
  };

  const startService = () => {
    stopService();
    const inst = new CaptureService({
      config: liveConfig,
      db: open(),
      logger: ctx.logger,
      getLlm: () => ctx.get("llm"),
      paths: { dir: runtimeDir() },
    });
    const dispose = inst.start();
    inst.dispose = dispose;
    service = inst;
    return inst;
  };

  // ---------------- 生命周期:注册即 effect,配置变化时重建助手 ----------------
  ctx.effect(() => {
    open();
    if (liveConfig.enabled) startService();
    return () => {
      stopService();
      if (db) {
        closeDb(db);
        db = null;
      }
    };
  });

  // ---------------- 设置命名空间:等 settings 服务就绪后注册 ----------------
  ctx.inject(["settings"], (settingsCtx) => {
    try {
      const scope = settingsCtx.settings.register(SETTINGS_NS, settingsSchema, { base: toFlat(liveConfig) });
      const resolved = scope.get();
      if (resolved) liveConfig = fromFlat(resolved);
      scope.watch((next) => {
        if (!next) return;
        liveConfig = fromFlat(next);
        if (liveConfig.enabled) startService();
        else stopService();
      });
    } catch (err) {
      ctx.logger.warn(`dsh-word-vault: 设置命名空间注册失败,使用传入配置:${err.message}`);
    }
  });

  // ---------------- 工具 1:录入(对话通道,不依赖助手) ----------------
  ctx.tools.register(textTool({
    name: "wordvault_add",
    description:
      "把一段英文文字里的生词录入指定用户的生词库:自动切词、去功能词、词形还原、LLM 翻译,并累加出现次数。用户在对话里贴词/句子时用它;录入完成后返回本次新增与重复的词条。",
    parameters: {
      text: { type: "string", description: "要录入的英文文字,可以是单词、多个单词、整句或整段" },
      user: { type: "string", description: "录入到哪个用户库,缺省用配置的默认用户(如 用户1)" },
      source: { type: "string", description: "来源说明,如 课本Unit3/试卷/对话,便于日后回溯" },
    },
    async execute(args, exec) {
      if (!liveConfig.enabled) return "插件已停用(enabled=false),未录入。";
      const text = String(args.text || "").trim();
      if (!text) return "缺少 text 参数。";
      open();
      if (!service) startService();
      const result = await service.ingest(text, {
        user: args.user || liveConfig.defaultUser,
        via: "manual",
        source: args.source || "dialog",
      });
      if (exec && exec.signal && exec.signal.aborted) return "已取消。";
      return json(result);
    },
  }));

  // ---------------- 工具 2:强制抓一次剪贴板 ----------------
  ctx.tools.register(textTool({
    name: "wordvault_capture_clipboard",
    description:
      "让常驻助手立刻抓取当前剪贴板内容并录入生词库(等价于用户复制一次文本)。助手未运行时返回失败说明。",
    parameters: {
      user: { type: "string", description: "录入到哪个用户库,缺省默认用户" },
    },
    async execute(args) {
      open();
      if (!service || !liveConfig.helper.enabled) return "剪贴板助手未启用(helperEnabled=false)。请改用 wordvault_add 直接录入。";
      const st = service.helperStatus();
      if (!st.ready) return `剪贴板助手未就绪:${st.note || "状态未知"}。请改用 wordvault_add。`;
      const r = service.requestCapture(args.user || liveConfig.defaultUser);
      return json({ ...r, note: "已请求助手抓取,约 1~3 秒后可用 wordvault_status 查看结果" });
    },
  }));

  // ---------------- 工具 3:按维度查词 ----------------
  ctx.tools.register(textTool({
    name: "wordvault_query",
    description:
      "按维度查询生词库:录入时间区间(since/until)、出现次数区间(minCount/maxCount)、已学会状态(status)、排序方式(orderBy: recent/count/oldest/alpha/stale)。返回词条、音标、释义、次数与时间。",
    parameters: {
      user: { type: "string", description: "用户库,缺省默认用户" },
      since: { type: "string", description: "起始时间(含),ISO 或 YYYY-MM-DD" },
      until: { type: "string", description: "结束时间(含),ISO 或 YYYY-MM-DD" },
      minCount: { type: "number", description: "最少出现过几次" },
      maxCount: { type: "number", description: "最多出现过几次" },
      status: { type: "string", enum: ["learning", "half", "mastered"], description: "掌握状态" },
      orderBy: { type: "string", enum: ["recent", "count", "oldest", "alpha", "stale"], description: "排序,缺省 recent" },
      limit: { type: "number", description: "返回条数,缺省 30" },
    },
    async execute(args) {
      open();
      const user = findUser(db, args.user || liveConfig.defaultUser);
      if (!user) return `没有这个用户:${args.user || liveConfig.defaultUser}`;
      const rows = queryWords(db, {
        userId: user.id,
        since: args.since,
        until: args.until,
        minCount: args.minCount,
        maxCount: args.maxCount,
        status: args.status,
        orderBy: args.orderBy || "recent",
        limit: args.limit || 30,
      });
      return json({
        user: user.name,
        count: rows.length,
        words: rows.map((r) => ({
          word: r.lemma,          // 词元(词典形),展示与背诵以它为准
          term: r.term,           // 最近一次录入时的原文形态
          kind: r.kind,
          phonetic: r.phonetic || "",
          pos: r.pos || "",
          meaning: r.meaning || "",
          seenCount: r.seen_count,
          status: r.status,
          streak: r.streak,
          firstSeenAt: r.first_seen_at,
          lastSeenAt: r.last_seen_at,
        })),
      });
    },
  }));

  // ---------------- 工具 4:库统计 + 助手状态 ----------------
  ctx.tools.register(textTool({
    name: "wordvault_status",
    description:
      "生词库整体状态:各用户词条数/已学会数/事件数/高频词,剪贴板助手是否在跑,以及最近几次录入日志。用于自检与排障。",
    parameters: {
      user: { type: "string", description: "只看某个用户,缺省默认用户" },
      logLimit: { type: "number", description: "返回最近几条日志,缺省 10" },
    },
    async execute(args) {
      open();
      const user = findUser(db, args.user || liveConfig.defaultUser);
      const allUsers = listUsers(db).map((u) => ({ id: u.id, name: u.name, enabled: !!u.enabled }));
      return json({
        dbPath: liveConfig.dbPath,
        runtimeDir: runtimeDir(),
        enabled: liveConfig.enabled,
        defaultUser: liveConfig.defaultUser,
        users: allUsers,
        stats: user ? stats(db, user.id) : null,
        cards: user ? cardStats(db, user.id) : null,
        recentCaptures: listCaptures(db, user ? user.id : null, 5).map((c) => ({
          id: c.id,
          user: c.user_id,
          via: c.via,
          itemCount: c.item_count,
          status: c.status,
          createdAt: c.created_at,
        })),
        helper: liveConfig.helper.enabled
          ? { ...(service ? service.helperStatus() : { ready: false, note: "服务未启动" }) }
          : { ready: false, note: "配置里已关闭" },
        log: service ? service.recentLog(args.logLimit || 10) : [],
      });
    },
  }));

  // ---------------- 工具 5:撤销 / 改库(对话兜底,浮窗按钮的等价物) ----------------
  ctx.tools.register(textTool({
    name: "wordvault_fix_last",
    description:
      "修正最近一次录入:action=undo 撤销整次录入(新建的词删除、重复次数回退);action=reassign 把整次录入改到另一个用户库。用于误录、录错用户。",
    parameters: {
      action: { type: "string", enum: ["undo", "reassign"], description: "撤销或改库" },
      user: { type: "string", description: "action=reassign 时的目标用户" },
      captureId: { type: "string", description: "指定某次抓取 id,缺省用最近一次" },
    },
    async execute(args) {
      open();
      const captureId = String(args.captureId || "").trim() || (service && service.lastCaptureId) || "";
      if (!captureId) return "没有可修正的录入记录(缺少 captureId,且本会话尚无录入)。";
      if (args.action === "undo") {
        const r = undoCapture(db, captureId);
        return json({ captureId, ...r });
      }
      if (args.action === "reassign") {
        const target = findUser(db, args.user);
        if (!target) return `没有这个用户:${args.user}`;
        const r = reassignCapture(db, captureId, target.id);
        return json({ captureId, ...r, toUser: target.name });
      }
      return "action 必须是 undo 或 reassign。";
    },
  }));

  // ---------------- P2 共用:按维度选词(带卡片状态) ----------------
  const CARD_FILTERS = {
    since: { type: "string", description: "起始时间(含),ISO 或 YYYY-MM-DD" },
    until: { type: "string", description: "结束时间(含),ISO 或 YYYY-MM-DD" },
    minCount: { type: "number", description: "最少出现过几次(高频不熟词用这个)" },
    maxCount: { type: "number", description: "最多出现过几次" },
    status: { type: "string", enum: ["learning", "half", "mastered"], description: "掌握状态" },
    orderBy: { type: "string", enum: ["recent", "count", "oldest", "alpha", "stale"], description: "排序,缺省 recent" },
    user: { type: "string", description: "用户库,缺省默认用户" },
  };

  const pickWordRows = (args, { onlyMissing = false, limit = 8 } = {}) => {
    const wanted = args.user || liveConfig.defaultUser;
    const user = findUser(db, wanted);
    if (!user) return { error: `没有这个用户:${wanted}` };
    let rows = queryWords(db, {
      userId: user.id,
      kind: "word",
      since: args.since,
      until: args.until,
      minCount: args.minCount,
      maxCount: args.maxCount,
      status: args.status,
      orderBy: args.orderBy || "count",
      limit: 2000,
    });
    if (args.words) {
      const want = new Set(
        String(args.words)
          .split(/[\s,，、]+/)
          .map((w) => w.trim().toLowerCase())
          .filter(Boolean),
      );
      rows = rows.filter((r) => want.has(r.lemma));
    }
    if (onlyMissing) rows = rows.filter((r) => !r.card_updated_at);
    const total = rows.length;
    return { user, rows: rows.slice(0, Math.max(1, limit)), total };
  };

  /** 生成并落库卡片内容(供两个工具复用) */
  const generateAndStore = async (rows, user, signal) => {
    const items = rows.map((r) => ({
      word: r.lemma,
      meaning: r.card_meaning || r.meaning || "",
      phonetic: r.card_phonetic || r.phonetic || "",
    }));
    const res = await generateCards({
      llm: ctx.get("llm"),
      provider: liveConfig.provider,
      model: liveConfig.model,
      items,
      batchSize: liveConfig.cards.batchSize,
      logger: ctx.logger,
      signal,
    });
    const byLemma = new Map(rows.map((r) => [r.lemma, r]));
    let stored = 0;
    for (const c of res.cards) {
      const row = byLemma.get(c.word);
      if (!row) continue;
      upsertCard(db, {
        userId: user.id,
        wordId: row.id,
        term: c.word,
        phonetic: c.phonetic,
        pos: c.pos,
        meaning: c.meaning,
        segs: c.segs,
        story: c.story,
        model: res.model || liveConfig.model,
        source: "llm",
      });
      // 词典缓存里缺的音标/释义顺手补上,查询与后续出片都能用
      if (!row.meaning || !row.phonetic) {
        upsertDict(db, [{
          term: c.word,
          kind: "word",
          phonetic: row.phonetic || c.phonetic,
          pos: row.pos || c.pos,
          meaning: row.meaning || c.meaning,
          source: "llm-card",
        }]);
      }
      stored += 1;
    }
    return { stored, failures: res.failures, model: res.model };
  };

  // ---------------- 工具 6:生成记忆卡内容(拆词 + 荒诞梗) ----------------
  ctx.tools.register(textTool({
    name: "wordvault_make_cards",
    description:
      "为生词生成记忆卡内容：拆解块(segs) + 一句荒诞梗(story) + 音标/词性/释义，存入本地卡片表。默认只处理还没有卡片的词；regenerate=true 全部重做；words 参数可只重做指定的几个词。",
    parameters: {
      ...CARD_FILTERS,
      limit: { type: "number", description: "本次最多生成多少张,缺省 8" },
      regenerate: { type: "boolean", description: "true=已有卡片也重新生成(默认 false,只补缺的)" },
      words: { type: "string", description: "只处理这些词(逗号/空格分隔),用于只重做某几个词" },
    },
    async execute(args, exec) {
      open();
      if (!liveConfig.enabled) return "插件已停用(enabled=false)。";
      const picked = pickWordRows(args, { onlyMissing: !args.regenerate, limit: args.limit || 8 });
      if (picked.error) return picked.error;
      if (!picked.rows.length) {
        return json({
          ok: true,
          user: picked.user.name,
          generated: 0,
          message: args.regenerate ? "没有匹配的词" : "这些词的卡片都已经有了(要重做请传 regenerate=true)",
          cardStats: cardStats(db, picked.user.id),
        });
      }
      const gen = await generateAndStore(picked.rows, picked.user, exec && exec.signal);
      return json({
        ok: true,
        user: picked.user.name,
        requested: picked.rows.length,
        matchedTotal: picked.total,
        generated: gen.stored,
        failed: gen.failures,
        model: gen.model,
        cardStats: cardStats(db, picked.user.id),
        hint: gen.failures.length ? "不合格的词可用 words 参数单独重做" : undefined,
      });
    },
  }));

  // ---------------- 工具 7:出片(HTML / PDF / Word) ----------------
  ctx.tools.register(textTool({
    name: "wordvault_export_cards",
    description:
      "把选定范围的生词导成可打印的趣味单词记忆卡：HTML / PDF / Word 三选或全出(默认全出)，并生成首页预览图供排版自检。每页 8 张卡(2 列×4 行)、A4。缺卡片的词会自动先生成内容(可关闭)。",
    parameters: {
      ...CARD_FILTERS,
      limit: { type: "number", description: "最多出多少张卡,缺省 32" },
      format: { type: "string", enum: ["all", "html", "pdf", "word"], description: "输出格式,缺省 all" },
      title: { type: "string", description: "卡片页眉主标题,缺省用设置里的" },
      subtitle: { type: "string", description: "页眉副标题,缺省自动生成" },
      outDir: { type: "string", description: "输出目录,缺省用设置里的 outputDir" },
      filename: { type: "string", description: "文件名主干(不带扩展名),缺省按范围自动命名" },
      autoMakeMissing: { type: "boolean", description: "缺卡片的词先自动生成内容,缺省 true" },
    },
    async execute(args, exec) {
      open();
      if (!liveConfig.enabled) return "插件已停用(enabled=false)。";
      const picked = pickWordRows(args, { onlyMissing: false, limit: args.limit || 32 });
      if (picked.error) return picked.error;

      let rows = picked.rows;
      const missing = rows.filter((r) => !r.card_updated_at);
      let generated = 0;
      if (missing.length && args.autoMakeMissing !== false) {
        const gen = await generateAndStore(missing, picked.user, exec && exec.signal);
        generated = gen.stored;
        // 重新取一次,拿到刚写入的卡片内容
        rows = queryWords(db, { userId: picked.user.id, kind: "word", limit: 2000 }).filter((r) => rows.some((x) => x.id === r.id));
      }
      const ready = rows.filter((r) => r.card_updated_at);
      if (!ready.length) {
        return json({
          ok: false,
          message: missing.length ? "卡片内容生成失败,没有可出片的词(可重试或换模型)" : "这个范围里没有已生成卡片的词",
          cardStats: cardStats(db, picked.user.id),
        });
      }

      const words = ready.map((r) => {
        let segs = [];
        try {
          segs = JSON.parse(r.card_segs || "[]");
        } catch {
          segs = [];
        }
        return {
          word: r.card_term || r.lemma,
          phonetic: r.card_phonetic || r.phonetic || "",
          pos: r.card_pos || r.pos || "",
          meaning: r.card_meaning || r.meaning || "",
          segs,
          story: r.card_story || "",
        };
      });

      const outDir = String(args.outDir || liveConfig.outputDir);
      const fmt = String(args.format || "all");
      const formats = fmt === "all" ? ["html", "pdf", "word"] : [fmt];
      const subtitle =
        String(args.subtitle || liveConfig.cards.subtitle || "").trim() ||
        `${picked.user.name} · ${words.length} 词 · 拆词 + 荒诞联想`;
      const tag = [args.since ? `起${String(args.since).slice(0, 10)}` : "", args.minCount ? `频次≥${args.minCount}` : "", args.status ? args.status : ""]
        .filter(Boolean)
        .join("-");
      const stem = String(args.filename || "").trim() || `单词记忆卡${tag ? "-" + tag : ""}-${new Date().toISOString().slice(5, 10)}`;

      const out = await exportCardSet({
        outDir,
        stem,
        title: String(args.title || liveConfig.cards.title),
        subtitle,
        words,
        formats,
      });

      return json({
        ok: true,
        user: picked.user.name,
        cards: words.length,
        pages: out.pages,
        perPage: 8,
        generatedNow: generated,
        skippedNoCard: picked.rows.length - ready.length,
        files: {
          html: out.html && out.html.ok ? out.html.path : null,
          pdf: out.pdf && out.pdf.ok ? out.pdf.path : null,
          word: out.word && out.word.ok ? out.word.path : null,
          preview: out.preview && out.preview.ok ? out.preview.path : null,
        },
        warnings: out.warnings,
        note: "出片后请打开预览图确认:每页第 4 行的「已攻下」勾选框都在框内(内容超高会被切掉)",
      });
    },
  }));
}
