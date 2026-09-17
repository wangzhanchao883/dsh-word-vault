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
import { dirname, join, basename, extname } from "node:path";

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
  recentContexts,
  createExamSession,
  addExamQuestion,
  listExamQuestions,
  answerExamQuestion,
  examSummary,
  finishExamSession,
  getExamSession,
  listExamSessions,
  answerPositionSpread,
  renameUser,
  userOverview,
} from "./db.mjs";
import { CaptureService } from "./capture.mjs";
import { generateCards } from "./cardgen.mjs";
import { exportCardSet, htmlToPdf, htmlToPng, findBrowser } from "./cards.mjs";
import { generateExam, buildPaperHtml, extractSentenceFromContext } from "./examgen.mjs";
import { startExamServer, parseChoice, EXAM_LETTERS } from "./exam.mjs";
import { translateWords } from "./translate.mjs";
import { findPhotos, scanPhotos, scannerScript, photoHash, loadProgress } from "./photos.mjs";
import { registerWebUi } from "./web.mjs";
import { randomUUID } from "node:crypto";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";

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
  highFreqMin: z.number().min(1).max(100).default(DEFAULT_CONFIG.highFreqMin),
  cardsTitle: z.string().default(DEFAULT_CONFIG.cards.title),
  cardsSubtitle: z.string().default(DEFAULT_CONFIG.cards.subtitle),
  cardsBatchSize: z.number().min(1).max(20).default(DEFAULT_CONFIG.cards.batchSize),
  examCount: z.number().min(1).max(100).default(DEFAULT_CONFIG.exam.count),
  examRecheckRatio: z.number().min(0).max(1).default(DEFAULT_CONFIG.exam.recheckRatio),
  examMinutes: z.number().min(1).max(600).default(DEFAULT_CONFIG.exam.minutes),
  examBatchSize: z.number().min(1).max(12).default(DEFAULT_CONFIG.exam.batchSize),
  photoDir: z.string().default(DEFAULT_CONFIG.photo.dir),
  photoOutDir: z.string().default(DEFAULT_CONFIG.photo.outDir),
  photoRecursive: z.boolean().default(DEFAULT_CONFIG.photo.recursive),
  photoKeepCrops: z.boolean().default(DEFAULT_CONFIG.photo.keepCrops),
  photoSatMin: z.number().min(5).max(200).default(DEFAULT_CONFIG.photo.satMin),
  photoPadUp: z.number().min(0).max(200).default(DEFAULT_CONFIG.photo.padUp),
  photoMaxCropH: z.number().min(40).max(600).default(DEFAULT_CONFIG.photo.maxCropH),
  photoMinDarkSpread: z.number().min(0).max(1).default(DEFAULT_CONFIG.photo.minDarkSpread),
  photoMaxPerRun: z.number().min(1).max(50).default(DEFAULT_CONFIG.photo.maxPerRun),
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
    highFreqMin: config.highFreqMin,
    cardsTitle: config.cards.title,
    cardsSubtitle: config.cards.subtitle,
    cardsBatchSize: config.cards.batchSize,
    examCount: config.exam.count,
    examRecheckRatio: config.exam.recheckRatio,
    examMinutes: config.exam.minutes,
    examBatchSize: config.exam.batchSize,
    photoDir: config.photo.dir,
    photoOutDir: config.photo.outDir,
    photoRecursive: config.photo.recursive,
    photoKeepCrops: config.photo.keepCrops,
    photoSatMin: config.photo.satMin,
    photoPadUp: config.photo.padUp,
    photoMaxCropH: config.photo.maxCropH,
    photoMinDarkSpread: config.photo.minDarkSpread,
    photoMaxPerRun: config.photo.maxPerRun,
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
    highFreqMin: flat.highFreqMin,
    cards: {
      title: flat.cardsTitle,
      subtitle: flat.cardsSubtitle,
      batchSize: flat.cardsBatchSize,
    },
    exam: {
      count: flat.examCount,
      recheckRatio: flat.examRecheckRatio,
      minutes: flat.examMinutes,
      batchSize: flat.examBatchSize,
    },
    photo: {
      dir: flat.photoDir,
      outDir: flat.photoOutDir,
      recursive: flat.photoRecursive,
      keepCrops: flat.photoKeepCrops,
      satMin: flat.photoSatMin,
      padUp: flat.photoPadUp,
      maxCropH: flat.photoMaxCropH,
      minDarkSpread: flat.photoMinDarkSpread,
      maxPerRun: flat.photoMaxPerRun,
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

  /**
   * 打开库。
   *
   * 关键:用户库以**数据库为准**——只有空库(首次运行)才按配置里的用户列表建。
   * 早先是每次 open() 都按配置 ensureUser,于是设置里一残留旧名字(例如改过名的用户),
   * 就会在库里重新建出**空壳用户**(实测:改名后重启 DSH,库里多出两个 0 词的同名壳)。
   */
  const open = () => {
    if (db) return db;
    db = openDb(liveConfig.dbPath);
    const existing = listUsers(db);
    if (!existing.length) {
      for (const u of liveConfig.users) ensureUser(db, u.name, "", u.enabled);
      ensureUser(db, liveConfig.defaultUser, "", true);
      return db;
    }
    // 库里有用户了:只做一致性兜底(默认库不存在时退到第一个)
    if (!existing.some((u) => u.name === liveConfig.defaultUser)) {
      ctx.logger.warn(`dsh-word-vault: 默认用户「${liveConfig.defaultUser}」在库里不存在,本次改用「${existing[0].name}」`);
      liveConfig = { ...liveConfig, defaultUser: existing[0].name };
    }
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
  /** 正在跑的答题服务(插件卸载时一并关掉,别留下孤儿监听端口) */
  const examServers = new Set();

  ctx.effect(() => {
    open();
    if (liveConfig.enabled) startService();
    return () => {
      stopService();
      for (const s of examServers) {
        try {
          s.close();
        } catch {
          /* 已关闭 */
        }
      }
      examServers.clear();
      if (db) {
        closeDb(db);
        db = null;
      }
    };
  });

  // ---------------- 设置命名空间:等 settings 服务就绪后注册 ----------------
  let settingsService = null; // 页面写设置要用(宿主 settings 服务的 update)
  ctx.inject(["settings"], (settingsCtx) => {
    try {
      settingsService = settingsCtx.settings;
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

  // ---------------- P5.1/P5.2 词库界面:挂到 DSH Web 服务器的 /word-vault 路由 ----------------
  // progressive injection:没有 webServer(如 headless profile)时静默跳过,插件照常工作
  // 动作实现复用下面的 P2/P3 助手(pickWordRows / generateAndStore / buildExamFor / persistExam 等),
  // 这里是箭头函数体、调用发生在 apply() 之后,所以引用后文定义的 const 没问题。
  registerWebUi(ctx, {
    db: open(),
    queryWords,
    stats,
    cardStats,
    liveConfig,
    logger: ctx.logger,
    /** 页面读设置:与 DSH 原生设置页同一份(扁平结构) */
    getSettings: () => toFlat(liveConfig),
    /** 用户库总览(改名牌用) */
    userOverview: () => userOverview(db),
    /** 页面写设置:走宿主 settings 服务的 update(只合并 patch 到用户分节) */
    writeSettings: async (patch) => {
      if (!settingsService) throw new Error("设置服务不可用");
      return settingsService.update(SETTINGS_NS, patch);
    },
    actions: {
      /** 用户库改名:DB 改行 + 同步设置里的用户列表与默认库(两边不同步的话工具就找不到用户) */
      renameUser: async ({ from, to }) => {
        const r = renameUser(db, { from, to });
        if (!r.ok) return r;
        if (r.unchanged) return { ...r, users: userOverview(db) };
        const cfgUsers = Array.isArray(liveConfig.users) ? liveConfig.users : [];
        const inConfig = cfgUsers.some((u) => u.name === String(from).trim());
        const nextUsers = inConfig
          ? cfgUsers.map((u) => (u.name === String(from).trim() ? { ...u, name: r.to } : u))
          : [...cfgUsers, { name: r.to, enabled: true }];
        const nextDefault = liveConfig.defaultUser === String(from).trim() ? r.to : liveConfig.defaultUser;
        // 立刻改本地配置(让后续读到的就是新名字),再写回设置(触发 watch → 助手重启)
        liveConfig = { ...liveConfig, users: nextUsers, defaultUser: nextDefault };
        if (settingsService) {
          try {
            await settingsService.update(SETTINGS_NS, { users: nextUsers, defaultUser: nextDefault });
          } catch (err) {
            ctx.logger.warn(`dsh-word-vault: 用户库改名后写设置失败(库名已改) - ${err.message}`);
          }
        }
        // 必须显式重启助手:实测改名后 settings 的 watch 不一定触发,而弹窗的用户按钮是助手进程渲染的
        if (service) startService();
        ctx.logger.info(`dsh-word-vault: 用户库改名 ${r.from} -> ${r.to}`);
        return { ...r, users: userOverview(db), defaultUser: nextDefault };
      },
      /** 按页面筛选出记忆卡(缺卡片的先补生成;缺释义的先补翻译) */
      cards: async ({ user, status, minCount, words, orderBy, limit }) => {
        const picked = pickWordRows({ user: user.name, status, minCount, orderBy, words, limit }, { onlyMissing: false, limit });
        if (picked.error) return { ok: false, error: picked.error };
        if (!picked.rows.length) return { ok: false, error: "当前筛选下没有词" };
        // 缺释义的先补翻译(卡片与题目都需要释义;与出卷走同一条路)
        const noMeaning = picked.rows.filter((r) => !String(r.meaning || "").trim());
        let translated = 0;
        if (noMeaning.length) {
          const t = await translateWords({
            llm: ctx.get("llm"),
            provider: liveConfig.provider,
            model: liveConfig.model,
            words: noMeaning.map((r) => ({ term: r.lemma })),
            logger: ctx.logger,
          });
          if (t.size) {
            upsertDict(db, [...t.entries()].map(([term, v]) => ({ term, kind: "word", phonetic: v.phonetic, pos: v.pos, meaning: v.meaning, source: "llm-card" })));
            translated = t.size;
          }
        }
        const missing = picked.rows.filter((r) => cardNeedsWork(r)); // 含"有卡片但缺音标"的老卡片
        let generatedNow = 0;
        let genFailures = [];
        if (missing.length) {
          const gen = await generateAndStore(missing, picked.user, undefined);
          generatedNow = gen.stored;
          genFailures = gen.failures || [];
        }
        const idSet = new Set(picked.rows.map((r) => r.id));
        const ready = queryWords(db, { userId: picked.user.id, kind: "word", orderBy: "count", limit: 2000 }).filter(
          (r) => idSet.has(r.id) && r.card_updated_at,
        );
        if (!ready.length) {
          return {
            ok: false,
            error:
              "卡片内容没能生成。" +
              (genFailures.length
                ? `原因：${genFailures.map((f) => `${f.word}(${f.reasons.join("；")})`).join(" / ")}`
                : "模型没有返回可用内容") +
              " 可稍后重试；若反复失败，多半是宿主调模型这一侧的问题（可在设置里换模型，或告诉我，我看日志）。",
            failures: genFailures,
            autoTranslated: translated,
          };
        }
        const list = ready.map((r) => {
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
            seenCount: r.seen_count,
          };
        });
        const stamp = new Date().toISOString().slice(5, 10);
        const out = await exportCardSet({
          outDir: liveConfig.outputDir,
          stem: `词库页面-记忆卡-${stamp}`,
          title: liveConfig.cards.title,
          subtitle: `${picked.user.name} · ${list.length} 词 · 从词库页面导出`,
          words: list,
          formats: ["html", "pdf", "word"],
          highFreqMin: liveConfig.highFreqMin,
        });
        return {
          ok: true,
          cards: list.length,
          generatedNow,
          highFreqCards: list.filter((w) => Number(w.seenCount) >= liveConfig.highFreqMin).length,
          files: {
            html: out.html && out.html.ok ? out.html.path : null,
            pdf: out.pdf && out.pdf.ok ? out.pdf.path : null,
            word: out.word && out.word.ok ? out.word.path : null,
            preview: out.preview && out.preview.ok ? out.preview.path : null,
          },
        };
      },
      /** 按页面筛选出题。
       *  mode='answer' → 只起在线答题页(做完逐题判分并归档),不产 PDF;
       *  mode='paper'  → 只出打印用 PDF(题目页 + 答案页),不起答题服务。 */
      exam: async ({ user, status, minCount, words, limit, mode }) => {
        const built = await buildExamFor({ user: user.name, status, minCount, words, count: limit, orderBy: "count" }, user, undefined);
        if (!built.gen.questions.length) {
          return { ok: false, error: built.gen.reason || "这个范围里没有可考的词", failures: built.gen.failures };
        }
        const session = persistExam(user, built.scope, built.gen);
        const title = "英语单词测验";
        const subtitle = `${user.name} · ${built.gen.questions.length} 题 · 来自词库页面`;

        if (mode === "answer") {
          const srv = await startExamServer({
            db,
            sessionId: session.id,
            title,
            subtitle,
            logger: ctx.logger,
            idleTimeoutMs: liveConfig.exam.minutes * 60 * 1000,
          });
          if (!srv.ok) return { ok: false, error: srv.error || "答题服务启动失败" };
          examServers.add(srv);
          return {
            ok: true,
            mode: "answer",
            sessionId: session.id,
            questions: built.gen.questions.length,
            url: srv.url,
            message: "打开链接逐题作答：点选即判分，连对 3 次自动打「已学会」，成绩自动归档。",
          };
        }

        const paper = await exportExamPaper(session.id, user, title, subtitle, "pdf");
        const files = (paper && paper.files) || {};
        return {
          ok: true,
          mode: "paper",
          sessionId: session.id,
          questions: built.gen.questions.length,
          files,
          primary: files.paperPdf || files.paperHtml || null,
          message: "打印这份试卷纸笔作答；做完在对话里让我逐题录分（也可以随时在页面上改成在线答题）。",
        };
      },
    },
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
      "按维度查询生词库:录入时间区间(since/until)、出现次数区间(minCount/maxCount)、已学会状态(status)、排序方式(orderBy: recent/count/oldest/alpha/stale)。highFreq=true 只看高频词(累计被录入次数 ≥ highFreqMin)。返回词条、音标、释义、次数、时间与 highFreq 标记。",
    parameters: {
      user: { type: "string", description: "用户库,缺省默认用户" },
      since: { type: "string", description: "起始时间(含),ISO 或 YYYY-MM-DD" },
      until: { type: "string", description: "结束时间(含),ISO 或 YYYY-MM-DD" },
      minCount: { type: "number", description: "最少出现过几次" },
      maxCount: { type: "number", description: "最多出现过几次" },
      highFreq: { type: "boolean", description: "只看高频词(次数 ≥ highFreqMin,默认 2)" },
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
        // highFreq 只是 minCount 的语义化开关:门槛来自设置里的 highFreqMin
        minCount: args.highFreq ? Math.max(Number(args.minCount) || 0, liveConfig.highFreqMin) : args.minCount,
        maxCount: args.maxCount,
        status: args.status,
        orderBy: args.orderBy || "recent",
        limit: args.limit || 30,
      });
      return json({
        user: user.name,
        count: rows.length,
        highFreqMin: liveConfig.highFreqMin,
        words: rows.map((r) => ({
          word: r.lemma,          // 词元(词典形),展示与背诵以它为准
          term: r.term,           // 最近一次录入时的原文形态
          kind: r.kind,
          phonetic: r.phonetic || "",
          pos: r.pos || "",
          meaning: r.meaning || "",
          seenCount: r.seen_count,
          highFreq: r.seen_count >= liveConfig.highFreqMin,
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
        highFreqMin: liveConfig.highFreqMin,
        highFreq: user
          ? queryWords(db, { userId: user.id, kind: "word", minCount: liveConfig.highFreqMin, orderBy: "count", limit: 20 }).map((r) => ({
              word: r.lemma,
              seenCount: r.seen_count,
              status: r.status,
            }))
          : [],
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

  /**
   * 卡片是否需要补生成:
   * ① 根本没有卡片 ② 有卡片但**拆解块缺音标**(用户要求"所有单词卡都带音标训读",
   *    加音标功能之前生成的老卡片属于这种)
   * 注意:补生成走 upsertCard 的默认故事锁 -> 只会补上音标,不会改掉已定稿的荒诞梗。
   */
  const hasSegIpa = (row) => {
    if (!row || !row.card_segs) return false;
    try {
      const segs = JSON.parse(row.card_segs);
      if (!Array.isArray(segs) || !segs.length) return false;
      return segs.every((s) => s && String(s.ipa || "").trim());
    } catch {
      return false;
    }
  };
  const cardNeedsWork = (row) => !row.card_updated_at || !hasSegIpa(row);

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
    if (onlyMissing) rows = rows.filter((r) => cardNeedsWork(r));
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
          seenCount: r.seen_count, // 高频词在卡面上印"标记 N 次"
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
        highFreqMin: liveConfig.highFreqMin,
      });

      return json({
        ok: true,
        user: picked.user.name,
        cards: words.length,
        highFreqCards: words.filter((w) => Number(w.seenCount) >= liveConfig.highFreqMin).length,
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

  // ---------------- P3 共用:出题(句子取原文优先,干扰项同库同词性优先) ----------------
  const buildExamFor = async (args, user, signal) => {
    const scope = {
      since: args.since,
      until: args.until,
      minCount: args.minCount,
      maxCount: args.maxCount,
      status: args.status,
      orderBy: args.orderBy || "stale",
      includeMastered: args.includeMastered !== false,
      seed: args.seed,
      includeWords: args.words,
    };
    const count = Math.max(1, Math.min(100, Number(args.count) || liveConfig.exam.count));

    // 英译汉必须有释义:范围内缺释义的词先自动补翻译(走词典缓存,只翻缺的)
    const candidates = queryWords(db, {
      userId: user.id,
      kind: "word",
      since: scope.since,
      until: scope.until,
      minCount: scope.minCount,
      maxCount: scope.maxCount,
      status: scope.status && scope.status !== "all" ? scope.status : undefined,
      orderBy: scope.orderBy,
      limit: 2000,
    });
    const missing = candidates.filter((r) => !String(r.meaning || "").trim());
    let translated = 0;
    if (missing.length) {
      const map = await translateWords({
        llm: ctx.get("llm"),
        provider: liveConfig.provider,
        model: liveConfig.model,
        words: missing.map((r) => ({ term: r.lemma })),
        logger: ctx.logger,
        signal,
      });
      if (map.size) {
        upsertDict(
          db,
          [...map.entries()].map(([term, v]) => ({
            term,
            kind: "word",
            phonetic: v.phonetic,
            pos: v.pos,
            meaning: v.meaning,
            source: "llm-exam",
          })),
        );
        translated = map.size;
      }
    }

    const gen = await generateExam({
      llm: ctx.get("llm"),
      provider: liveConfig.provider,
      model: liveConfig.model,
      db,
      queryWords,
      userId: user.id,
      scope,
      count,
      recheckRatio: args.recheckRatio === undefined ? liveConfig.exam.recheckRatio : Number(args.recheckRatio),
      batchSize: liveConfig.exam.batchSize,
      logger: ctx.logger,
      signal,
      findSentence: (row) => {
        for (const c of recentContexts(db, row.id, 10)) {
          const s = extractSentenceFromContext(c.context, row.lemma);
          if (s) return s;
        }
        return "";
      },
    });
    return { scope, count, gen, translated };
  };

  const persistExam = (user, scope, gen) => {
    const token = randomUUID().replace(/-/g, "").slice(0, 16);
    const session = createExamSession(db, { userId: user.id, scope: { ...scope, generated: gen.questions.length }, count: gen.questions.length, token });
    gen.questions.forEach((q, i) => {
      addExamQuestion(db, {
        sessionId: session.id,
        seq: i + 1,
        wordId: q.wordId,
        promptWord: q.word,
        sentence: q.sentence,
        sentenceSrc: q.sentenceSrc,
        correctMeaning: q.correctMeaning,
        options: q.options,
        answerIndex: q.answerIndex,
        isRecheck: q.isRecheck,
      });
    });
    return getExamSession(db, session.id);
  };

  // ---------------- 工具 8:开始考试(出题 + 起本地答题页) ----------------
  ctx.tools.register(textTool({
    name: "wordvault_exam_start",
    description:
      "按范围出一份英译汉单选题并起本地答题页:题干是含该词的英文句子,再单独问这个词的意思;ABCD 正确答案按位置配额均衡错开;干扰项优先取同库同词性的词义、由模型补齐。返回一个 127.0.0.1 的答题链接(浏览器打开即可逐题作答、即时判分并回写库)。可顺带导出可打印试卷。",
    parameters: {
      ...CARD_FILTERS,
      count: { type: "number", description: "出多少题,缺省用设置里的 examCount" },
      includeMastered: { type: "boolean", description: "是否混入已学会词做复查,缺省 true(比例见 examRecheckRatio)" },
      paper: { type: "boolean", description: "同时导出可打印试卷(PDF),缺省 false" },
      title: { type: "string", description: "卷面标题,缺省 英语单词测验" },
      seed: { type: "number", description: "随机种子(同一种子出同一份卷,便于复现)" },
    },
    async execute(args, exec) {
      open();
      if (!liveConfig.enabled) return "插件已停用(enabled=false)。";
      const user = findUser(db, args.user || liveConfig.defaultUser);
      if (!user) return `没有这个用户:${args.user || liveConfig.defaultUser}`;

      const { scope, gen, translated } = await buildExamFor(args, user, exec && exec.signal);
      if (!gen.questions.length) {
        return json({
          ok: false,
          message: gen.reason || "出题失败:没有可考的词",
          failures: gen.failures,
          pool: gen.pool,
          autoTranslated: translated,
          hint: "先用 wordvault_add 录词、或放宽范围(如 minCount/status);若提示'没有释义',多为翻译调用失败,可稍后重试",
        });
      }
      const session = persistExam(user, scope, gen);
      const title = String(args.title || "英语单词测验");
      const subtitle = `${user.name} · ${gen.questions.length} 题`;

      const srv = await startExamServer({
        db,
        sessionId: session.id,
        title,
        subtitle,
        logger: ctx.logger,
        idleTimeoutMs: liveConfig.exam.minutes * 60 * 1000,
      });
      if (srv.ok) examServers.add(srv);

      let paper = null;
      if (args.paper) paper = await exportExamPaper(session.id, user, title, subtitle, "pdf");

      const spread = answerPositionSpread(db, session.id);
      return json({
        ok: true,
        sessionId: session.id,
        user: user.name,
        url: srv.ok ? srv.url : null,
        serverError: srv.ok ? undefined : srv.error,
        questions: gen.questions.length,
        recheck: gen.questions.filter((q) => q.isRecheck).length,
        autoTranslated: translated,
        answerSpread: spread.spread,
        pool: gen.pool,
        failedWords: gen.failures,
        paper: paper ? paper.files : undefined,
        note: srv.ok
          ? "把这个链接发给答题的人(浏览器打开);逐题点选即判分,最后自动结算。链接含随机 token 且只监听本机。"
          : "答题服务没能起来,可用 wordvault_exam_paper 导试卷、再用 wordvault_exam_answer 手工录分。",
      });
    },
  }));

  // ---------------- 工具 9:手工录分/答题(打印卷与对话场景) ----------------
  ctx.tools.register(textTool({
    name: "wordvault_exam_answer",
    description:
      "为某场考试的第 N 题记录作答并判分(choice 传 A/B/C/D 或 0-3)。用于批改打印卷、或在对话里答题。判分会按口径回写该词的连续答对次数与已学会状态。",
    parameters: {
      sessionId: { type: "number", description: "考试 id(由 wordvault_exam_start 返回)" },
      seq: { type: "number", description: "第几题(从 1 开始)" },
      choice: { type: "string", description: "选了哪个:A/B/C/D 或 0-3" },
    },
    async execute(args) {
      open();
      const sessionId = Number(args.sessionId);
      const seq = Number(args.seq);
      const choice = parseChoice(args.choice);
      if (!Number.isFinite(sessionId) || !Number.isFinite(seq)) return "需要 sessionId 与 seq。";
      if (choice < 0) return "choice 必须是 A/B/C/D 或 0-3。";
      const r = answerExamQuestion(db, { sessionId, seq, chosenIndex: choice });
      if (!r.ok) return r.error;
      const s = examSummary(db, sessionId);
      return json({
        ...r,
        chosenLetter: EXAM_LETTERS[choice],
        correctLetter: EXAM_LETTERS[r.correctIndex],
        progress: { answered: s.answered, total: s.total, correct: s.correct },
        next: s.answered < s.total ? `下一题请回答第 ${s.answered + 1} 题` : "全部答完,可调 wordvault_exam_result 看结算",
      });
    },
  }));

  // ---------------- 工具 10:考试结算 ----------------
  ctx.tools.register(textTool({
    name: "wordvault_exam_result",
    description: "查看某场考试的结算:对了几题、错题清单(你选了什么/正确是什么)、已学会变动。缺省看最近一场。",
    parameters: {
      sessionId: { type: "number", description: "考试 id,缺省最近一场" },
      user: { type: "string", description: "配合缺省使用时指定用户" },
    },
    async execute(args) {
      open();
      let sessionId = Number(args.sessionId);
      if (!Number.isFinite(sessionId)) {
        const user = findUser(db, args.user || liveConfig.defaultUser);
        if (!user) return `没有这个用户:${args.user || liveConfig.defaultUser}`;
        const last = listExamSessions(db, user.id, 1)[0];
        if (!last) return "还没有考试记录。";
        sessionId = last.id;
      }
      const s = examSummary(db, sessionId);
      if (!s) return `没有这场考试:${sessionId}`;
      const spread = answerPositionSpread(db, sessionId);
      return json({ ...s, answerSpread: spread.spread });
    },
  }));

  // ---------------- 工具 11:导出/重出可打印试卷 ----------------
  const exportExamPaper = async (sessionId, user, title, subtitle, format = "pdf") => {
    const session = getExamSession(db, sessionId);
    if (!session) return { ok: false, error: `没有这场考试:${sessionId}` };
    const questions = listExamQuestions(db, sessionId);
    const outDir = liveConfig.outputDir;
    mkdirSync(outDir, { recursive: true });
    const stem = `单词测验-${new Date().toISOString().slice(5, 10)}-${sessionId}`;
    const paperPath = join(outDir, `${stem}_试卷.html`);
    const keyPath = join(outDir, `${stem}_答案.html`);
    writeFileSync(paperPath, buildPaperHtml({ sessionId, title, subtitle, questions, includeAnswers: false }), "utf8");
    writeFileSync(keyPath, buildPaperHtml({ sessionId, title: `${title} · 参考答案`, subtitle, questions, includeAnswers: true }), "utf8");

    const files = { paperHtml: paperPath, keyHtml: keyPath };
    if (format === "pdf" && findBrowser()) {
      const p1 = await htmlToPdf(paperPath, join(outDir, `${stem}_试卷.pdf`));
      const p2 = await htmlToPdf(keyPath, join(outDir, `${stem}_答案.pdf`));
      if (p1.ok) files.paperPdf = p1.path;
      if (p2.ok) files.keyPdf = p2.path;
      const png = await htmlToPng(paperPath, join(outDir, `${stem}_试卷_预览.png`));
      if (png.ok) files.preview = png.path;
    }
    return { ok: true, files, questions: questions.length };
  };

  ctx.tools.register(textTool({
    name: "wordvault_exam_paper",
    description:
      "把某场考试导成可打印试卷(HTML/PDF + 单独一份参考答案),用于纸笔作答,之后用 wordvault_exam_answer 录分。缺省导出最近一场;也可指定 sessionId。",
    parameters: {
      sessionId: { type: "number", description: "考试 id,缺省最近一场" },
      user: { type: "string", description: "配合缺省使用时指定用户" },
      format: { type: "string", enum: ["pdf", "html"], description: "缺省 pdf(同时给 HTML)" },
      title: { type: "string", description: "卷面标题" },
    },
    async execute(args) {
      open();
      let sessionId = Number(args.sessionId);
      let user = findUser(db, args.user || liveConfig.defaultUser);
      if (!Number.isFinite(sessionId)) {
        if (!user) return `没有这个用户:${args.user || liveConfig.defaultUser}`;
        const last = listExamSessions(db, user.id, 1)[0];
        if (!last) return "还没有考试记录,先用 wordvault_exam_start 出一份。";
        sessionId = last.id;
      }
      const session = getExamSession(db, sessionId);
      if (!session) return `没有这场考试:${sessionId}`;
      if (!user) user = { name: `用户${session.user_id}` };
      const title = String(args.title || "英语单词测验");
      const r = await exportExamPaper(sessionId, user, title, `${user.name} · ${listExamQuestions(db, sessionId).length} 题`, String(args.format || "pdf"));
      if (!r.ok) return r.error;
      return json({
        ok: true,
        sessionId,
        questions: r.questions,
        files: r.files,
        note: "试卷与答案分开两个文件:打印试卷给人做,答案自己留着;做完用 wordvault_exam_answer 逐题录分会自动回写掌握度",
      });
    },
  }));

  // ---------------- P4 照片通道 ----------------
  const photoProgressFile = () => join(runtimeDir(), "photo-progress.json");

  /** 找出这批照片里哪些还没入过库(按内容 hash) */
  const ingestedPhotoHashes = () => {
    const f = join(runtimeDir(), "photo-ingested.json");
    return loadProgress(f);
  };
  const markPhotoIngested = (hash, info) => {
    const f = join(runtimeDir(), "photo-ingested.json");
    const data = ingestedPhotoHashes();
    data[hash] = { ...info, ingestedAt: new Date().toISOString() };
    writeFileSync(f, JSON.stringify(data, null, 2), "utf8");
  };

  // ---------------- 工具 12:扫描照片找标记词 ----------------
  ctx.tools.register(textTool({
    name: "wordvault_scan_photo",
    description:
      "扫描作业/课本照片,定位「被标记的印刷词」候选区域:识别各色荧光笔与红笔的红线/勾/圈(铅笔与黑色手写不参与),按行合并后裁剪,并输出一张联络图。返回联络图路径——请用读图能力看这张联络图,只挑出被标记的**印刷体**单词/短语(跳过手写与插图),再调 wordvault_add 入库(每张照片一次调用,便于整张撤销)。可传单张照片路径,也可扫 photoDir 目录里未处理的新照片。",
    parameters: {
      path: { type: "string", description: "单张照片的绝对路径(与 folder 二选一)" },
      folder: { type: "string", description: "照片目录,缺省用设置里的 photoDir" },
      force: { type: "boolean", description: "已扫过的照片也重新扫(缺省 false,按内容 hash 跳过)" },
      maxPerRun: { type: "number", description: "本次最多处理几张新照片,缺省用设置里的 photoMaxPerRun" },
    },
    async execute(args) {
      open();
      if (!liveConfig.enabled) return "插件已停用(enabled=false)。";
      const single = String(args.path || "").trim();
      const folder = single ? dirname(single) : String(args.folder || liveConfig.photo.dir);
      if (!single && !existsSync(folder)) {
        mkdirSync(folder, { recursive: true });
        return json({
          ok: true,
          folder,
          photos: 0,
          message: `照片目录已创建,把照片丢进去再叫我扫:${folder}`,
          note: "也可以直接在对话里发照片,我现场处理。",
        });
      }
      const photos = single ? [single] : findPhotos(folder, { recursive: liveConfig.photo.recursive });
      if (!photos.length) {
        return json({ ok: true, folder, photos: 0, message: `这个目录里没有照片(jpg/jpeg/png/webp/bmp):${folder}` });
      }

      const out = await scanPhotos({
        photos,
        outDir: liveConfig.photo.outDir,
        progressFile: photoProgressFile(),
        force: !!args.force,
        keepCrops: liveConfig.photo.keepCrops,
        maxPerRun: Math.max(1, Number(args.maxPerRun) || liveConfig.photo.maxPerRun),
        options: {
          satMin: liveConfig.photo.satMin,
          padUp: liveConfig.photo.padUp,
          maxCropH: liveConfig.photo.maxCropH,
          minDarkSpread: liveConfig.photo.minDarkSpread,
        },
        logger: ctx.logger,
      });

      const ingested = ingestedPhotoHashes();
      const list = out.results.map((r) => ({
        photo: basename(r.photo),
        photoPath: r.photo,
        status: r.status,
        regions: r.regions,
        sheet: r.sheets && r.sheets[0] ? r.sheets[0] : null,
        cropDir: r.cropDir,
        alreadyIngested: !!(r.hash && ingested[r.hash]),
        source: `照片 ${basename(r.photo)}（标记的印刷词）`,
        error: r.error,
      }));

      return json({
        ok: true,
        folder,
        total: out.total,
        scanned: out.scanned,
        reused: out.reused,
        pending: out.pending,
        photos: list,
        outDir: liveConfig.photo.outDir,
        next: [
          "1) 逐张读 sheet(联络图):图上每块都标了 rN/y 范围/命中理由,只认被标记的【印刷体】词或短语,跳过手写、红笔批注、插图。",
          "2) 每张照片调一次 wordvault_add:把该照片识别出的词拼成多行文本传进去,source 用上面给的字符串——这样一张照片就是一条可整张撤销的记录。",
          "3) 录完可调 wordvault_scan_photo 再确认(已入库的照片会标 alreadyIngested)。",
        ],
        note: out.pending ? `还有 ${out.pending} 张没扫,再叫一次继续。` : undefined,
      });
    },
  }));

  // ---------------- 工具 13:照片通道进度 ----------------
  ctx.tools.register(textTool({
    name: "wordvault_photo_status",
    description: "查看照片通道进度:photoDir 里共多少张照片、已扫描多少、哪些已入库、联络图在哪。",
    parameters: {
      folder: { type: "string", description: "照片目录,缺省用设置里的 photoDir" },
      limit: { type: "number", description: "最多列几条,缺省 20" },
    },
    async execute(args) {
      open();
      const folder = String(args.folder || liveConfig.photo.dir);
      const photos = existsSync(folder) ? findPhotos(folder, { recursive: liveConfig.photo.recursive }) : [];
      const progress = loadProgress(photoProgressFile());
      const ingested = ingestedPhotoHashes();
      const n = Math.max(1, Math.min(200, Number(args.limit) || 20));
      const rows = photos.slice(0, n).map((p) => {
        let hash = "";
        try {
          hash = photoHash(p);
        } catch {
          /* 读不到就留空 */
        }
        const sc = hash ? progress[hash] : null;
        return {
          photo: basename(p),
          hash,
          scanned: !!sc,
          regions: sc ? sc.regions : null,
          sheet: sc && sc.sheets && sc.sheets[0] ? sc.sheets[0] : null,
          ingested: !!(hash && ingested[hash]),
          ingestedAt: hash && ingested[hash] ? ingested[hash].ingestedAt : null,
        };
      });
      return json({
        ok: true,
        folder,
        photoDir: liveConfig.photo.dir,
        outDir: liveConfig.photo.outDir,
        script: scannerScript(),
        total: photos.length,
        scanned: rows.filter((r) => r.scanned).length,
        ingested: rows.filter((r) => r.ingested).length,
        photos: rows,
        note: photos.length ? undefined : `目录里还没有照片:${folder}`,
      });
    },
  }));
}
