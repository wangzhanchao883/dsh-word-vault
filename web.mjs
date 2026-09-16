/**
 * P5.1 词库总览页(宿主侧路由版)。
 *
 * 载体选择(用户 2026-09-16 定):挂在 DSH 的 Web 服务器上 —— 官方文档
 * `docs/subsystems/web-server.md` 提供 `ctx.webServer.register({kind, path, handler})`,
 * 于是页面就在同一个 GUI 端口下:`http://127.0.0.1:3080/word-vault`。
 * 好处:不需要客户端半边(client bundle 要走官方未发布的 lazy-CJS 工厂预设)、不需要重建 Web、
 * 零新依赖;同源 fetch 自带浏览器会话 cookie,鉴权由 DSH 既有机制负责。
 *
 * 本阶段(P5.1)只读:统计卡 + 四组视图(全部/已记住/没记住/高频易错) + 搜索 + 排序 + 表格。
 * 写操作(改释义/删词/批量清理)与动作按钮(出卡/出卷/开始答题)留到 P5.2。
 */
import { nowIso } from "./db.mjs";

/** 页面与 API 共用的路由前缀(prefix 路由:'/word-vault' 同时匹配它自己与子路径) */
export const WEB_PATH = "/word-vault";

export const GROUP_LABELS = {
  all: "全部",
  mastered: "已记住",
  learning: "没记住",
  hot: "高频易错",
};

const SORTS = {
  count: "标记次数↓",
  recent: "最近录入",
  oldest: "最早录入",
  alpha: "字母序",
};

/** 一行展示数据(只读) */
function toRow(r, { highFreqMin, meta }) {
  return {
    word: r.lemma,
    term: r.term,
    phonetic: r.phonetic || "",
    pos: r.pos || "",
    meaning: r.meaning || "",
    seenCount: r.seen_count,
    highFreq: r.seen_count >= highFreqMin,
    status: r.status,
    statusLabel: r.status === "mastered" ? "已记住" : r.status === "half" ? "半掌握" : "没记住",
    streak: r.streak,
    wrongCount: r.wrong_count,
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at,
    hasCard: !!r.card_updated_at,
    via: (meta && meta.via) || "",
    context: (meta && meta.context) || "",
  };
}

/**
 * 组装总览页需要的数据(纯函数式,便于单测)。
 * @param {{db:any, queryWords:Function, stats:Function, cardStats:Function, userId:number, userName:string,
 *          highFreqMin:number, group?:string, q?:string, sort?:string, limit?:number}} args
 */
export function buildLibraryPayload({
  db, queryWords, stats, cardStats, userId, userName,
  highFreqMin = 2, group = "all", q = "", sort = "count", limit = 500,
}) {
  const allRows = queryWords(db, { userId, kind: undefined, orderBy: "count", limit: 5000 });

  // 每个词的"来源":取最近一次录入的 via 与原文片段(events 里没有独立 source 列)
  const latest = new Map();
  for (const e of db.prepare("SELECT word_id, via, context FROM events WHERE user_id = ? ORDER BY id DESC").all(userId)) {
    if (!latest.has(e.word_id)) latest.set(e.word_id, { via: e.via || "", context: String(e.context || "").replace(/\s+/g, " ").slice(0, 60) });
  }

  const rows = allRows.map((r) => toRow(r, { highFreqMin, meta: latest.get(r.id) }));
  const isLearning = (r) => r.status !== "mastered";
  const isHot = (r) => r.highFreq && isLearning(r);

  const groups = {
    all: rows.length,
    mastered: rows.filter((r) => r.status === "mastered").length,
    learning: rows.filter(isLearning).length,
    // 高频词与高频易错都按**全库**统计(不能拿筛选后的行去数,否则切 tab 时数字会变)
    highFreq: rows.filter((r) => r.highFreq).length,
    hot: rows.filter(isHot).length,
  };

  let list = rows;
  if (group === "mastered") list = rows.filter((r) => r.status === "mastered");
  else if (group === "learning") list = rows.filter(isLearning);
  else if (group === "hot") list = rows.filter(isHot);

  const needle = String(q || "").trim().toLowerCase();
  if (needle) {
    list = list.filter(
      (r) =>
        r.word.toLowerCase().includes(needle) ||
        r.term.toLowerCase().includes(needle) ||
        r.meaning.toLowerCase().includes(needle) ||
        r.pos.toLowerCase().includes(needle),
    );
  }

  const sorted = [...list];
  if (sort === "alpha") sorted.sort((a, b) => a.word.localeCompare(b.word));
  else if (sort === "recent") sorted.sort((a, b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)));
  else if (sort === "oldest") sorted.sort((a, b) => String(a.firstSeenAt).localeCompare(String(b.firstSeenAt)));
  else sorted.sort((a, b) => b.seenCount - a.seenCount || a.word.localeCompare(b.word));

  const max = Math.max(1, Math.min(2000, Number(limit) || 500));
  return {
    generatedAt: nowIso(),
    user: userName,
    highFreqMin,
    groups,
    total: rows.length,
    matched: sorted.length,
    shown: Math.min(max, sorted.length),
    group,
    groupLabel: GROUP_LABELS[group] || GROUP_LABELS.all,
    sort,
    sortLabel: SORTS[sort] || SORTS.count,
    q: String(q || ""),
    stats: stats(db, userId),
    cards: cardStats(db, userId),
    rows: sorted.slice(0, max),
  };
}

