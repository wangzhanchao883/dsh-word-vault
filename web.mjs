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
import { nowIso, updateDictMeaning, wordDeleteImpact, deleteWords, setStatus } from "./db.mjs";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { spawn } from "node:child_process";

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
.actbar { display:flex; flex-wrap:wrap; gap:8px; align-items:center; background:#fff; border:1px solid var(--line); border-radius:10px; padding:10px 12px; margin-top:10px; }
.btn { font-size:13px; padding:7px 14px; border-radius:8px; border:1px solid var(--line); background:var(--soft); color:var(--ink); cursor:pointer; }
.btn:hover:not(:disabled) { border-color:var(--blue); }
.btn.primary { background:var(--blue); border-color:var(--blue); color:#fff; font-weight:700; }
.btn.danger { color:var(--hot); border-color:#e8b7a8; background:#fdf1ee; font-weight:700; }
.btn:disabled { opacity:.5; cursor:default; }
.mini { font-size:11px; padding:3px 8px; border-radius:6px; border:1px solid var(--line); background:#fff; color:#41556b; cursor:pointer; margin-right:4px; }
.mini:hover { border-color:var(--blue); color:var(--blue); }
td.editable { cursor:text; }
td.editable:hover { background:#fbfdff; box-shadow: inset 0 0 0 1px var(--line); }
input.edit { font-size:12px; padding:4px 6px; border:1px solid var(--line); border-radius:6px; margin:0 4px 4px 0; width:150px; }
input.edit.small { width:90px; }
.result { background:#fff; border:1px solid var(--line); border-left:3px solid var(--blue); border-radius:8px; padding:10px 14px; margin-top:10px; font-size:13px; line-height:1.8; word-break:break-all; }
.result.ok { border-left-color:var(--ok); }
.result.err { border-left-color:var(--hot); background:#fdeaea; }
.result.hide { display:none; }
.result code { background:#f2f6fa; padding:1px 5px; border-radius:4px; font-size:12px; }
/* 结果区的主入口:大按钮,点了直接开(答题页 / PDF),不让用户去路径里找 */
a.bigbtn { display:inline-block; margin:6px 8px 2px 0; padding:9px 16px; border-radius:8px; background:var(--blue); color:#fff;
  text-decoration:none; font-size:14px; font-weight:700; }
a.bigbtn:hover { background:#17497a; }
details summary { cursor:pointer; margin-top:6px; }
table { width:100%; border-collapse:collapse; background:#fff; border:1px solid var(--line); border-radius:10px; overflow:hidden; margin-top:14px; font-size:13px; }
th, td { padding:8px 10px; border-bottom:1px solid #eaf1f7; text-align:left; vertical-align:top; white-space:nowrap; }
th { background:var(--soft); font-size:12px; color:#41556b; position:sticky; top:0; }
tr:last-child td { border-bottom:none; }
td.mean { white-space:normal; min-width:180px; }
.w { font-family:"Segoe UI",Arial,sans-serif; font-size:15px; font-weight:700; }
.pill { display:inline-block; font-size:11px; border-radius:999px; padding:1px 7px; margin-left:6px; border:1px solid; }
.pill.hot { color:var(--hot); border-color:#e8b7a8; background:#fdf1ee; font-weight:700; }
.pill.ok { color:var(--ok); border-color:#a9d9bf; background:#eaf7f0; }
.pill.no { color:#8a6d1f; border-color:#e6d39a; background:#fdf7e3; }
.meta { color:var(--gray); font-size:12px; }
.src { color:#5c6f82; font-size:11px; max-width:240px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.note { margin-top:16px; background:#fff; border:1px solid var(--line); border-left:3px solid var(--blue); border-radius:8px; padding:12px 14px; font-size:13px; line-height:1.8; }
.note b { color:var(--blue); }
.err { background:#fdeaea; border-color:#e0b4b4; color:#8b2f2f; }
.tag { font-size:11px; color:var(--gray); }
${NAV_CSS}</style></head><body><div class="wrap">
<h1>英语生词库 · 总览<small>用户 ${escapeHtml(userName)} · 高频门槛 标记 ≥${highFreqMin} 次 · P5.1 只读版</small></h1>
${nav("/")}
<div class="cards" id="kpis"></div>
<div class="bar">
  <span id="tabs"></span>
  <span class="spacer"></span>
  <input type="search" id="q" placeholder="搜索单词 / 释义 / 词性">
  <select id="sort"></select>
  <button class="tab" id="reload">刷新</button>
</div>
<div class="actbar" id="actbar">
  <span class="meta" id="selinfo">未选中</span>
  <button class="btn danger" id="del">删除选中</button>
  <button class="btn" id="markOn">标记已记住</button>
  <button class="btn" id="markOff">标记没记住</button>
  <span class="spacer"></span>
  <span class="meta">对当前筛选：</span>
  <button class="btn primary" id="actCards">出记忆卡</button>
  <button class="btn primary" id="actAnswer">在线答题</button>
  <button class="btn primary" id="actPaper">打印试卷 PDF</button>
</div>
<div class="result hide" id="result"></div>
<table><thead><tr>
  <th style="width:26px"><input type="checkbox" id="all"></th><th>单词</th><th>音标</th><th>词性 · 释义</th><th>次数</th><th>状态</th><th>连对</th><th>错</th><th>最近</th><th>来源（via / 原文片段）</th><th>操作</th>
</tr></thead><tbody id="rows"><tr><td colspan="11" class="meta">加载中…</td></tr></tbody></table>
<div class="note" id="note">
  <b>怎么用这个库</b>：① 电脑上复制英文（课本/试卷/网页）→ 鼠标处弹窗点选归到哪个用户；② 拍作业照片 → 我扫描出被荧光笔或红笔标记的<b>印刷体</b>词并入库；③ 点上面的<b>出记忆卡 / 出试卷 / 开始答题</b>，直接按当前筛选（分组 / 搜索结果）生成。<br>
  <b>四个分组</b>：<b>已记住</b>=连续答对 3 次（也可以手动标）；<b>没记住</b>=还没打上已记住；<b>高频易错</b>=被标记次数 ≥ ${highFreqMin} 次且尚未记住（这些最该优先考）；<b>标记次数</b>=被录入/被标记过几次，次数越高说明反复遇到。<br>
  <b>来源列</b>：最近一次录入的渠道与原文片段。若看到 <span class="tag">entities / monorepo / --flag</span> 这类片段，说明当时复制的不是课本内容 —— 勾选后点「删除选中」清掉（会弹窗列出影响范围）。<br>
  <b>安全</b>：删除会同时清掉该词的录入记录、记忆卡与考试记录，<b>不可撤销</b>，所以一定会先弹窗确认。
</div>
</div>
<script>
const API = ${JSON.stringify(WEB_PATH)} + '/api/library';
const BASE = ${JSON.stringify(WEB_PATH)};
const SORTS = ${JSON.stringify(SORTS)};
const GROUPS = ${JSON.stringify(GROUP_LABELS)};
const state = { group: 'all', q: '', sort: 'count', selected: new Set() };

function esc(v) { return String(v == null ? '' : v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

async function post(path, body) {
  const res = await fetch(BASE + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({ ok: false, error: 'HTTP ' + res.status }));
  if (!res.ok || data.ok === false) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}

function showResult(html, cls) {
  const el = document.getElementById('result');
  el.className = 'result' + (cls ? ' ' + cls : '');
  el.innerHTML = html;
}

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
  if (!p.rows.length) { tb.innerHTML = '<tr><td colspan="11" class="meta">没有匹配的词。</td></tr>'; return; }
  tb.innerHTML = p.rows.map((r) => {
    const pills =
      (r.highFreq ? '<span class="pill hot">标记 ' + r.seenCount + ' 次</span>' : '') +
      (r.status === 'mastered' ? '<span class="pill ok">已记住</span>' : '<span class="pill no">没记住</span>');
    const checked = state.selected.has(r.word) ? ' checked' : '';
    return '<tr>' +
      '<td><input type="checkbox" class="row" data-w="' + esc(r.word) + '"' + checked + '></td>' +
      '<td><span class="w">' + esc(r.word) + '</span>' + pills + '</td>' +
      '<td class="meta">' + esc(r.phonetic) + '</td>' +
      '<td class="editable" data-w="' + esc(r.word) + '" data-pos="' + esc(r.pos) + '" data-ph="' + esc(r.phonetic) + '" data-m="' + esc(r.meaning) + '" title="点一下改释义">' +
        (r.pos ? '<span class="meta">' + esc(r.pos) + '</span> ' : '') + esc(r.meaning || '（无释义，点击补）') + '</td>' +
      '<td>' + r.seenCount + '</td>' +
      '<td>' + esc(r.statusLabel) + '</td>' +
      '<td>' + r.streak + '/3</td>' +
      '<td>' + r.wrongCount + '</td>' +
      '<td class="meta">' + esc(String(r.lastSeenAt || '').slice(5, 16)) + '</td>' +
      '<td class="src" title="' + esc(r.via + ' · ' + r.context) + '">' + esc(r.via) + (r.context ? ' · ' + esc(r.context) : '') + '</td>' +
      '<td><button class="mini" data-mk="' + (r.status === 'mastered' ? '0' : '1') + '" data-w="' + esc(r.word) + '">' +
        (r.status === 'mastered' ? '标回没记住' : '标已记住') + '</button></td>' +
      '</tr>';
  }).join('');

  tb.querySelectorAll('input.row').forEach((cb) => cb.addEventListener('change', () => {
    if (cb.checked) state.selected.add(cb.dataset.w); else state.selected.delete(cb.dataset.w);
    updateSel();
  }));
  tb.querySelectorAll('button.mini').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      await post('/api/word/mastery', { word: b.dataset.w, mastered: b.dataset.mk === '1' });
      showResult('已把 <b>' + esc(b.dataset.w) + '</b> 标为「' + (b.dataset.mk === '1' ? '已记住' : '没记住') + '」。', 'ok');
      load();
    } catch (e) { showResult('标记失败：' + esc(e.message), 'err'); b.disabled = false; }
  }));
  tb.querySelectorAll('td.editable').forEach((td) => td.addEventListener('click', () => startEdit(td)));
  updateSel();
}

function updateSel() {
  const n = state.selected.size;
  document.getElementById('selinfo').textContent = n ? ('已选 ' + n + ' 个') : '未选中';
}

function startEdit(td) {
  if (td.querySelector('input')) return;
  const w = td.dataset.w;
  const old = td.innerHTML;
  td.innerHTML =
    '<input class="edit" data-f="meaning" value="' + esc(td.dataset.m) + '" placeholder="中文释义">' +
    '<input class="edit small" data-f="pos" value="' + esc(td.dataset.pos) + '" placeholder="词性">' +
    '<input class="edit small" data-f="phonetic" value="' + esc(td.dataset.ph) + '" placeholder="音标">' +
    '<button class="mini" data-save="1">保存</button><button class="mini" data-cancel="1">取消</button>';
  const inputs = td.querySelectorAll('input.edit');
  inputs[0].focus();
  td.querySelector('[data-cancel]').addEventListener('click', (e) => { e.stopPropagation(); td.innerHTML = old; });
  td.querySelector('[data-save]').addEventListener('click', async (e) => {
    e.stopPropagation();
    const val = (f) => (td.querySelector('input[data-f="' + f + '"]') || {}).value;
    try {
      await post('/api/word/update', { word: w, meaning: val('meaning'), pos: val('pos'), phonetic: val('phonetic') });
      showResult('已更新 <b>' + esc(w) + '</b> 的释义。', 'ok');
      load();
    } catch (err) { showResult('保存失败：' + esc(err.message), 'err'); }
  });
}

async function doDelete() {
  const words = [...state.selected];
  if (!words.length) { showResult('先勾选要删的词。', 'err'); return; }
  let impact;
  try {
    impact = (await post('/api/words/delete-preview', { words })).impact;
  } catch (e) { showResult('无法预览影响：' + esc(e.message), 'err'); return; }
  const found = impact.filter((x) => x.found);
  if (!found.length) { showResult('这些词库里已经没有了。', 'err'); return; }
  const lines = found.map((x) =>
    '· ' + x.term + '（标记 ' + x.seenCount + ' 次）→ 录入记录 ' + x.events + ' 条、记忆卡 ' + x.cards + ' 张、考试题 ' + x.examQuestions + ' 题、作答 ' + x.examAnswers + ' 条');
  const missed = impact.filter((x) => !x.found).map((x) => x.lemma);
  // 注意:本文件里页面 JS 是写在 Node 模板字符串中的,所以这里的换行必须写成 \\n,
  // 否则会被模板字符串先解释成真换行,把生成的 JS 字符串截断(实测踩过)。
  const ok = window.confirm('确认删除下面 ' + found.length + ' 个词？\\n\\n' + lines.join('\\n') +
    (missed.length ? '\\n\\n（以下词库里没有，会跳过：' + missed.join('、') + '）' : '') +
    '\\n\\n删除会一并清掉上述录入记录、记忆卡与考试记录，且不可撤销。');
  if (!ok) { showResult('已取消删除。'); return; }
  try {
    const r = await post('/api/words/delete', { words: found.map((x) => x.lemma) });
    showResult('已删除 <b>' + r.deleted.length + '</b> 个词：' + esc(r.deleted.map((d) => d.term).join('、')) +
      '<br><span class="meta">连带清理：录入记录 ' + r.removed.events + ' 条、记忆卡 ' + r.removed.cards + ' 张、考试题 ' + r.removed.examQuestions + ' 题、作答 ' + r.removed.examAnswers + ' 条</span>', 'ok');
    state.selected.clear();
    load();
  } catch (e) { showResult('删除失败：' + esc(e.message), 'err'); }
}

async function doAction(kind) {
  const btn = document.getElementById(kind === 'cards' ? 'actCards' : kind === 'paper' ? 'actPaper' : 'actAnswer');
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = '正在生成…';
  showResult('正在按当前筛选生成（要调模型，可能需要十几秒）…');
  try {
    if (kind === 'answer') {
      // 在线答题:只给一个可点入口,不产文件
      const r = await post('/api/actions/exam', { group: state.group, q: state.q, count: 10, mode: 'answer' });
      showResult(
        '<b>试卷已生成（' + r.questions + ' 题）</b><br>' +
        '<a class="bigbtn" href="' + esc(r.url) + '" target="_blank" rel="noopener">👉 打开答题页，开始做题</a><br>' +
        '<span class="meta">' + esc(r.message || '') + '</span>',
        'ok',
      );
      return;
    }
    if (kind === 'paper') {
      // 打印试卷:只给 PDF 入口(可在页面直接打开/下载)
      const r = await post('/api/actions/exam', { group: state.group, q: state.q, count: 10, mode: 'paper' });
      const fileLink = (p, label) => (p ? '<a class="bigbtn" href="' + BASE + '/file?p=' + encodeURIComponent(p) + '" target="_blank" rel="noopener">' + label + '</a>' : '');
      showResult(
        '<b>打印试卷已生成（' + r.questions + ' 题）</b><br>' +
        fileLink(r.files.paperPdf, '🖨 打开试卷 PDF') +
        fileLink(r.files.keyPdf, '📄 打开参考答案 PDF') +
        '<br><span class="meta">' + esc(r.message || '') + '</span>' +
        dirButton(r.primary),
        'ok',
      );
      return;
    }
    // 出记忆卡:主入口给 PDF 预览,其余文件收进"更多"
    const r = await post('/api/actions/cards', { group: state.group, q: state.q, sort: state.sort, limit: 8 });
    const f = r.files || {};
    showResult(
      '<b>记忆卡已生成（' + r.cards + ' 张' + (r.generatedNow ? '，新生成 ' + r.generatedNow + ' 张' : '') + '）</b><br>' +
      (f.pdf ? '<a class="bigbtn" href="' + BASE + '/file?p=' + encodeURIComponent(f.pdf) + '" target="_blank" rel="noopener">🖨 打开记忆卡 PDF</a>' : '') +
      (f.preview ? '<a class="bigbtn" href="' + BASE + '/file?p=' + encodeURIComponent(f.preview) + '" target="_blank" rel="noopener">🔍 看首页预览图</a>' : '') +
      '<details><summary class="meta">其它格式（HTML / Word）</summary>' +
      (f.word ? '<div><a href="' + BASE + '/file?p=' + encodeURIComponent(f.word) + '">Word .docx</a></div>' : '') +
      (f.html ? '<div><a href="' + BASE + '/file?p=' + encodeURIComponent(f.html) + '">HTML</a></div>' : '') +
      '</details>' +
      dirButton(f.pdf || f.html),
      'ok',
    );
  } catch (e) {
    showResult('生成失败：' + esc(e.message), 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

/** 把文件所在目录用系统窗口打开(省得用户去翻路径) */
function dirButton(filePath) {
  if (!filePath) return '';
  const dir = String(filePath).replace(/[\\/][^\\/]*$/, '');
  return '<br><button class="mini" data-open="' + esc(dir) + '">📁 在系统里打开输出目录</button>';
}

async function openPath(p) {
  try {
    await post('/api/open', { path: p });
    showResult('已用系统默认程序打开：<code>' + esc(p) + '</code>', 'ok');
  } catch (e) {
    showResult('打开失败：' + esc(e.message), 'err');
  }
}

document.getElementById('all').addEventListener('change', (e) => {
  document.querySelectorAll('input.row').forEach((cb) => {
    cb.checked = e.target.checked;
    if (cb.checked) state.selected.add(cb.dataset.w); else state.selected.delete(cb.dataset.w);
  });
  updateSel();
});
document.getElementById('del').addEventListener('click', doDelete);
document.getElementById('markOn').addEventListener('click', () => markSelected(true));
document.getElementById('markOff').addEventListener('click', () => markSelected(false));
document.getElementById('actCards').addEventListener('click', () => doAction('cards'));
document.getElementById('actPaper').addEventListener('click', () => doAction('paper'));
document.getElementById('actAnswer').addEventListener('click', () => doAction('answer'));
// 结果区里的"在系统里打开目录"按钮是动态生成的 -> 事件委托
document.getElementById('result').addEventListener('click', (e) => {
  const t = e.target.closest('button[data-open]');
  if (t) openPath(t.dataset.open);
});

async function markSelected(mastered) {
  const words = [...state.selected];
  if (!words.length) { showResult('先勾选要标记的词。', 'err'); return; }
  let done = 0, failed = 0;
  for (const w of words) {
    try { await post('/api/word/mastery', { word: w, mastered }); done += 1; } catch { failed += 1; }
  }
  showResult('已把 <b>' + done + '</b> 个词标为「' + (mastered ? '已记住' : '没记住') + '」' + (failed ? '，失败 ' + failed + ' 个' : '') + '。', 'ok');
  load();
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
 * 把页面的分组/搜索选择翻译成查询范围(纯函数,便于单测)。
 * 页面上的「高频易错」= 标记次数 ≥ 阈值 且 未学会 —— 用户 2026-09-16 定的口径。
 */
export function resolveScope({ group = "all", q = "", highFreqMin = 2, sort = "count", limit = 8 } = {}) {
  const scope = { orderBy: sort === "alpha" ? "alpha" : sort === "recent" ? "recent" : "count" };
  if (group === "mastered") scope.status = "mastered";
  else if (group === "learning") scope.status = "learning";
  else if (group === "hot") {
    scope.status = "learning";
    scope.minCount = highFreqMin;
  }
  const words = String(q || "").trim();
  return { ...scope, words: words || undefined, limit: Math.max(1, Math.min(200, Number(limit) || 8)) };
}

/**
 * 挂载宿主路由(progressive injection:没有 webServer 服务时静默跳过,headless profile 不受影响)。
 * @param {any} ctx 插件 ctx
 * @param {{db:any, queryWords:Function, stats:Function, cardStats:Function, liveConfig:any, logger:any,
 *          actions?:{cards?:Function, exam?:Function}}} deps
 * @returns {boolean} 是否已注册(服务可用)
 */
export function registerWebUi(ctx, { db, queryWords, stats, cardStats, liveConfig, logger, actions = {}, getSettings, writeSettings, userOverview }) {
  let registered = false;
  ctx.inject(["webServer"], (webCtx) => {
    const send = (res, code, body, type = "application/json; charset=utf-8") => {
      const payload = typeof body === "string" ? body : JSON.stringify(body);
      res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
      res.end(payload);
    };
    const readJson = (req) =>
      new Promise((done) => {
        let raw = "";
        req.on("data", (c) => {
          raw += c;
          if (raw.length > 1e6) req.destroy();
        });
        req.on("end", () => {
          try {
            done(raw ? JSON.parse(raw) : {});
          } catch {
            done(null); // 非法 JSON → 调用方回 400
          }
        });
      });
    const pickUser = (name) => db.prepare("SELECT * FROM users WHERE name = ?").get(String(name || liveConfig.defaultUser));

    const routeHandler = async (req, res) => {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      const sub = url.pathname.slice(WEB_PATH.length) || "/";
      const isWrite = req.method === "POST";
      if (!isWrite && req.method !== "GET" && req.method !== "HEAD") {
        send(res, 405, { ok: false, error: "只支持 GET/HEAD 与 POST(JSON)" });
        return;
      }
      // 写操作只收 JSON:挡掉简单表单式跨站提交
      if (isWrite && !String(req.headers["content-type"] || "").includes("application/json")) {
        send(res, 415, { ok: false, error: "写操作需要 Content-Type: application/json" });
        return;
      }
      const body = isWrite ? await readJson(req) : {};
      if (isWrite && body === null) {
        send(res, 400, { ok: false, error: "请求体不是合法 JSON" });
        return;
      }

      // ---------------- 读 ----------------
      if (!isWrite && (sub === "/" || sub === "")) {
        send(res, 200, buildLibraryPageHtml({ userName: liveConfig.defaultUser, highFreqMin: liveConfig.highFreqMin }), "text/html; charset=utf-8");
        return;
      }
      if (!isWrite && sub === "/help") {
        send(res, 200, buildHelpPageHtml({ highFreqMin: liveConfig.highFreqMin }), "text/html; charset=utf-8");
        return;
      }
      if (!isWrite && sub === "/settings") {
        send(res, 200, buildSettingsPageHtml(), "text/html; charset=utf-8");
        return;
      }
      if (!isWrite && sub === "/api/settings") {
        send(res, 200, {
          ok: true,
          spec: SETTINGS_SPEC,
          values: typeof getSettings === "function" ? getSettings() : {},
          users: typeof userOverview === "function" ? userOverview() : [],
        });
        return;
      }
      // 把生成的文件直接从页面打开(否则用户得自己去路径里翻) —— 限定在允许的目录内
      if (!isWrite && sub === "/file") {
        const abs = resolve(String(url.searchParams.get("p") || ""));
        const roots = [liveConfig.outputDir, liveConfig.photo && liveConfig.photo.outDir, liveConfig.photoOutDir]
          .filter(Boolean)
          .map((r) => resolve(String(r)));
        const lower = abs.toLowerCase();
        const inside = roots.some((r) => {
          const rl = r.toLowerCase();
          return lower === rl || lower.startsWith(rl.endsWith(sep) ? rl : rl + sep);
        });
        if (!inside) {
          send(res, 403, { ok: false, error: "只允许访问输出目录内的文件" });
          return;
        }
        if (!existsSync(abs) || !statSync(abs).isFile()) {
          send(res, 404, { ok: false, error: "文件不存在" });
          return;
        }
        const type =
          {
            ".pdf": "application/pdf",
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".html": "text/html; charset=utf-8",
            ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            ".csv": "text/csv; charset=utf-8",
          }[extname(abs).toLowerCase()] || "application/octet-stream";
        const buf = readFileSync(abs);
        res.writeHead(200, { "Content-Type": type, "Content-Length": buf.length, "Cache-Control": "no-store" });
        res.end(buf);
        return;
      }
      if (!isWrite && sub === "/api/library") {
        const user = pickUser(url.searchParams.get("user"));
        if (!user) {
          send(res, 404, { ok: false, error: "没有这个用户" });
          return;
        }
        send(
          res,
          200,
          buildLibraryPayload({
            db, queryWords, stats, cardStats,
            userId: user.id,
            userName: user.name,
            highFreqMin: liveConfig.highFreqMin,
            group: url.searchParams.get("group") || "all",
            q: url.searchParams.get("q") || "",
            sort: url.searchParams.get("sort") || "count",
            limit: Number(url.searchParams.get("limit")) || 500,
          }),
        );
        return;
      }

      // ---------------- 写 ----------------
      // 改名是全局操作(不针对"当前用户"),必须放在通用用户解析之前:
      // 否则把默认库改掉名字后,下一次请求会因为 defaultUser 不存在而 404。
      if (sub === "/api/users/rename") {
        if (typeof actions.renameUser !== "function") {
          send(res, 501, { ok: false, error: "当前环境不支持改用户库名" });
          return;
        }
        const r = await actions.renameUser({ from: body.from, to: body.to });
        send(res, r && r.ok ? 200 : 400, r || { ok: false, error: "改名失败" });
        return;
      }
      const user = pickUser(body.user);
      if (!user) {
        send(res, 404, { ok: false, error: `没有这个用户:${body.user || liveConfig.defaultUser}` });
        return;
      }
      if (sub === "/api/word/update") {
        const lemma = String(body.word || "").trim().toLowerCase();
        if (!lemma) {
          send(res, 400, { ok: false, error: "缺少 word" });
          return;
        }
        if (!db.prepare("SELECT id FROM words WHERE user_id = ? AND lemma = ?").get(user.id, lemma)) {
          send(res, 404, { ok: false, error: `库里没有这个词:${body.word}` });
          return;
        }
        const r = updateDictMeaning(db, { term: lemma, meaning: body.meaning, pos: body.pos, phonetic: body.phonetic });
        if (logger) logger.info(`dsh-word-vault: 页面改释义 ${lemma}`);
        send(res, 200, { ok: true, ...r });
        return;
      }
      if (sub === "/api/word/mastery") {
        const lemma = String(body.word || "").trim().toLowerCase();
        if (!lemma) {
          send(res, 400, { ok: false, error: "缺少 word" });
          return;
        }
        const r = setStatus(db, user.id, lemma, body.mastered ? "mastered" : "learning");
        if (!r.ok) {
          send(res, 404, { ok: false, error: r.error });
          return;
        }
        if (logger) logger.info(`dsh-word-vault: 页面手动标记 ${lemma} -> ${r.status}`);
        send(res, 200, { ok: true, word: r.term, status: r.status });
        return;
      }
      if (sub === "/api/settings") {
        if (typeof writeSettings !== "function") {
          send(res, 501, { ok: false, error: "当前环境不支持写设置（设置服务不可用），请到 DSH 原生设置页修改" });
          return;
        }
        const patch = body && typeof body.patch === "object" && body.patch ? body.patch : {};
        const keys = Object.keys(patch);
        if (!keys.length) {
          send(res, 400, { ok: false, error: "patch 为空" });
          return;
        }
        const allowed = new Set(SETTINGS_SPEC.map((s) => s.key));
        const bad = keys.filter((k) => !allowed.has(k));
        if (bad.length) {
          send(res, 400, { ok: false, error: `不认识的设置项:${bad.join(", ")}` });
          return;
        }
        try {
          await writeSettings(patch);
          if (logger) logger.info(`dsh-word-vault: 页面改设置 ${keys.join(", ")}`);
          send(res, 200, {
            ok: true,
            values: typeof getSettings === "function" ? getSettings() : {},
            note: "已生效；涉及常驻助手的项会自动重启助手（改完若弹窗行为异常，稍等 1~2 秒）。",
          });
        } catch (err) {
          send(res, 400, { ok: false, error: `设置未通过校验或被拒绝:${err && err.message ? err.message : err}` });
        }
        return;
      }
      if (sub === "/api/words/delete-preview") {
        send(res, 200, { ok: true, impact: wordDeleteImpact(db, user.id, body.words) });
        return;
      }
      // 用系统默认程序打开文件/目录(仍然限定在允许目录内),省得用户自己去翻路径
      if (sub === "/api/open") {
        const abs = resolve(String(body.path || ""));
        const roots = [liveConfig.outputDir, liveConfig.photo && liveConfig.photo.outDir]
          .filter(Boolean)
          .map((r) => resolve(String(r)));
        const lower = abs.toLowerCase();
        const inside = roots.some((r) => {
          const rl = r.toLowerCase();
          return lower === rl || lower.startsWith(rl.endsWith(sep) ? rl : rl + sep);
        });
        if (!inside || !existsSync(abs)) {
          send(res, 403, { ok: false, error: "只能打开输出目录内已存在的文件" });
          return;
        }
        try {
          spawn("cmd", ["/c", "start", "", abs], { detached: true, stdio: "ignore", windowsHide: true }).unref();
          if (logger) logger.info(`dsh-word-vault: 页面请求用系统程序打开 ${abs}`);
          send(res, 200, { ok: true, opened: abs });
        } catch (err) {
          send(res, 500, { ok: false, error: `打开失败:${err.message}` });
        }
        return;
      }
      if (sub === "/api/words/delete") {
        const impact = wordDeleteImpact(db, user.id, body.words);
        const found = impact.filter((x) => x.found);
        if (!found.length) {
          send(res, 404, { ok: false, error: "没有匹配的词" });
          return;
        }
        const r = deleteWords(db, { userId: user.id, terms: found.map((x) => x.lemma) });
        if (logger) {
          logger.info(
            `dsh-word-vault: 页面删除 ${r.deleted.length} 个词(事件 ${r.removed.events} / 卡片 ${r.removed.cards} / 题目 ${r.removed.examQuestions} / 答题 ${r.removed.examAnswers})`,
          );
        }
        send(res, 200, { ok: true, ...r, impact: found });
        return;
      }
      if (sub === "/api/actions/cards") {
        if (typeof actions.cards !== "function") {
          send(res, 501, { ok: false, error: "当前环境不支持出卡(缺少动作实现)" });
          return;
        }
        const scope = resolveScope({ group: body.group, q: body.q, sort: body.sort, limit: body.limit, highFreqMin: liveConfig.highFreqMin });
        const r = await actions.cards({ user, ...scope });
        send(res, r && r.ok ? 200 : 400, r || { ok: false, error: "出卡失败" });
        return;
      }
      if (sub === "/api/actions/exam") {
        if (typeof actions.exam !== "function") {
          send(res, 501, { ok: false, error: "当前环境不支持出卷(缺少动作实现)" });
          return;
        }
        const scope = resolveScope({
          group: body.group, q: body.q, sort: "count",
          limit: body.count || liveConfig.exam.count, highFreqMin: liveConfig.highFreqMin,
        });
        const r = await actions.exam({ user, ...scope, mode: body.mode === "answer" ? "answer" : "paper" });
        send(res, r && r.ok ? 200 : 400, r || { ok: false, error: "出卷失败" });
        return;
      }
      send(res, 404, { ok: false, error: "未知路径" });
    };

    const disposer = webCtx.webServer.register({
      kind: "prefix",
      path: WEB_PATH,
      handler: (req, res) => {
        Promise.resolve()
          .then(() => routeHandler(req, res))
          .catch((err) => {
            if (logger) logger.warn(`dsh-word-vault: 词库界面出错 - ${err && err.message ? err.message : err}`);
            try {
              send(res, 500, { ok: false, error: String(err && err.message ? err.message : err) });
            } catch {
              /* 响应已发出 */
            }
          });
      },
    });
    registered = true;
    if (logger) logger.info(`dsh-word-vault: 词库界面已挂载 -> ${WEB_PATH}`);
    // 注册即 effect:插件卸载时自动摘掉路由
    ctx.effect(() => disposer);
    return webCtx;
  });
  return registered;
}

// ============================ P5.3 使用说明页 + 设置表单 ============================

/** 三个页面的导航条(词库 / 使用说明 / 设置) */
function nav(active) {
  const items = [
    ["/", "词库"],
    ["/help", "使用说明"],
    ["/settings", "设置"],
  ];
  return (
    '<div class="nav">' +
    items
      .map(([href, label]) => `<a class="navlink${active === href ? " on" : ""}" href="${WEB_PATH}${href === "/" ? "" : href}">${label}</a>`)
      .join("") +
    "</div>"
  );
}

const NAV_CSS = `
.nav { display:flex; gap:6px; align-items:center; margin:2px 0 10px; }
a.navlink { font-size:13px; text-decoration:none; color:#41556b; background:#fff; border:1px solid var(--line); border-radius:999px; padding:5px 14px; }
a.navlink:hover { border-color:var(--blue); color:var(--blue); }
a.navlink.on { background:var(--blue); border-color:var(--blue); color:#fff; font-weight:700; }
`;

/**
 * 设置项清单:页面上展示的字段(标签/分组/说明/范围)。
 * 只列用户真正会改的项;值从插件当前配置读(扁平结构),写回同一份 settings schema。
 */
export const SETTINGS_SPEC = [
  { key: "enabled", group: "通用", label: "启用插件", type: "bool", help: "关掉后不落库、不起助手进程，工具会返回停用说明。" },
  { key: "dbPath", group: "通用", label: "词库数据库文件", type: "text", help: "SQLite 单文件；不在插件仓库里，回滚代码不会动你的词。" },
  { key: "outputDir", group: "通用", label: "产物输出目录", type: "text", help: "记忆卡 / 试卷 / 预览图都落在这里。" },
  { key: "highFreqMin", group: "复习口径", label: "高频词门槛（被标记几次算高频）", type: "int", min: 1, max: 20, help: "累计被录入/被标记达到这个次数就算高频；「高频易错」= 高频且尚未记住。" },
  { key: "maxWordsPerCapture", group: "录入", label: "单次录入最多收多少词", type: "int", min: 1, max: 500, help: "防止一次复制长文把词库灌满。" },
  { key: "keepPhrases", group: "录入", label: "2~5 词短句另存为「词组」", type: "bool", help: "关掉则只收单词，不收词组条目。" },
  { key: "autoCommit", group: "录入", label: "复制后直接入库（不弹窗点选）", type: "bool", help: "默认关：必须点选归属用户才入库。开了会把普通复制也录进来。" },
  { key: "autoTranslate", group: "录入", label: "录入时自动翻译", type: "bool", help: "关掉则只记词形，稍后再补翻译（出卡/出卷会自动补）。" },
  { key: "promptTimeoutMs", group: "录入", label: "弹窗等待上限（毫秒）", type: "int", min: 0, max: 300000, help: "超时自动消失且不入库；0 = 一直等。" },
  { key: "showFloatWindow", group: "录入", label: "显示常驻监听小条", type: "bool", help: "小条可拖动并记忆位置。" },
  { key: "cardsTitle", group: "记忆卡", label: "卡片页眉主标题", type: "text" },
  { key: "cardsSubtitle", group: "记忆卡", label: "页眉副标题（留空自动生成）", type: "text" },
  { key: "cardsBatchSize", group: "记忆卡", label: "每次交给模型几个词做拆词", type: "int", min: 1, max: 20 },
  { key: "examCount", group: "考试", label: "默认出多少题", type: "int", min: 1, max: 100 },
  { key: "examRecheckRatio", group: "考试", label: "已学会词抽查比例", type: "number", min: 0, max: 1, help: "抽查答错会自动摘牌。" },
  { key: "examMinutes", group: "考试", label: "答题页空闲多久自动关闭（分钟）", type: "int", min: 1, max: 600 },
  { key: "photoDir", group: "照片", label: "照片目录（往里丢照片就能扫）", type: "text", help: "也可以在对话里直接发照片。" },
  { key: "photoOutDir", group: "照片", label: "裁剪与联络图输出目录", type: "text" },
  { key: "photoKeepCrops", group: "照片", label: "保留逐块裁剪 PNG", type: "bool", help: "关掉只留联络图，省磁盘。" },
  { key: "photoSatMin", group: "照片", label: "标记墨迹最低饱和度", type: "int", min: 5, max: 200, help: "调低=更敏感（可能把浅色印刷也当标记），调高=更严格。" },
  { key: "photoPadUp", group: "照片", label: "裁剪上方多留像素", type: "int", min: 0, max: 200, help: "红线在词下方，必须上扩才能把被标记的词带进来。" },
  { key: "photoMaxPerRun", group: "照片", label: "每次最多处理几张新照片", type: "int", min: 1, max: 50 },
];

const SETTINGS_CSS = `
.form fieldset { background:#fff; border:1px solid var(--line); border-radius:10px; padding:12px 16px 14px; margin:0 0 12px; }
.form legend { font-size:13px; font-weight:700; color:var(--blue); padding:0 6px; }
.frow { display:grid; grid-template-columns: 330px 240px 1fr; gap:4px 12px; align-items:center; padding:7px 0; border-bottom:1px solid #f2f7fb; }
.frow label { font-size:13px; }
.frow input[type=text], .frow input[type=number] { font-size:13px; padding:6px 9px; border:1px solid var(--line); border-radius:7px; width:100%; }
.frow .fh { grid-column: 3; font-size:11px; color:var(--gray); }
.fk { grid-column: 3; font-size:11px; color:#9fb0c0; }
`;

/** 设置页:读当前值 + 写回同一份 settings schema(写入由宿主提供的 writeSettings 完成) */
export function buildSettingsPageHtml() {
  const body = `
<h1>设置<small>改完即时生效（录入相关项会自动重启常驻助手）</small></h1>
${nav("/settings")}
<div class="result hide" id="result"></div>
<fieldset class="form" id="users"><legend>用户库改名</legend><div class="meta" id="usersBody">加载中…</div></fieldset>
<div id="form" class="form"><div class="meta">加载中…</div></div>
<div class="note">
  <b>说明</b>：这些项与 DSH 原生设置页（插件配置 · dsh-word-vault）读写的是<b>同一份</b>配置，改哪边都一样。
  路径类字段请写绝对路径。点「保存本组」只提交你改过的字段，不会覆盖别处。
</div>
<div class="note">
  <b>路径快捷入口</b>：
  <button class="mini" data-open-placeholder="1" id="openOut">📁 打开输出目录</button>
  <button class="mini" data-open-placeholder="1" id="openPhoto">📁 打开照片目录</button>
</div>`;
  const script = `
const BASE = ${JSON.stringify(WEB_PATH)};
const SPEC = ${JSON.stringify(SETTINGS_SPEC)};
const GROUPS = [...new Set(SPEC.map((s) => s.group))];
let current = {};
let dirty = {};

function esc(v) { return String(v == null ? '' : v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

async function post(path, body) {
  const res = await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const data = await res.json().catch(() => ({ ok: false, error: 'HTTP ' + res.status }));
  if (!res.ok || data.ok === false) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}
function showResult(html, cls) {
  const el = document.getElementById('result');
  el.className = 'result' + (cls ? ' ' + cls : '');
  el.innerHTML = html;
}

function fieldHtml(s) {
  const v = current[s.key];
  const input = s.type === 'bool'
    ? '<input type="checkbox" data-k="' + s.key + '"' + (v ? ' checked' : '') + '>'
    : '<input type="' + (s.type === 'text' ? 'text' : 'number') + '" data-k="' + s.key + '" value="' + esc(v) + '"' +
      (s.min !== undefined ? ' min="' + s.min + '"' : '') + (s.max !== undefined ? ' max="' + s.max + '"' : '') +
      (s.type === 'number' ? ' step="0.05"' : '') + '>';
  return '<div class="frow"><label>' + esc(s.label) + '</label>' + input +
    (s.help ? '<div class="fh">' + esc(s.help) + '</div>' : '') +
    '<div class="fk meta">' + esc(s.key) + '</div></div>';
}

function render() {
  document.getElementById('form').innerHTML = GROUPS.map((g) => {
    const rows = SPEC.filter((s) => s.group === g).map(fieldHtml).join('');
    return '<fieldset><legend>' + esc(g) + '</legend>' + rows +
      '<button class="btn primary" data-save="' + esc(g) + '">保存本组</button></fieldset>';
  }).join('');
  document.querySelectorAll('#form input[data-k]').forEach((el) => el.addEventListener('change', () => {
    const k = el.dataset.k;
    const spec = SPEC.find((s) => s.key === k);
    dirty[k] = spec && spec.type === 'bool' ? el.checked
      : (spec && (spec.type === 'int' || spec.type === 'number') ? Number(el.value) : el.value);
  }));
  document.querySelectorAll('button[data-save]').forEach((b) => b.addEventListener('click', () => saveGroup(b.dataset.save)));
}

async function saveGroup(group) {
  const keys = SPEC.filter((s) => s.group === group).map((s) => s.key);
  const patch = {};
  for (const k of keys) if (k in dirty) patch[k] = dirty[k];
  if (!Object.keys(patch).length) { showResult('这一组没有改动。'); return; }
  try {
    const r = await post('/api/settings', { patch });
    current = r.values || current;
    dirty = {};
    showResult('已保存：<code>' + esc(Object.keys(patch).join(', ')) + '</code>' + (r.note ? '<br><span class="meta">' + esc(r.note) + '</span>' : ''), 'ok');
    render();
  } catch (e) { showResult('保存失败：' + esc(e.message), 'err'); }
}

async function openPath(p, label) {
  if (!p) { showResult('这个路径是空的，先在下面填好并保存。', 'err'); return; }
  try { await post('/api/open', { path: p }); showResult('已打开' + label + '：<code>' + esc(p) + '</code>', 'ok'); }
  catch (e) { showResult('打开失败：' + esc(e.message), 'err'); }
}

/** 用户库改名:写库 + 同步设置里的用户列表(改名后弹窗点选与默认库都会跟着变) */
function renderUsers(list) {
  const box = document.getElementById('usersBody');
  if (!list || !list.length) { box.innerHTML = '<div class="meta">还没有用户库。</div>'; return; }
  box.innerHTML = list.map((u) =>
    '<div class="frow"><label>' + esc(u.name) + '<span class="meta">（' + u.words + ' 词 / ' + u.events + ' 次录入）</span></label>' +
    '<input type="text" data-rename="' + esc(u.name) + '" value="' + esc(u.name) + '">' +
    '<button class="mini" data-do-rename="' + esc(u.name) + '">改名</button>' +
    '<div class="fh meta">改成好认的名字，比如「哥哥」「妹妹」；改名后词条不会丢。</div></div>').join('');
  box.querySelectorAll('button[data-do-rename]').forEach((b) => b.addEventListener('click', () => {
    const from = b.dataset.doRename;
    const input = box.querySelector('input[data-rename="' + from + '"]');
    doRename(from, input ? input.value : '');
  }));
  box.querySelectorAll('input[data-rename]').forEach((el) => el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doRename(el.dataset.rename, el.value);
  }));
}

async function doRename(from, to) {
  try {
    const r = await post('/api/users/rename', { from, to });
    showResult('已把「' + esc(from) + '」改名为 <b>' + esc(r.to || to) + '</b>' +
      (r.unchanged ? '（名字没变）' : '，词条与录入记录都还在。'), 'ok');
    await loadAll();
  } catch (e) { showResult('改名失败：' + esc(e.message), 'err'); }
}

async function loadAll() {
  const r = await (await fetch(BASE + '/api/settings')).json();
  current = r.values || {};
  renderUsers(r.users || []);
  render();
}

(async () => {
  try {
    await loadAll();
    document.getElementById('openOut').addEventListener('click', () => openPath(current.outputDir, '输出目录'));
    document.getElementById('openPhoto').addEventListener('click', () => openPath(current.photoDir, '照片目录'));
  } catch (e) { showResult('读取设置失败：' + esc(e.message), 'err'); }
})();
`;
  return pageShell({ title: "设置 · 英语生词库", active: "/settings", body, script, extraCss: SETTINGS_CSS });
}

const HELP_CSS = `
h2 { font-size:15px; margin:18px 0 8px; color:var(--blue); }
td, th { white-space:normal; vertical-align:top; }
ul { line-height:1.9; font-size:13px; }
`;

/** 使用说明页(静态文案,内容与实现对齐) */
export function buildHelpPageHtml({ highFreqMin = 2 } = {}) {
  const body = `
<h1>使用说明<small>英语生词库 · 从录入到复习到考试</small></h1>
${nav("/help")}
<div class="note">
  <b>一句话</b>：把课本/试卷上不会的英文<b>标出来</b>（复制或拍照）→ 自动入库并翻译 → 打印趣味记忆卡开始背 → 考试连对 3 次自动标记「已学会」。
</div>

<h2>① 四种录入方式</h2>
<table>
  <tr><th>方式</th><th>怎么做</th><th>你会看到</th></tr>
  <tr><td><b>复制点选</b>（最常用）</td><td>在电脑上选中英文按 Ctrl+C</td><td>鼠标位置弹出小窗 → 点用户 → 显示「已录入成功 · N 词 · 今日累计」</td></tr>
  <tr><td><b>拍照</b></td><td>拍作业/课本丢进照片目录，或直接在对话里发我</td><td>我扫描出被<b>荧光笔或红笔</b>标记的<b>印刷体</b>词 → 读图确认 → 入库（每张照片一条可整张撤销的记录）</td></tr>
  <tr><td><b>对话录入</b></td><td>在 DSH 对话里贴一段英文，说「录进用户1」</td><td>我切词、去功能词、还原词形、翻译后入库</td></tr>
  <tr><td><b>查缺补漏</b></td><td>在本页「全部」视图里搜索确认</td><td>看到哪些词已入库、各自标记了几次</td></tr>
</table>

<h2>② 三个视图怎么读</h2>
<table>
  <tr><th>视图</th><th>口径</th><th>用来干什么</th></tr>
  <tr><td><b>已记住</b></td><td>连续答对 3 次，或你手动标了「已记住」</td><td>确认哪些不用再练</td></tr>
  <tr><td><b>没记住</b></td><td>还没打上「已记住」</td><td>当前待复习池</td></tr>
  <tr><td><b>高频易错</b></td><td>被标记次数 ≥ ${highFreqMin} 次 <b>且</b> 尚未记住</td><td><b>最该优先考的就是这些</b>：反复遇到却还没掌握</td></tr>
</table>
<p class="meta">「标记次数」= 这个词被录入/被标记过几次（同一段文字里重复出现只算一次，换个批次再出现才 +1）。列表里还有「连对」（当前连对 / 3）与「错」（考错次数），代码不替你做加权。</p>

<h2>③ 三个动作按钮</h2>
<table>
  <tr><th>按钮</th><th>作用</th></tr>
  <tr><td><b>出记忆卡</b></td><td>按当前筛选生成 A4 记忆卡：拆解块 + 一句荒诞梗 + 默写区；缺卡片的自动调模型补生成。每页 8 张，可直接打印。</td></tr>
  <tr><td><b>在线答题</b></td><td>按当前筛选出题并给一个链接：点选即判分、显示正确答案与「连续答对 N/3」；连对 3 次当场打「已学会」，答错清零（已学会会被摘牌）。成绩与错题自动归档。</td></tr>
  <tr><td><b>打印试卷 PDF</b></td><td>出打印卷（题目页 + 参考答案页），点开就能看/打印；做完在对话里让我逐题录分即可回写掌握度。</td></tr>
</table>

<h2>④ 掌握度怎么算</h2>
<ul>
  <li>答对：连对 +1；<b>连对 3 次 → 已学会</b>。</li>
  <li>答错：连对清零；如果原本已学会 → <b>摘牌</b>回「没记住」。</li>
  <li>已学会的词会按比例抽查（设置里可调），抽查答错同样摘牌。</li>
  <li>也可以手动标「已记住 / 没记住」——孩子本来就会的词不用非考三次。</li>
</ul>

<h2>⑤ 页面上的写操作与安全</h2>
<ul>
  <li><b>改释义</b>：点表格里的释义单元格就地改（释义 / 词性 / 音标），改的是全局词典缓存。</li>
  <li><b>删除</b>：勾选 → 「删除选中」→ 弹窗列出<b>每个词会连带清掉什么</b>（录入记录 / 记忆卡 / 考试题 / 作答）→ 确认才执行，<b>不可撤销</b>。</li>
  <li><b>来源列</b>：最近一次录入的渠道与原文片段。若看到 <code>entities</code>、<code>monorepo</code>、<code>--flag</code> 这类片段，说明当时复制的不是课本内容（终端输出被当生词录进来了），勾选删掉即可。</li>
</ul>

<h2>⑥ 常见问题</h2>
<ul>
  <li><b>复制了没弹窗？</b>确认常驻助手在跑（设置里看「显示常驻监听小条」）；弹窗 20 秒不点会自动消失且不入库。</li>
  <li><b>照片扫出来一堆手写？</b>我只录<b>印刷体</b>：各色荧光笔与红笔的红线/勾/圈都算标记，但手写内容一律不入库。</li>
  <li><b>答题链接打不开？</b>答题页由 DSH 进程托管，关掉 DSH 链接就失效。</li>
  <li><b>词库数据在哪？</b>SQLite 单文件，不在插件仓库里；回滚代码不会动你的词。</li>
</ul>
`;
  return pageShell({ title: "使用说明 · 英语生词库", active: "/help", body, script: "", extraCss: HELP_CSS });
}

/** 三个页面共用的外壳 */
function pageShell({ title, body, script, extraCss }) {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style>${SHELL_CSS}${NAV_CSS}${extraCss || ""}</style></head><body><div class="wrap">
${body}
</div>${script ? `<script>${script}</script>` : ""}</body></html>`;
}

const SHELL_CSS = `
:root { --blue:#1f5a94; --soft:#eef4fb; --line:#cfdbe6; --hot:#c0392b; --ok:#2f9e63; --ink:#1b2a3a; --gray:#7a8b9c; }
* { box-sizing: border-box; }
body { margin:0; font-family:"Microsoft YaHei","微软雅黑",sans-serif; color:var(--ink); background:#f7fafd; }
.wrap { max-width: 1180px; margin: 0 auto; padding: 20px 18px 60px; }
h1 { font-size: 21px; margin: 4px 0 8px; }
h1 small { font-size: 12px; font-weight: 400; color:var(--gray); margin-left: 10px; }
table { width:100%; border-collapse:collapse; background:#fff; border:1px solid var(--line); border-radius:10px; overflow:hidden; font-size:13px; margin-top:8px; }
th, td { padding:8px 10px; border-bottom:1px solid #eaf1f7; text-align:left; vertical-align:top; white-space:nowrap; }
th { background:var(--soft); font-size:12px; color:#41556b; }
tr:last-child td { border-bottom:none; }
.meta { color:var(--gray); font-size:12px; }
.note { margin-top:14px; background:#fff; border:1px solid var(--line); border-left:3px solid var(--blue); border-radius:8px; padding:12px 14px; font-size:13px; line-height:1.85; }
.note b { color:var(--blue); }
.note code, td code { background:#f2f6fa; padding:1px 5px; border-radius:4px; }
.mini { font-size:11px; padding:3px 8px; border-radius:6px; border:1px solid var(--line); background:#fff; color:#41556b; cursor:pointer; margin-right:4px; }
.mini:hover { border-color:var(--blue); color:var(--blue); }
.btn { font-size:13px; padding:7px 14px; border-radius:8px; border:1px solid var(--line); background:var(--soft); color:var(--ink); cursor:pointer; }
.btn.primary { background:var(--blue); border-color:var(--blue); color:#fff; font-weight:700; }
.result { background:#fff; border:1px solid var(--line); border-left:3px solid var(--blue); border-radius:8px; padding:10px 14px; margin:10px 0; font-size:13px; line-height:1.8; }
.result.ok { border-left-color:var(--ok); }
.result.err { border-left-color:var(--hot); background:#fdeaea; }
.result.hide { display:none; }
.result code { background:#f2f6fa; padding:1px 5px; border-radius:4px; font-size:12px; }
`;

