/* dsh-word-vault client bundle — 浏览器半端(Web 设置页)。
 * 以经典脚本形式注册到 window.__ModuleLoader__;工厂内用 require 取 React,
 * 不能用 JSX(无构建步骤),一律 React.createElement。
 * 与 dsh-study-notebook / dsh-screenshot-capture 的 client.js 同款模式:
 *   - 槽位 settings.section,id 决定左侧入口,label() 是入口文字
 *   - 读写走 ctx.settingsScope.bind({namespace});scope.set(field, value) 只支持单段路径,
 *     所以 host 侧 schema 保持扁平,分组只是本文件的展示结构
 *   - 配色一律用 DSH 主题变量(--dsw-alias-*),跟随明暗主题;括号里给降级色,便于离线预览
 */
window.__ModuleLoader__.load({
  id: "dsh-word-vault",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require("react");
    const h = React.createElement;
    const { useEffect, useRef, useState } = React;

    const NS = "settings.wordVault";
    const SETTINGS_NAMESPACE = "dsh-word-vault";
    const WEB_PATH = "/word-vault";

    const zh = {
      nav: "英语生词库",
      loading: "正在读取配置…",
      unavailable: "配置面板不可用(设置服务未挂载)。可改用 http://127.0.0.1:3080/word-vault/settings",
      saved: "已保存",
      error: "保存失败:",
      tip: "与 DSH 设置页读写同一份配置；改完即时生效(涉及常驻助手的项会自动重启助手)。",
      openLibrary: "打开词库界面",
      openHelp: "使用说明",

      gUsers: "用户库改名",
      renameBtn: "改名",
      renamed: "已改名",
      renameHint: "改成「哥哥」「妹妹」这类好认的名字；改名后词条与录入记录都还在，弹窗点选会立刻用新名字",
      gGeneral: "通用",
      enabled: "启用插件",
      enabledHint: "关掉后不落库、不起助手进程，工具会返回停用说明",
      dbPath: "词库数据库文件",
      dbPathHint: "SQLite 单文件；不在插件仓库里，回滚代码不会动你的词",
      outputDir: "产物输出目录",
      outputDirHint: "记忆卡 / 试卷 / 预览图都落在这里",

      gCapture: "录入",
      autoCommit: "复制后直接入库（不弹窗点选）",
      autoCommitHint: "默认关：必须点选归属用户才入库。开了会把普通复制也当成生词录进来",
      showFloatWindow: "显示常驻监听小条",
      showFloatWindowHint: "小条可拖动并记忆位置；关掉后不再监听剪贴板",
      autoTranslate: "录入时自动翻译",
      autoTranslateHint: "关掉则只记词形，出卡/出卷时会自动补翻译",
      keepPhrases: "2~5 词短句另存为「词组」",
      keepPhrasesHint: "关掉则只收单词，不收词组条目",
      promptTimeoutMs: "弹窗等待上限（毫秒）",
      promptTimeoutMsHint: "超时自动消失且不入库；0 = 一直等",
      maxWordsPerCapture: "单次录入最多收多少词",
      maxWordsPerCaptureHint: "防止一次复制长文把词库灌满",

      gReview: "复习口径",
      highFreqMin: "高频词门槛（被标记几次算高频）",
      highFreqMinHint: "累计被标记达到这个次数就算高频；「高频易错」= 高频且尚未记住，最该优先考",

      gCards: "记忆卡",
      cardsTitle: "卡片页眉主标题",
      cardsSubtitle: "页眉副标题（留空自动生成）",
      cardsBatchSize: "每次交给模型几个词做拆词",

      gExam: "考试",
      examCount: "默认出多少题",
      examRecheckRatio: "已学会词抽查比例",
      examRecheckRatioHint: "抽查答错会自动摘牌",
      examMinutes: "答题页空闲自动关闭（分钟）",

      gPhoto: "照片",
      photoDir: "照片目录（往里丢照片就能扫）",
      photoDirHint: "也可以直接在对话里发照片给我",
      photoOutDir: "裁剪与联络图输出目录",
      photoKeepCrops: "保留逐块裁剪 PNG",
      photoKeepCropsHint: "关掉只留联络图，省磁盘",
      photoSatMin: "标记墨迹最低饱和度",
      photoSatMinHint: "调低=更敏感（可能把浅色印刷也当标记），调高=更严格",
      photoPadUp: "裁剪上方多留像素",
      photoPadUpHint: "红线在词下方，必须上扩才能把被标记的词带进来",
      photoMaxPerRun: "每次最多处理几张新照片",
    };

    const en = {
      nav: "Word Vault",
      loading: "Loading configuration…",
      unavailable: "Config panel unavailable (settings service not mounted). Use /word-vault/settings instead.",
      saved: "Saved",
      error: "Save failed:",
      tip: "Same configuration as the DSH settings page; changes apply immediately (the helper restarts when needed).",
      openLibrary: "Open library UI",
      openHelp: "Help",
      gUsers: "User libraries",
      renameBtn: "Rename",
      renamed: "Renamed",
      renameHint: "Give each library a recognizable name; words and history are kept",
      gGeneral: "General",
      enabled: "Enable plugin",
      dbPath: "Word database file",
      outputDir: "Output directory",
      gCapture: "Capture",
      autoCommit: "Commit clipboard captures without picking a user",
      showFloatWindow: "Show the always-on status chip",
      autoTranslate: "Translate on capture",
      keepPhrases: "Keep 2-5 word phrases as separate entries",
      promptTimeoutMs: "Pick dialog timeout (ms)",
      maxWordsPerCapture: "Max words per capture",
      gReview: "Review policy",
      highFreqMin: "High-frequency threshold (marks)",
      gCards: "Memory cards",
      cardsTitle: "Card header title",
      cardsSubtitle: "Card header subtitle",
      cardsBatchSize: "Words per model call",
      gExam: "Exam",
      examCount: "Questions per exam",
      examRecheckRatio: "Re-check ratio for learned words",
      examMinutes: "Close idle answer page after (minutes)",
      gPhoto: "Photos",
      photoDir: "Photo folder",
      photoOutDir: "Crops / contact sheet folder",
      photoKeepCrops: "Keep per-region crop PNGs",
      photoSatMin: "Minimum marker saturation",
      photoPadUp: "Crop padding above the mark (px)",
      photoMaxPerRun: "Max new photos per run",
    };

    /* 配色全部走 DSH 主题变量(与 dsh-study-notebook 的 client.js 一致),括号内为离线预览的降级色 */
    const CSS = [
      ".wv-config{max-width:720px;display:flex;flex-direction:column;gap:16px;color:var(--dsw-alias-label-primary,#1b2a3a)}",
      ".wv-tip{font-size:12px;color:var(--dsw-alias-label-tertiary,#8798a8);margin:0;line-height:1.7}",
      ".wv-group{border:1px solid var(--dsw-alias-border-l2,#cfdbe6);border-radius:10px;padding:14px;background:var(--dsw-alias-bg-layer-2,#fff)}",
      ".wv-group h3{margin:0 0 12px;font-size:13px;font-weight:600}",
      ".wv-field{display:flex;flex-direction:column;gap:4px;margin-bottom:10px}",
      ".wv-field:last-child{margin-bottom:0}",
      ".wv-field label{font-size:12px;font-weight:500}",
      ".wv-field input[type=text],.wv-field input[type=number]{height:30px;border:1px solid var(--dsw-alias-border-l2,#cfdbe6);background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1b2a3a);border-radius:6px;padding:0 8px;font:inherit;font-size:13px;box-sizing:border-box;width:100%}",
      ".wv-hint{font-size:11px;color:var(--dsw-alias-label-tertiary,#8798a8);line-height:1.6}",
      ".wv-switch{display:flex;align-items:center;gap:8px;margin-bottom:6px}",
      ".wv-switch input{accent-color:var(--dsw-alias-state-business-primary,#1f5a94)}",
      ".wv-switch label{font-size:12px;font-weight:500}",
      ".wv-status{font-size:12px;color:var(--dsw-alias-label-tertiary,#8798a8);min-height:16px}",
      ".wv-status.ok{color:var(--dsw-alias-state-business-primary,#2f9e63)}",
      ".wv-status.err{color:#c0392b}",
      ".wv-row{display:flex;gap:12px}",
      ".wv-row .wv-field{flex:1}",
      ".wv-btn{height:30px;border:1px solid var(--dsw-alias-border-l2,#cfdbe6);background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1b2a3a);border-radius:6px;padding:0 12px;font:inherit;font-size:13px;cursor:pointer;white-space:nowrap}",
      ".wv-links{display:flex;gap:8px}",
      ".wv-link{font-size:13px;text-decoration:none;color:var(--dsw-alias-label-primary,#1f5a94);border:1px solid var(--dsw-alias-border-l2,#cfdbe6);border-radius:8px;padding:6px 14px;background:var(--dsw-alias-bg-layer-1,#fff)}",
    ].join("");

    /** 文本/数字:本地草稿,失焦或回车才提交 */
    function TextInput({ value, type, onCommit }) {
      const [draft, setDraft] = useState(value === undefined || value === null ? "" : String(value));
      useEffect(() => {
        setDraft(value === undefined || value === null ? "" : String(value));
      }, [value]);
      return h("input", {
        type: type === "number" ? "number" : "text",
        value: draft,
        onChange: (e) => setDraft(e.target.value),
        onBlur: () => {
          const next = type === "number" ? Number(draft) : draft;
          if (String(next) !== String(value)) onCommit(next);
        },
        onKeyDown: (e) => {
          if (e.key === "Enter") e.target.blur();
        },
      });
    }

    /** 字段容器:标签在上、提示在下(与 dsh-study-notebook 的 .snn-field 同构) */
    function Field({ label, hint, children }) {
      return h("div", { className: "wv-field" }, h("label", null, label), children, hint ? h("div", { className: "wv-hint" }, hint) : null);
    }

    /** 用户库改名:输入新名字后回车或点按钮,走宿主路由(库名与设置一起改) */
    function RenameRow({ name, t, onRename }) {
      const [draft, setDraft] = useState(name);
      useEffect(() => setDraft(name), [name]);
      const submit = () => onRename(name, draft);
      return h("div", { className: "wv-field" },
        h("label", null, name),
        h("div", { className: "wv-row" },
          h("div", { className: "wv-field" }, h("input", {
            type: "text", value: draft,
            onChange: (e) => setDraft(e.target.value),
            onBlur: () => { if (draft && draft !== name) submit(); },
            onKeyDown: (e) => { if (e.key === "Enter") e.target.blur(); },
          })),
          h("button", { className: "wv-btn", onClick: submit }, t("renameBtn"))),
        h("div", { className: "wv-hint" }, t("renameHint")));
    }

    function ConfigSection({ scope, t }) {
      const [snap, setSnap] = useState(() => scope.getSnapshot());
      const [status, setStatus] = useState({ text: "", cls: "" });
      const timer = useRef(null);
      useEffect(() => scope.subscribe(() => setSnap(scope.getSnapshot())), [scope]);
      useEffect(() => () => {
        if (timer.current) clearTimeout(timer.current);
      }, []);
      const flash = (text, cls) => {
        setStatus({ text, cls });
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setStatus({ text: "", cls: "" }), 2500);
      };
      const save = (field, v) => {
        Promise.resolve(scope.set(field, v))
          .then(() => flash(t("saved"), "ok"))
          .catch((err) => flash(`${t("error")} ${err && err.message ? err.message : String(err)}`, "err"));
      };

      const rename = (from, to) => {
        if (!to || to === from) return;
        fetch(WEB_PATH + "/api/users/rename", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ from: from, to: to }),
        })
          .then((r) => r.json().then((data) => ({ ok: r.ok, data: data })))
          .then((res) => {
            if (!res.ok || res.data.ok === false) throw new Error(res.data.error || "rename failed");
            flash(t("renamed"), "ok");
          })
          .catch((err) => flash(`${t("error")} ${err && err.message ? err.message : String(err)}`, "err"));
      };

      if (snap.status === "loading") return h("p", { className: "wv-tip" }, t("loading"));
      if (snap.status === "unavailable") return h("p", { className: "wv-tip" }, t("unavailable"));
      const v = snap.value || {};

      const text = (field, type, hintKey) =>
        h(Field, { key: field, label: t(field), hint: hintKey ? t(hintKey) : undefined },
          h(TextInput, { value: v[field], type, onCommit: (next) => save(field, next) }));
      const toggle = (field, hintKey) =>
        h("div", { className: "wv-field", key: field },
          h("div", { className: "wv-switch" },
            h("input", { type: "checkbox", checked: !!v[field], onChange: (e) => save(field, e.target.checked) }),
            h("label", null, t(field))),
          hintKey ? h("div", { className: "wv-hint" }, t(hintKey)) : null);
      const pair = (...nodes) => h("div", { className: "wv-row" }, nodes);
      const group = (title, children) => h("div", { className: "wv-group", key: title }, h("h3", null, title), children);

      return h("div", { className: "wv-config" }, [
        h("p", { className: "wv-tip", key: "tip" }, [
          t("tip"),
          status.text ? h("span", { className: "wv-status " + status.cls, key: "st" }, " " + status.text) : null,
        ]),
        v.users && v.users.length
          ? group(t("gUsers"), v.users.map((u) => h(RenameRow, { key: u.name, name: u.name, t: t, onRename: rename })))
          : null,
        group(t("gGeneral"), [
          toggle("enabled", "enabledHint"),
          text("dbPath", "text", "dbPathHint"),
          text("outputDir", "text", "outputDirHint"),
        ]),
        group(t("gCapture"), [
          toggle("autoCommit", "autoCommitHint"),
          toggle("showFloatWindow", "showFloatWindowHint"),
          toggle("autoTranslate", "autoTranslateHint"),
          toggle("keepPhrases", "keepPhrasesHint"),
          pair(text("promptTimeoutMs", "number", "promptTimeoutMsHint"), text("maxWordsPerCapture", "number", "maxWordsPerCaptureHint")),
        ]),
        group(t("gReview"), [text("highFreqMin", "number", "highFreqMinHint")]),
        group(t("gCards"), [text("cardsTitle", "text"), pair(text("cardsSubtitle", "text"), text("cardsBatchSize", "number"))]),
        group(t("gExam"), [
          pair(text("examCount", "number"), text("examRecheckRatio", "number", "examRecheckRatioHint"), text("examMinutes", "number")),
        ]),
        group(t("gPhoto"), [
          text("photoDir", "text", "photoDirHint"),
          text("photoOutDir", "text"),
          toggle("photoKeepCrops", "photoKeepCropsHint"),
          pair(text("photoSatMin", "number", "photoSatMinHint"), text("photoPadUp", "number", "photoPadUpHint"), text("photoMaxPerRun", "number")),
        ]),
        h("div", { className: "wv-links", key: "links" }, [
          h("a", { className: "wv-link", href: WEB_PATH, target: "_blank", rel: "noopener", key: "a" }, t("openLibrary")),
          h("a", { className: "wv-link", href: WEB_PATH + "/help", target: "_blank", rel: "noopener", key: "b" }, t("openHelp")),
        ]),
      ]);
    }

    function apply(ctx) {
      ctx.effect(() => {
        const tag = document.createElement("style");
        tag.setAttribute("data-plugin", "dsh-word-vault");
        tag.textContent = CSS;
        document.head.appendChild(tag);
        return () => {
          if (tag.parentNode) tag.parentNode.removeChild(tag);
        };
      }, "dsh-word-vault: styles");

      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-word-vault: dictionaries");

      const t = ctx.locale.bind(NS);
      const scope = ctx.settingsScope.bind({ namespace: SETTINGS_NAMESPACE });
      const injected = () => ({ scope });

      ctx.slots.inject("settings.section", () =>
        ctx.slots.register(
          {
            name: "settings.section",
            id: "word-vault",
            order: 300,
            label: () => t("nav"),
            locale: NS,
            inject: injected,
          },
          ConfigSection,
        ),
      );
    }

    module.exports = {
      name: "dsh-word-vault",
      inject: ["slots", "locale", "settingsScope"],
      apply,
    };
    return module.exports;
  },
});
