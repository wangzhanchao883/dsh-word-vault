/**
 * P3 本地答题服务:插件在 127.0.0.1 上起一个临时 HTTP 服务,浏览器打开即可答题。
 *
 * 为什么这么做(2026-09-16 用户选择):DSH 客户端 UI 面板是全新工作量(要配套前端构建调试),
 * 而"浏览器点 A/B/C/D → 立即判分 → 回写库"用本地小服务就能实现,做完即可关闭。
 *
 * 设计要点:
 *   · 只监听 127.0.0.1,URL 里带随机 token,防止同机其它程序乱调
 *   · 逐题作答 + 即时反馈(答对/答错都给正确答案,带 streak 进度)
 *   · 判分只在服务端做(答案在库里),页面拿不到答案,改不了分
 *   · 空闲超时或交卷后自动关闭
 */
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { answerExamQuestion, examSummary, finishExamSession, listExamQuestions, getExamSession } from "./db.mjs";

export const EXAM_LETTERS = ["A", "B", "C", "D"];

/** 解析用户输入的选择:A/B/C/D 或 0..3 */
export function parseChoice(input) {
  if (typeof input === "number" && Number.isInteger(input) && input >= 0 && input <= 3) return input;
  const s = String(input == null ? "" : input).trim().toUpperCase();
  if (["A", "B", "C", "D"].includes(s)) return EXAM_LETTERS.indexOf(s);
  if (/^[0-3]$/.test(s)) return Number(s);
  return -1;
}

