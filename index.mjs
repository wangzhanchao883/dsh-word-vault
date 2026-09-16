/**
 * dsh-word-vault —— 英语生词库(多用户)DSH 插件。
 *
 * P1 已交付:
 *   · 录入通道①:常驻助手监听剪贴板(用户照常 Ctrl+C,自动入默认库;浮窗可改库/撤销)
 *   · 录入通道③:对话/斜杠场景下的 wordvault_add 工具(任何环境都能录,不依赖助手)
 *   · node:sqlite 落库 + LLM 批量翻译 + 词典缓存 + 维度查询统计
 *
 * 后续:P2 记忆卡输出 / P3 考试闭环 / P4 拍照通道 / P5 词库管理界面。
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";
import { dirname, join } from "node:path";

import { DEFAULT_CONFIG, resolveConfig } from "./config.mjs";
import { openDb, closeDb, ensureUser, listUsers, findUser, queryWords, stats, listCaptures, undoCapture, reassignCapture } from "./db.mjs";
import { CaptureService } from "./capture.mjs";

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
}
