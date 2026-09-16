/**
 * host 侧抓取编排:
 *   · 起停常驻 PowerShell 剪贴板助手(ctx.effect 保证卸载即清理)
 *   · 增量读队列文件 → 切词 → 批量翻译 → 落库 → 写回执给浮窗
 *   · 读命令文件(浮窗的「改库」「撤销」)→ 操作库 → 写回执
 *
 * 与助手的通信全走文件:本机 PowerShell 管道回传不可靠(实测),且文件队列天然支持助手重启不丢事件。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { helperConfig, UI_TEXT } from "./config.mjs";
import { extractCandidates } from "./words.mjs";
import {
  recordEntries,
  upsertDict,
  getCapture,
  undoCapture,
  reassignCapture,
  findUser,
  ensureUser,
  todayCount,
} from "./db.mjs";
import { translateWords } from "./translate.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PS_SCRIPT = join(HERE, "scripts", "capture.ps1");
const POWERSHELL = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

export class CaptureService {
  /**
   * @param {{config:object, db:any, logger:any, getLlm:()=>any, paths:{dir:string}, onEvent?:(e:object)=>void}} args
   */
  constructor({ config, db, logger, getLlm, paths, onEvent }) {
    this.config = config;
    this.db = db;
    this.logger = logger;
    this.getLlm = getLlm;
    this.dir = paths.dir;
    this.onEvent = onEvent || (() => {});
    this.queuePath = join(this.dir, "capture-queue.jsonl");
    this.statusPath = join(this.dir, "capture-status.json");
    this.resultPath = join(this.dir, "capture-result.json");
    this.commandPath = join(this.dir, "capture-commands.jsonl");
    this.promptPath = join(this.dir, "capture-prompt.json");
    this.triggerPath = join(this.dir, "capture-trigger.txt");
    this.debugPath = join(this.dir, "capture-debug.log");
    this.helperCfgPath = join(this.dir, "helper-config.json");
    this.queueOffset = 0;
    this.commandOffset = 0;
    this.child = null;
    this.timer = null;
    this.busy = false;
    this.log = [];
    this.lastCaptureId = null;
    this.lastUser = null;
    /** 等用户点选的待入库文本 {id → {text, at, wordCount}} */
    this.pending = new Map();
    this.promptSeq = 0;
  }

  /** 启动助手 + 队列轮询;返回 disposer */
  start() {
    mkdirSync(this.dir, { recursive: true });
    // 从当前文件末尾开始,避免把上次遗留的事件重复入库
    this.queueOffset = existsSync(this.queuePath) ? statSync(this.queuePath).size : 0;
    this.commandOffset = existsSync(this.commandPath) ? statSync(this.commandPath).size : 0;

    if (this.config.helper.enabled) this.spawnHelper();

    // 250ms 轮询:复制到弹窗出现之间只差一个来回,体感要求就是这个量级
    this.timer = setInterval(() => {
      this.drain().catch((err) => this.logger.warn(`dsh-word-vault: drain failed - ${err.message}`));
    }, 250);

    // 起始回执:让小条立刻显示正确的"今日累计"
    this.writeResult({ ok: true, message: UI_TEXT.ready, todayCount: this.todayFor(null), kind: "startup" });

    return () => {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      this.killHelper();
    };
  }

  /** 某用户(对象 / 名字 / id,缺省默认用户)今日录入次数;用户还不存在时返回 0 */
  todayFor(user) {
    try {
      let id = null;
      if (user && typeof user === "object") id = user.id;
      else {
        const row = findUser(this.db, user || this.config.defaultUser);
        id = row ? row.id : null;
      }
      if (!id) return 0;
      return todayCount(this.db, id);
    } catch {
      return 0;
    }
  }

  spawnHelper() {
    // 用户按钮以数据库为准:设置里的用户列表可能滞后(改名后靠它避免弹窗还显示旧名字)
    let dbUsers = null;
    try {
      dbUsers = this.db.prepare("SELECT name, enabled FROM users ORDER BY id").all().map((u) => ({ name: u.name, enabled: !!u.enabled }));
    } catch {
      dbUsers = null;
    }
    configToFile(this.helperCfgPath, helperConfig(this.config, {
      queuePath: this.queuePath,
      statusPath: this.statusPath,
      resultPath: this.resultPath,
      commandPath: this.commandPath,
      promptPath: this.promptPath,
      triggerPath: this.triggerPath,
      debugPath: this.debugPath,
    }, false, dbUsers));
    try {
      this.child = spawn(
        POWERSHELL,
        ["-STA", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", PS_SCRIPT, "-ConfigPath", this.helperCfgPath],
        { stdio: "ignore", windowsHide: true, detached: false },
      );
      this.child.on("exit", (code) => {
        this.logger.warn(`dsh-word-vault: 剪贴板助手退出 code=${code}`);
        this.child = null;
      });
      this.logger.info("dsh-word-vault: 剪贴板助手已启动");
    } catch (err) {
      this.logger.warn(`dsh-word-vault: 助手启动失败 - ${err.message}`);
      this.child = null;
    }
  }

  killHelper() {
    if (!this.child) return;
    try {
      this.child.kill();
    } catch {
      /* 已退出 */
    }
    this.child = null;
  }

  helperStatus() {
    if (!existsSync(this.statusPath)) return { ready: false, note: "助手未上报状态" };
    try {
      return JSON.parse(readFileSync(this.statusPath, "utf8"));
    } catch (err) {
      return { ready: false, note: `状态文件读取失败:${err.message}` };
    }
  }

  /** 强制助手抓一次当前剪贴板(供对话/斜杠命令使用) */
  requestCapture(user) {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.triggerPath, String(user || this.config.defaultUser), "utf8");
    return { ok: true, queued: true, user: user || this.config.defaultUser };
  }

  /** 读取新增行(按字节偏移增量;文件被重建时自动重置) */
  readNewLines(path, offsetKey) {
    if (!existsSync(path)) return [];
    const size = statSync(path).size;
    let offset = this[offsetKey];
    if (size < offset) offset = 0;
    if (size === offset) return [];
    const buf = readFileSync(path);
    const slice = buf.subarray(offset).toString("utf8");
    this[offsetKey] = size;
    return slice
      .split(/\r?\n/)
      .map((l) => l.replace(/^\uFEFF/, "").trim())
      .filter(Boolean);
  }

  async drain() {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const line of this.readNewLines(this.queuePath, "queueOffset")) {
        let evt;
        try {
          evt = JSON.parse(line);
        } catch {
          this.logger.warn("dsh-word-vault: 队列行不是合法 JSON,已跳过");
          continue;
        }
        await this.handleQueueEvent(evt);
      }
      for (const line of this.readNewLines(this.commandPath, "commandOffset")) {
        let cmd;
        try {
          cmd = JSON.parse(line);
        } catch {
          continue;
        }
        try {
          await this.handleCommand(cmd);
        } catch (err) {
          this.logger.warn(`dsh-word-vault: 命令处理失败 - ${err.message}`);
        }
      }
    } finally {
      this.busy = false;
    }
  }

  async handleQueueEvent(evt) {
    if (evt.kind === "image" || evt.via === "clipboard-image") {
      this.pushLog({ kind: "image", path: evt.imagePath || "", note: "拍照/截图通道在 P4 处理" });
      this.writeResult({
        ok: true,
        message: `已收到截图,拍照通道(P4)再处理:${evt.imagePath || "(未保存)"}`,
        captureId: "",
        user: "",
        todayCount: this.todayFor(null),
        kind: "image",
      });
      return;
    }
    const text = String(evt.text || "");
    if (!text.trim()) return;

    // 明确指定了归属(自动入库 / 触发文件)→ 直接录;否则先让用户点选
    const explicitUser = evt.user && String(evt.user).trim() ? String(evt.user).trim() : null;
    if (explicitUser || this.config.helper.autoCommit) {
      const user = await this.resolveUser(explicitUser || this.config.defaultUser);
      await this.ingest(text, { user, via: evt.via || "clipboard", ts: evt.ts, kind: "auto" });
      return;
    }
    await this.promptForPick(text, evt.via || "clipboard");
  }

  /** 切词后写提示文件,等用户在弹窗里点选归属(不落库)。
   *  用户要求:弹窗里要能看见**中文意思**,所以先补翻译(只翻缺的,通常 1~2 秒)再弹。 */
  async promptForPick(text, via) {
    const cfg = this.config;
    const extracted = extractCandidates(text, {
      extraStopwords: new Set(cfg.words.extraStopwords || []),
      maxPhraseWords: 5,
    });
    const words = extracted.words.slice(0, cfg.words.maxWordsPerCapture).map((w) => w.lemma);
    const phrases = cfg.words.keepPhrases ? extracted.phrases.slice(0, 1) : [];
    const all = [...words, ...phrases];
    const id = `p${Date.now().toString(36)}-${(this.promptSeq += 1)}`;

    // 过期的待选项清掉,避免无限增长
    const ttl = Math.max(60000, (cfg.helper.promptTimeoutMs || 20000) + 15000);
    const now = Date.now();
    for (const [k, v] of this.pending) if (now - v.at > ttl) this.pending.delete(k);
    if (all.length) this.pending.set(id, { text, at: now, wordCount: all.length, via });

    // 先补翻译,让弹窗能显示"词 — 中文意思"
    if (all.length) {
      try {
        await this.translateMissing(all.map((w) => ({ term: w, lemma: w })));
      } catch (err) {
        this.logger.warn(`dsh-word-vault: 弹窗前翻译失败(仍然弹窗) - ${err && err.message ? err.message : err}`);
      }
    }
    const lines = all.map((w) => ({ word: w, meaning: this.meaningOf(w) || "" }));
    try {
      writeFileSync(
        this.promptPath,
        JSON.stringify({ id, at: new Date().toISOString(), wordCount: all.length, words: all, lines, preview: text.slice(0, 200), via }),
        "utf8",
      );
    } catch (err) {
      this.logger.warn(`dsh-word-vault: 提示文件写入失败 - ${err.message}`);
    }
    this.pushLog({ kind: "prompt", id, wordCount: all.length, words: all, via });
    return { id, wordCount: all.length, words: all };
  }

  async resolveUser(nameOrId) {
    const wanted = nameOrId || this.config.defaultUser;
    let row = findUser(this.db, wanted);
    if (!row) row = ensureUser(this.db, String(wanted), "", true);
    return row;
  }

  /**
   * 一段文本 → 词条入库。
   * @returns {Promise<{ok:boolean, user:string, captureId:string, added:number, repeated:number, terms:string[], message:string}>}
   */
  async ingest(text, { user, via = "manual", source = "text", ts = null, kind = "commit", pendingId = "" } = {}) {
    const cfg = this.config;
    const userRow = typeof user === "object" && user ? user : await this.resolveUser(user);
    if (!cfg.enabled) {
      const message = "插件已停用";
      this.writeResult({ ok: false, message, captureId: "", user: userRow.name, todayCount: this.todayFor(userRow), kind });
      return { ok: false, user: userRow.name, captureId: "", added: 0, repeated: 0, terms: [], message };
    }

    const extra = new Set(cfg.words.extraStopwords || []);
    const extracted = extractCandidates(text, { extraStopwords: extra, maxPhraseWords: 5 });
    const limited = extracted.words.slice(0, cfg.words.maxWordsPerCapture);
    const phrases = cfg.words.keepPhrases ? extracted.phrases.slice(0, 1) : [];
    if (!limited.length && !phrases.length) {
      const message = UI_TEXT.noWordMsg;
      this.pushLog({ kind: "skip", text, reason: "no-english-word" });
      this.writeResult({ ok: false, message, captureId: "", user: userRow.name, todayCount: this.todayFor(userRow), kind });
      return { ok: false, user: userRow.name, captureId: "", added: 0, repeated: 0, terms: [], message };
    }

    const terms = limited.map((w) => ({ term: w.word, lemma: w.lemma, kind: "word" }));
    for (const p of phrases) terms.push({ term: p, lemma: p, kind: "phrase" });

    // 先落库并立刻回执("已录入成功"不能等 LLM),翻译随后补进词典缓存
    const res = recordEntries(this.db, {
      userId: userRow.id,
      entries: terms,
      kind: via === "exam" ? "exam" : "hotkey",
      via,
      context: text,
    });

    const added = res.items.filter((i) => i.status === "new").length;
    const repeated = res.items.length - added;
    const today = this.todayFor(userRow);
    const message = UI_TEXT.okBody
      .replace("{0}", String(res.items.length))
      .replace("{1}", userRow.name);

    this.lastCaptureId = res.captureId;
    this.lastUser = userRow.name;
    if (pendingId) this.pending.delete(pendingId);
    this.pushLog({
      kind: "ingest",
      user: userRow.name,
      via,
      captureId: res.captureId,
      added,
      repeated,
      todayCount: today,
      terms: res.items.map((i) => ({ term: i.term, status: i.status, seenCount: i.seenCount, meaning: this.meaningOf(i.lemma) })),
      text: text.slice(0, 300),
      source,
      ts,
    });
    this.writeResult({
      ok: true,
      message,
      detail: `${UI_TEXT.okBody.replace("{0}", String(added)).replace("{1}", userRow.name)} / 重复 ${repeated}`,
      captureId: res.captureId,
      user: userRow.name,
      added,
      repeated,
      todayCount: today,
      kind,
      id: pendingId,
      at: res.at,
    });
    // 回执已写(弹窗立刻显示成功),再补翻译;await 让调用方/tool 拿到的是最终状态
    try {
      await this.translateMissing(terms);
    } catch (err) {
      this.logger.warn(`dsh-word-vault: 补翻译失败 - ${err.message}`);
    }

    return {
      ok: true,
      user: userRow.name,
      captureId: res.captureId,
      added,
      repeated,
      todayCount: today,
      terms: res.items.map((i) => i.term),
      lemmas: res.items.map((i) => i.lemma),
      message,
    };
  }

  /**
   * 补翻译:只翻词典缓存里还没有的词,结果写进 dict(词条通过 JOIN 取释义)。
   * 放在落库之后调用,所以"已录入成功"的回执不等 LLM。
   */
  async translateMissing(terms) {
    const cfg = this.config;
    if (!cfg.autoTranslate) return { translated: 0, skipped: true };
    const needs = [];
    for (const t of Array.isArray(terms) ? terms : []) {
      const lemma = String(t && t.lemma ? t.lemma : t).trim().toLowerCase();
      if (!lemma) continue;
      const row = this.db.prepare("SELECT term FROM dict WHERE term = ?").get(lemma);
      if (!row) needs.push({ term: lemma });
    }
    if (!needs.length) return { translated: 0, skipped: false };
    const map = await translateWords({
      llm: this.getLlm(),
      provider: cfg.provider,
      model: cfg.model,
      words: needs,
      logger: this.logger,
    });
    if (!map.size) return { translated: 0, skipped: false };
    upsertDict(
      this.db,
      [...map.entries()].map(([term, v]) => ({
        term,
        kind: term.includes(" ") ? "phrase" : "word",
        phonetic: v.phonetic,
        pos: v.pos,
        meaning: v.meaning,
        source: "llm",
      })),
    );
    return { translated: map.size, skipped: false };
  }

  meaningOf(lemma) {
    const row = this.db.prepare("SELECT meaning FROM dict WHERE term = ?").get(String(lemma).toLowerCase());
    return row ? row.meaning : "";
  }

  /** 助手命令:弹窗点选(commit / dismiss)与旧的改库 / 撤销 */
  async handleCommand(cmd) {
    const action = String(cmd.action || "");
    const id = String(cmd.id || "");

    // 弹窗点选:commit = 入到所选用户,dismiss = 丢弃
    if (action === "commit") {
      const p = this.pending.get(id);
      if (!p) {
        this.writeResult({ ok: false, message: "这次待入库的内容已过期,请重新复制", todayCount: this.todayFor(null), kind: "commit", id });
        return;
      }
      const user = await this.resolveUser(cmd.user);
      await this.ingest(p.text, { user, via: p.via || "clipboard", kind: "commit", pendingId: id });
      return;
    }
    if (action === "dismiss") {
      const had = this.pending.delete(id);
      this.pushLog({ kind: "dismiss", id, hadPending: had });
      this.writeResult({
        ok: true,
        message: UI_TEXT.ignored,
        todayCount: this.todayFor(null),
        kind: "dismiss",
        id,
      });
      return;
    }

    const captureId = String(cmd.captureId || "");
    if (!captureId) return;
    if (action === "undo") {
      const r = undoCapture(this.db, captureId);
      const message = r.ok
        ? `已撤销上一次录入(删除新建 ${r.removedWords} 词,回退计数 ${r.adjustedWords} 词)`
        : `撤销失败:${r.error}`;
      this.writeResult({ ok: r.ok, message, captureId, user: this.lastUser || "", todayCount: this.todayFor(this.lastUser), kind: "undo" });
      this.pushLog({ kind: "undo", captureId, result: r });
      return;
    }
    if (action === "reassign") {
      const target = findUser(this.db, cmd.user);
      if (!target) {
        this.writeResult({ ok: false, message: `没有这个用户:${cmd.user}`, captureId, user: "", todayCount: this.todayFor(null), kind: "reassign" });
        return;
      }
      const r = reassignCapture(this.db, captureId, target.id);
      const message = r.ok ? `已改到 ${target.name}(${r.moved} 词)` : `改库失败:${r.error}`;
      if (r.ok) {
        this.lastCaptureId = r.newCaptureId;
        this.lastUser = target.name;
      }
      this.writeResult({
        ok: r.ok,
        message,
        captureId: r.ok ? r.newCaptureId : captureId,
        user: target.name,
        todayCount: this.todayFor(target.name),
        kind: "reassign",
      });
      this.pushLog({ kind: "reassign", captureId, to: target.name, result: r });
    }
  }

  writeResult(obj) {
    const payload = { at: new Date().toISOString().slice(11, 19), ...obj };
    try {
      writeFileSync(this.resultPath, JSON.stringify(payload), "utf8");
    } catch (err) {
      this.logger.warn(`dsh-word-vault: 回执写入失败 - ${err.message}`);
    }
    this.onEvent({ type: "result", payload });
  }

  pushLog(entry) {
    this.log.push({ at: new Date().toISOString(), ...entry });
    const cap = Math.max(10, this.config.logTail || 200);
    if (this.log.length > cap) this.log.splice(0, this.log.length - cap);
    this.onEvent({ type: "log", entry });
  }

  recentLog(limit = 20) {
    const n = Math.max(1, Math.min(500, Number(limit) || 20));
    return this.log.slice(-n);
  }
}

/** 纯函数式写 JSON 配置(便于测试) */
export function configToFile(path, obj) {
  writeFileSync(path, JSON.stringify(obj, null, 2), "utf8");
  return path;
}