function esc(v) {
  return String(v == null ? "" : v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 答题页(题目 + 逐题即时反馈) */
export function buildExamPageHtml({ token, title = "英语单词测验", subtitle = "", questions = [], total = 0 }) {
  const data = JSON.stringify(
    questions.map((q) => ({
      seq: q.seq,
      sentence: q.sentence,
      word: q.word,
      options: q.options,
      isRecheck: q.isRecheck,
    })),
  );
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>
:root { --blue:#1f5a94; --soft:#eef4fb; --line:#cfdbe6; --yellow:#fff3c4; }
* { box-sizing: border-box; }
body { margin:0; font-family:"Microsoft YaHei","微软雅黑",sans-serif; color:#1b2a3a; background:#f7fafd; }
.wrap { max-width: 720px; margin: 0 auto; padding: 18px 16px 40px; }
h1 { font-size: 19px; margin: 8px 0 2px; }
h1 small { font-size: 12px; font-weight: 400; color:#7a8b9c; margin-left: 8px; }
.bar { height: 8px; background:#e3ecf5; border-radius: 4px; overflow:hidden; margin: 12px 0 4px; }
.bar > i { display:block; height:100%; width:0; background: var(--blue); transition: width .25s; }
.meta { font-size: 12px; color:#5c6f82; display:flex; justify-content:space-between; }
.card { background:#fff; border:1px solid var(--line); border-radius: 10px; padding: 18px; margin-top: 14px; }
.stem { font-family:"Segoe UI",Arial,sans-serif; font-size: 20px; line-height:1.5; }
.ask { margin: 10px 0 14px; font-size: 15px; color:#23313f; }
.ask b { color: var(--blue); font-size: 17px; }
.rc { color:#c0392b; font-size:12px; }
.opts { display:grid; gap:10px; }
button.opt { text-align:left; font-size:16px; padding: 12px 14px; border:1px solid var(--line);
  border-radius: 8px; background: var(--soft); color:#1b2a3a; cursor:pointer; }
button.opt:hover:not(:disabled) { border-color: var(--blue); }
button.opt:disabled { cursor: default; opacity: .95; }
button.opt.right { background:#e6f6ec; border-color:#2f9e63; font-weight:700; }
button.opt.wrong { background:#fdeaea; border-color:#c0392b; }
button.opt small { float:right; font-weight:400; color:#5c6f82; }
.fb { margin-top: 14px; font-size: 14px; line-height:1.7; }
.fb .ok { color:#2f9e63; font-weight:700; }
.fb .no { color:#c0392b; font-weight:700; }
.fb .streak { background: var(--yellow); border-radius: 4px; padding: 1px 6px; }
.next { margin-top: 14px; font-size:15px; padding: 10px 22px; border-radius:8px; border:1px solid var(--blue);
  background: var(--blue); color:#fff; cursor:pointer; }
.next:disabled { opacity:.4; cursor:default; }
.hide { display:none; }
.sum { font-size:15px; line-height:1.9; }
.sum b { color: var(--blue); }
.wronglist { font-size:13px; color:#5c6f82; margin-top:8px; }
</style></head><body><div class="wrap">
<h1>${esc(title)}<small>${esc(subtitle)}</small></h1>
<div class="bar"><i id="bar"></i></div>
<div class="meta"><span id="pos">第 1 / ${total} 题</span><span id="score">已答 0 · 对 0</span></div>
<div class="card" id="card"></div>
<div id="summary" class="card hide"></div>
</div>
<script>
const TOKEN = ${JSON.stringify(token)};
const QS = ${data};
const LETTERS = ["A","B","C","D"];
let idx = 0, answered = 0, correct = 0;
const el = (id) => document.getElementById(id);

function render() {
  const q = QS[idx];
  el('pos').textContent = '第 ' + (idx + 1) + ' / ' + QS.length + ' 题';
  el('score').textContent = '已答 ' + answered + ' · 对 ' + correct;
  el('bar').style.width = (answered / QS.length * 100) + '%';
  el('card').innerHTML =
    '<div class="stem">' + escapeHtml(q.sentence) + '</div>' +
    '<div class="ask">句中的 <b>' + escapeHtml(q.word) + '</b> 是什么意思？' + (q.isRecheck ? ' <span class="rc">(复查)</span>' : '') + '</div>' +
    '<div class="opts">' + q.options.map((o, i) =>
      '<button class="opt" data-i="' + i + '"><b>' + LETTERS[i] + '.</b> ' + escapeHtml(o) + '</button>').join('') + '</div>' +
    '<div class="fb hide" id="fb"></div>' +
    '<button class="next hide" id="next">下一题</button>';
  document.querySelectorAll('button.opt').forEach((b) => {
    b.addEventListener('click', () => submit(Number(b.dataset.i)));
  });
  el('next').addEventListener('click', () => { idx += 1; if (idx >= QS.length) showSummary(); else render(); });
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

async function submit(choice) {
  const q = QS[idx];
  const res = await fetch('/api/' + TOKEN + '/answer', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ seq: q.seq, choice })
  }).then((r) => r.json());
  if (!res.ok) { alert(res.error || '提交失败'); return; }
  answered += 1;
  if (res.isCorrect) correct += 1;
  document.querySelectorAll('button.opt').forEach((b) => {
    const i = Number(b.dataset.i);
    b.disabled = true;
    if (i === res.correctIndex) b.classList.add('right');
    else if (i === choice) b.classList.add('wrong');
  });
  const fb = el('fb');
  fb.classList.remove('hide');
  fb.innerHTML = (res.isCorrect ? '<span class="ok">✔ 答对了</span>' : '<span class="no">✘ 答错了</span>')
    + '　正确答案：<b>' + LETTERS[res.correctIndex] + '. ' + escapeHtml(res.correctMeaning) + '</b>'
    + '<br>连续答对 <span class="streak">' + res.streak + ' / 3</span>'
    + (res.mastered ? '　🎉 已学会这个单词！' : '')
    + (res.demoted ? '　（已学会被撤回，需要重新连对 3 次）' : '');
  const next = el('next');
  next.classList.remove('hide');
  next.textContent = (idx + 1 >= QS.length) ? '看结果' : '下一题';
  el('pos').textContent = '第 ' + (idx + 1) + ' / ' + QS.length + ' 题';
  el('score').textContent = '已答 ' + answered + ' · 对 ' + correct;
  el('bar').style.width = (answered / QS.length * 100) + '%';
}

async function showSummary() {
  el('card').classList.add('hide');
  const s = await fetch('/api/' + TOKEN + '/finish', { method: 'POST' }).then((r) => r.json());
  const box = el('summary');
  box.classList.remove('hide');
  const wrong = (s.wrong || []).map((w) => '第 ' + w.seq + ' 题 ' + escapeHtml(w.word) + '：你选了「' + escapeHtml(w.chose) + '」，正确是「' + escapeHtml(w.right) + '」').join('<br>');
  box.innerHTML = '<div class="sum">本场结束：答对 <b>' + s.correct + ' / ' + s.total + '</b>　正确率 <b>' + s.accuracy + '%</b>'
    + (s.recheckCount ? '　（含 ' + s.recheckCount + ' 题复查）' : '')
    + '<div class="wronglist">' + (wrong ? '错题：<br>' + wrong : '全对，太棒了！') + '</div>'
    + '</div>';
  el('bar').style.width = '100%';
}

render();
</script></body></html>`;
}

/**
 * 起一个考试服务。
 * @returns {Promise<{ok:boolean, port?:number, url?:string, token?:string, close?:Function, error?:string}>}
 */
export function startExamServer({ db, sessionId, title, subtitle, logger, idleTimeoutMs = 30 * 60 * 1000 }) {
  return new Promise((resolve) => {
    const session = getExamSession(db, sessionId);
    if (!session) {
      resolve({ ok: false, error: `没有这场考试:${sessionId}` });
      return;
    }
    const token = session.token || randomUUID().replace(/-/g, "").slice(0, 16);
    const questions = listExamQuestions(db, sessionId).map((q) => ({
      seq: q.seq, sentence: q.sentence, word: q.word, options: q.options, isRecheck: q.isRecheck,
    }));

    let lastHit = Date.now();
    const server = createServer((req, res) => {
      lastHit = Date.now();
      const url = new URL(req.url || "/", "http://127.0.0.1");
      const send = (code, body, type = "application/json; charset=utf-8") => {
        res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
        res.end(body);
      };
      const readBody = () =>
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
              done({});
            }
          });
        });

      const m = url.pathname.match(new RegExp(`^/(?:e|api)/([^/]+)`));
      if (!m || m[1] !== token) {
        send(404, JSON.stringify({ ok: false, error: "链接无效或已过期" }));
        return;
      }
      const rest = url.pathname.replace(`/${url.pathname.split("/")[1]}/${token}`, "");

      (async () => {
        if (req.method === "GET" && (url.pathname === `/e/${token}` || url.pathname === `/e/${token}/`)) {
          send(200, buildExamPageHtml({ token, title, subtitle, questions, total: questions.length }), "text/html; charset=utf-8");
          return;
        }
        if (req.method === "POST" && rest === "/answer") {
          const body = await readBody();
          const seq = Number(body.seq);
          const choice = typeof body.choice === "number" ? body.choice : parseChoice(body.choice);
          if (choice < 0) {
            send(400, JSON.stringify({ ok: false, error: "选择无效,应为 A/B/C/D" }));
            return;
          }
          const r = answerExamQuestion(db, { sessionId, seq, chosenIndex: choice });
          if (!r.ok) {
            send(409, JSON.stringify(r));
            return;
          }
          const s = examSummary(db, sessionId);
          send(200, JSON.stringify({ ...r, progress: { answered: s.answered, total: s.total, correct: s.correct } }));
          return;
        }
        if (req.method === "POST" && rest === "/finish") {
          const s = finishExamSession(db, sessionId);
          send(200, JSON.stringify({ ok: true, ...s }));
          return;
        }
        if (req.method === "GET" && rest === "/summary") {
          send(200, JSON.stringify({ ok: true, ...examSummary(db, sessionId) }));
          return;
        }
        send(404, JSON.stringify({ ok: false, error: "未知路径" }));
      })().catch((err) => {
        if (logger) logger.warn(`dsh-word-vault: 答题服务出错 - ${err.message}`);
        send(500, JSON.stringify({ ok: false, error: err.message }));
      });
    });

    const closer = setInterval(() => {
      if (Date.now() - lastHit > idleTimeoutMs) {
        if (logger) logger.info("dsh-word-vault: 答题服务空闲超时,已关闭");
        try {
          server.close();
        } catch {
          /* 已关闭 */
        }
      }
    }, 60000);
    if (closer.unref) closer.unref();

    server.on("error", (err) => {
      clearInterval(closer);
      resolve({ ok: false, error: `答题服务启动失败:${err.message}` });
    });

    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({
        ok: true,
        port,
        token,
        url: `http://127.0.0.1:${port}/e/${token}`,
        close: () => {
          clearInterval(closer);
          try {
            server.close();
          } catch {
            /* 已关闭 */
          }
        },
      });
    });
  });
}