/** 总览页 HTML(自包含,无外部资源;所有数据经 /word-vault/api/library 同源获取) */
export function buildLibraryPageHtml({ userName = "", highFreqMin = 2 } = {}) {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>英语生词库 · 总览</title><style>
:root { --blue:#1f5a94; --soft:#eef4fb; --line:#cfdbe6; --hot:#c0392b; --ok:#2f9e63; --ink:#1b2a3a; --gray:#7a8b9c; }
* { box-sizing: border-box; }
body { margin:0; font-family:"Microsoft YaHei","微软雅黑",sans-serif; color:var(--ink); background:#f7fafd; }
.wrap { max-width: 1180px; margin: 0 auto; padding: 20px 18px 60px; }
h1 { font-size: 21px; margin: 4px 0 2px; }
h1 small { font-size: 12px; font-weight: 400; color:var(--gray); margin-left: 10px; }
.cards { display:grid; grid-template-columns: repeat(auto-fit,minmax(150px,1fr)); gap:10px; margin:14px 0 16px; }
.kpi { background:#fff; border:1px solid var(--line); border-radius:10px; padding:12px 14px; }
.kpi .n { font-size:24px; font-weight:700; color:var(--blue); }
.kpi.hot .n { color:var(--hot); }
.kpi.ok .n { color:var(--ok); }
.kpi .l { font-size:12px; color:var(--gray); margin-top:2px; }
.bar { display:flex; flex-wrap:wrap; gap:8px; align-items:center; background:#fff; border:1px solid var(--line); border-radius:10px; padding:10px 12px; }
.tab { font-size:14px; padding:7px 14px; border-radius:999px; border:1px solid var(--line); background:var(--soft); cursor:pointer; color:var(--ink); }
.tab.on { background:var(--blue); border-color:var(--blue); color:#fff; font-weight:700; }
.tab .c { font-size:12px; opacity:.8; margin-left:4px; }
input[type=search], select { font-size:14px; padding:7px 10px; border:1px solid var(--line); border-radius:8px; background:#fff; color:var(--ink); }
input[type=search] { min-width:220px; }
.spacer { flex:1 1 auto; }
table { width:100%; border-collapse:collapse; background:#fff; border:1px solid var(--line); border-radius:10px; overflow:hidden; margin-top:14px; font-size:13px; }
th, td { padding:8px 10px; border-bottom:1px solid #eaf1f7; text-align:left; vertical-align:top; }
th { background:var(--soft); font-size:12px; color:#41556b; position:sticky; top:0; }
tr:last-child td { border-bottom:none; }
.w { font-family:"Segoe UI",Arial,sans-serif; font-size:15px; font-weight:700; }
.pill { display:inline-block; font-size:11px; border-radius:999px; padding:1px 7px; margin-left:6px; border:1px solid; }
.pill.hot { color:var(--hot); border-color:#e8b7a8; background:#fdf1ee; font-weight:700; }
.pill.ok { color:var(--ok); border-color:#a9d9bf; background:#eaf7f0; }
.pill.no { color:#8a6d1f; border-color:#e6d39a; background:#fdf7e3; }
.meta { color:var(--gray); font-size:12px; }
.src { color:#5c6f82; font-size:11px; max-width:260px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.note { margin-top:16px; background:#fff; border:1px solid var(--line); border-left:3px solid var(--blue); border-radius:8px; padding:12px 14px; font-size:13px; line-height:1.8; }
.note b { color:var(--blue); }
.err { background:#fdeaea; border-color:#e0b4b4; color:#8b2f2f; }
.tag { font-size:11px; color:var(--gray); }
</style></head><body><div class="wrap">
<h1>英语生词库 · 总览<small>用户 ${escapeHtml(userName)} · 高频门槛 标记 ≥${highFreqMin} 次 · P5.1 只读版</small></h1>
<div class="cards" id="kpis"></div>
<div class="bar">
  <span id="tabs"></span>
  <span class="spacer"></span>
  <input type="search" id="q" placeholder="搜索单词 / 释义 / 词性">
  <select id="sort"></select>
  <button class="tab" id="reload">刷新</button>
</div>
<table><thead><tr>
  <th>单词</th><th>音标</th><th>词性 · 释义</th><th>标记次数</th><th>状态</th><th>连对</th><th>考错</th><th>最近出现</th><th>首见</th><th>来源（via / 原文片段）</th>
</tr></thead><tbody id="rows"><tr><td colspan="10" class="meta">加载中…</td></tr></tbody></table>
<div class="note" id="note">
  <b>怎么用这个库</b>：① 电脑上复制英文（课本/试卷/网页）→ 鼠标处弹窗点选归到哪个用户；② 拍作业照片 → 我会扫描出被荧光笔或红笔标记的<b>印刷体</b>词并入库；③ 记忆卡与试卷在对话里让我出（P5.2 会把按钮搬到这里）。<br>
  <b>四个分组</b>：<b>已记住</b>=连续答对 3 次；<b>没记住</b>=还没打上已记住；<b>高频易错</b>=被标记次数 ≥ ${highFreqMin} 次且尚未记住（这些最该优先考）；<b>标记次数</b>=这个词被录入/被标记过几次，次数越高说明反复遇到。<br>
  <b>来源列</b>：显示最近一次录入的渠道与原文片段。若看到 <span class="tag">entities / monorepo / --flag</span> 这类片段，说明当时复制的不是课本内容，可到 P5.2 勾选删除。
</div>
</div>
<script>
const API = ${JSON.stringify(WEB_PATH)} + '/api/library';
const SORTS = ${JSON.stringify(SORTS)};
const GROUPS = ${JSON.stringify(GROUP_LABELS)};
const state = { group: 'all', q: '', sort: 'count' };

function esc(v) { return String(v == null ? '' : v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function renderTabs(groups) {
  document.getElementById('tabs').innerHTML = Object.keys(GROUPS).map((g) =>
    '<button class="tab' + (state.group === g ? ' on' : '') + '" data-g="' + g + '">' + GROUPS[g] +
    '<span class="c">' + (groups[g] ?? 0) + '</span></button>').join('');
  document.querySelectorAll('#tabs .tab').forEach((b) => b.addEventListener('click', () => { state.group = b.dataset.g; load(); }));
}

function renderSort() {
  const sel = document.getElementById('sort');
  sel.innerHTML = Object.keys(SORTS).map((s) => '<option value="' + s + '"' + (state.sort === s ? ' selected' : '') + '>' + SORTS[s] + '</option>').join('');
  sel.onchange = () => { state.sort = sel.value; load(); };
}

function renderKpis(p) {
  const items = [
    { l: '总词数', n: p.total },
    { l: '已记住', n: p.groups.mastered, cls: 'ok' },
    { l: '没记住', n: p.groups.learning },
    { l: '高频词（≥' + p.highFreqMin + ' 次）', n: p.groups.highFreq },
    { l: '高频易错（高频且没记住）', n: p.groups.hot, cls: 'hot' },
    { l: '已有记忆卡', n: p.cards.withCard || 0 },
  ];
  document.getElementById('kpis').innerHTML = items.map((i) =>
    '<div class="kpi ' + (i.cls || '') + '"><div class="n">' + i.n + '</div><div class="l">' + esc(i.l) + '</div></div>').join('');
}

function renderRows(p) {
  const tb = document.getElementById('rows');
  if (!p.rows.length) { tb.innerHTML = '<tr><td colspan="10" class="meta">没有匹配的词。</td></tr>'; return; }
  tb.innerHTML = p.rows.map((r) => {
    const pills =
      (r.highFreq ? '<span class="pill hot">标记 ' + r.seenCount + ' 次</span>' : '') +
      (r.status === 'mastered' ? '<span class="pill ok">已记住</span>' : '<span class="pill no">没记住</span>');
    return '<tr>' +
      '<td><span class="w">' + esc(r.word) + '</span>' + pills + '</td>' +
      '<td class="meta">' + esc(r.phonetic) + '</td>' +
      '<td>' + (r.pos ? '<span class="meta">' + esc(r.pos) + '</span> ' : '') + esc(r.meaning) + '</td>' +
      '<td>' + r.seenCount + '</td>' +
      '<td>' + esc(r.statusLabel) + '</td>' +
      '<td>' + r.streak + '/3</td>' +
      '<td>' + r.wrongCount + '</td>' +
      '<td class="meta">' + esc(String(r.lastSeenAt || '').slice(5, 16)) + '</td>' +
      '<td class="meta">' + esc(String(r.firstSeenAt || '').slice(5, 16)) + '</td>' +
      '<td class="src" title="' + esc(r.via + ' · ' + r.context) + '">' + esc(r.via) + (r.context ? ' · ' + esc(r.context) : '') + '</td>' +
      '</tr>';
  }).join('');
}

async function load() {
  const url = API + '?group=' + encodeURIComponent(state.group) + '&q=' + encodeURIComponent(state.q) + '&sort=' + encodeURIComponent(state.sort);
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const p = await res.json();
    renderTabs(p.groups); renderKpis(p); renderRows(p);
    document.querySelector('h1 small').textContent =
      '用户 ' + p.user + ' · 高频门槛 标记 ≥' + p.highFreqMin + ' 次 · 匹配 ' + p.matched + ' / 共 ' + p.total + ' 词 · 更新于 ' + String(p.generatedAt).slice(11, 19);
  } catch (err) {
    document.getElementById('rows').innerHTML = '<tr><td colspan="10" class="err">读取失败：' + esc(err.message) + '（请确认已用浏览器打开 DSH 界面并保持 DSH 在运行）</td></tr>';
  }
}

const q = document.getElementById('q');
let timer = null;
q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { state.q = q.value; load(); }, 200); });
document.getElementById('reload').addEventListener('click', load);
renderSort(); load();
</script></body></html>`;
}

function escapeHtml(v) {
  return String(v == null ? "" : v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * 挂载宿主路由(progressive injection:没有 webServer 服务时静默跳过,headless profile 不受影响)。
 * @param {any} ctx 插件 ctx
 * @param {{db:any, queryWords:Function, stats:Function, cardStats:Function, liveConfig:any, logger:any}} deps
 * @returns {boolean} 是否已注册(服务可用)
 */
export function registerWebUi(ctx, { db, queryWords, stats, cardStats, liveConfig, logger }) {
  let registered = false;
  ctx.inject(["webServer"], (webCtx) => {
    const send = (res, code, body, type) => {
      res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
      res.end(body);
    };
    const disposer = webCtx.webServer.register({
      kind: "prefix",
      path: WEB_PATH,
      handler: async (req, res) => {
        const url = new URL(req.url || "/", "http://127.0.0.1");
        const sub = url.pathname.slice(WEB_PATH.length) || "/";
        try {
          if (req.method !== "GET" && req.method !== "HEAD") {
            send(res, 405, JSON.stringify({ ok: false, error: "只支持 GET" }), "application/json; charset=utf-8");
            return;
          }
          if (sub === "/" || sub === "") {
            send(res, 200, buildLibraryPageHtml({ userName: liveConfig.defaultUser, highFreqMin: liveConfig.highFreqMin }), "text/html; charset=utf-8");
            return;
          }
          if (sub === "/api/library") {
            const user = db.prepare("SELECT * FROM users WHERE name = ?").get(String(url.searchParams.get("user") || liveConfig.defaultUser));
            if (!user) {
              send(res, 404, JSON.stringify({ ok: false, error: "没有这个用户" }), "application/json; charset=utf-8");
              return;
            }
            const payload = buildLibraryPayload({
              db, queryWords, stats, cardStats,
              userId: user.id,
              userName: user.name,
              highFreqMin: liveConfig.highFreqMin,
              group: url.searchParams.get("group") || "all",
              q: url.searchParams.get("q") || "",
              sort: url.searchParams.get("sort") || "count",
              limit: Number(url.searchParams.get("limit")) || 500,
            });
            send(res, 200, JSON.stringify(payload), "application/json; charset=utf-8");
            return;
          }
          send(res, 404, JSON.stringify({ ok: false, error: "未知路径" }), "application/json; charset=utf-8");
        } catch (err) {
          if (logger) logger.warn(`dsh-word-vault: 词库页面出错 - ${err && err.message ? err.message : err}`);
          send(res, 500, JSON.stringify({ ok: false, error: String(err && err.message ? err.message : err) }), "application/json; charset=utf-8");
        }
      },
    });
    registered = true;
    if (logger) logger.info(`dsh-word-vault: 词库总览页已挂载 -> ${WEB_PATH}`);
    // 注册即 effect:插件卸载时自动摘掉路由
    ctx.effect(() => disposer);
    return webCtx;
  });
  return registered;
}
