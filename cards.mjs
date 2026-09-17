/**
 * 记忆卡版式与导出（移植自 workbuddy 专家包 funny-word-cards 的 build_pdf.py）。
 *
 * 规格（照搬，不擅自改）：
 *   · A4 竖版（210×297mm），每页 8 张卡（2 列 × 4 行），单面打印
 *   · 每张卡四层：词头（序号圆标 + 大字单词 + 音标/词性/释义）
 *                拆解块（字母片段 ↔ 中文音，上下对齐）
 *                荒诞句（橙色左边框一句话）
 *                默写区（两条虚线）+ 「已攻下」勾选框
 *   · 不足 8 张时空位印成虚线框「空位 · 错词重写区」，不留白纸
 *   · 单词长度 ≥11 字母时自动缩小字号（.word.long）
 *   · 出片后必须看 `_预览_第1页.png` 自检：第 4 行勾选框不能被切掉
 *
 * 自包含：不依赖 workbuddy 目录；PDF 用本机 Edge/Chrome headless，Word 用 pandoc。
 */
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";

export const PER_PAGE = 8;

const BROWSER_CANDIDATES = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
];

const PANDOC_CANDIDATES = [
  "C:\\Program Files\\Pandoc\\pandoc.exe",
  "pandoc",
];

/** 与专家包逐字对齐的卡片样式 */
export const CARD_CSS = `
@page { size: A4; margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  font-family: "Microsoft YaHei", "微软雅黑", sans-serif;
  color: #1b2a3a;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
.page {
  width: 210mm; height: 297mm;
  padding: 7mm 10mm 6mm 10mm;
  display: flex; flex-direction: column;
  page-break-after: always;
  background: #fff;
}
.page:last-child { page-break-after: auto; }
.ph {
  display: flex; justify-content: space-between; align-items: baseline;
  border-bottom: 1.1pt solid #1b2a3a; padding-bottom: 1.4mm; margin-bottom: 3mm;
  flex: 0 0 auto;
}
.ph .t { font-size: 10pt; font-weight: 700; letter-spacing: 1.1pt; }
.ph .t small { font-weight: 400; font-size: 8pt; color: #7a8b9c; letter-spacing: .4pt; margin-left: 2mm; }
.ph .n { font-size: 8.5pt; color: #7a8b9c; }

.grid {
  flex: 1 1 auto;
  display: grid;
  grid-template-columns: 1fr 1fr;
  grid-template-rows: repeat(4, 1fr);
  gap: 3.4mm;
}
.card {
  border: 1.2pt solid #1b2a3a;
  border-radius: 2.2mm;
  padding: 2.8mm 3.6mm 2.2mm 3.6mm;
  display: flex; flex-direction: column;
  overflow: hidden;
  position: relative;
}
.card::after {
  content: ""; position: absolute; right: -14mm; top: -14mm;
  width: 26mm; height: 26mm; border-radius: 50%;
  background: #f2f6fa;
}
.chead { display: flex; align-items: flex-start; gap: 2.4mm; position: relative; z-index: 1; }
.idx {
  flex: 0 0 auto; width: 6.4mm; height: 6.4mm; border-radius: 50%;
  background: #1b2a3a; color: #fff;
  font-size: 7pt; font-weight: 700;
  display: flex; align-items: center; justify-content: center;
  margin-top: .5mm;
}
.wtxt { flex: 1 1 auto; min-width: 0; }
.word {
  font-family: "Segoe UI", Arial, sans-serif;
  font-size: 17pt; font-weight: 700; line-height: 1.0;
  letter-spacing: .2pt; word-break: break-word;
  color: #1b2a3a;
}
.word.long { font-size: 13.5pt; }
.meta {
  margin-top: .7mm; font-size: 7.2pt; color: #5c6f82;
  font-family: "Segoe UI", Arial, sans-serif;
}
.meta .cn { font-family: "Microsoft YaHei", "微软雅黑", sans-serif; font-size: 8.2pt; color: #1b2a3a; font-weight: 700; }

.split { display: flex; gap: 1.2mm; margin: 2mm 0 1.8mm 0; position: relative; z-index: 1; flex-wrap: wrap; }
.seg {
  flex: 1 1 0; min-width: 10mm;
  border: .9pt solid #b9cbdd; border-radius: 1.3mm;
  background: #eef4fb;
  padding: .9mm .5mm;
  text-align: center;
}
.seg .en {
  display: block;
  font-family: "Segoe UI", Arial, sans-serif;
  font-size: 10.5pt; font-weight: 700; color: #1f5a94; line-height: 1.05;
}
.seg .ipa {
  display: block; margin-bottom: .2mm;
  font-family: "Segoe UI", Arial, sans-serif;
  font-size: 7.6pt; font-weight: 600; color: #5b7a99; line-height: 1.05;
}
.seg .note {
  display: block; margin-top: .3mm;
  font-size: 6.2pt; color: #8798a8; line-height: 1.1;
}
.seg .cn {
  display: block; margin-top: .4mm;
  font-size: 8.5pt; font-weight: 700; color: #c0392b; line-height: 1.05;
  letter-spacing: .6pt;
}

.story {
  flex: 0 0 auto;
  border-left: 1.8pt solid #e0673a;
  background: #fdf6f1;
  padding: 1.2mm 2.2mm;
  font-size: 8pt; line-height: 1.42;
  color: #23313f;
  border-radius: 0 1.3mm 1.3mm 0;
  text-align: justify;
}
.write { flex: 1 1 auto; display: flex; flex-direction: column; margin-top: 1.8mm; min-height: 8mm; }
.write .lab { font-size: 6.4pt; color: #8798a8; letter-spacing: .3pt; flex: 0 0 auto; }
.write .lines { flex: 1 1 auto; display: flex; flex-direction: column; justify-content: space-evenly; padding-top: 1mm; }
.write .lines i { display: block; height: 0; border-bottom: .8pt dashed #c3d0dd; }
.foot {
  margin-top: 1.4mm; padding-top: 1.2mm;
  border-top: .7pt dashed #c3d0dd;
  display: flex; align-items: center; gap: 1.6mm;
  font-size: 7pt; color: #8798a8; letter-spacing: .4pt;
}
/* 高频角标:只在累计被标记次数 >= 门槛时出现(红色,与"荒诞句"同色系,一眼能挑出重点词) */
.freq {
  position: absolute; right: 2.4mm; top: 2mm; z-index: 2;
  font-size: 6.6pt; font-weight: 700; color: #c0392b;
  background: #fdf1ee; border: .8pt solid #e8b7a8; border-radius: 1.4mm;
  padding: .25mm 1.1mm;
}
.box {
  display: inline-block; width: 2.8mm; height: 2.8mm;
  border: 1pt solid #8798a8; border-radius: .6mm;
}

.card.blank {
  border-style: dashed; border-color: #d5dfe9;
  align-items: center; justify-content: center;
}
.card.blank::after { display: none; }
.card.blank .blanklab {
  font-size: 8pt; color: #b8c7d6; letter-spacing: 1.4pt;
  border: .8pt dashed #e0e8f0; border-radius: 1.6mm;
  padding: 1.6mm 3mm;
}
`;

export function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * 高频词角标:累计被标记次数达到门槛的才印("高频的更应该标记出来")。
 * 次数 < 门槛(或拿不到次数)时不印,避免卡面被噪声填满。
 */
function freqBadge(w, highFreqMin) {
  const n = Number(w && w.seenCount);
  if (!Number.isFinite(n) || n < (Number(highFreqMin) || 2)) return "";
  return `<span class="freq">标记 ${n} 次</span>`;
}

/** 一张卡（四层结构） */
export function renderCard(w, idx, opts = {}) {
  const segs = (Array.isArray(w.segs) ? w.segs : [])
    .map((s) => `<div class="seg">${s.ipa ? `<span class="ipa">${escapeHtml(s.ipa)}</span>` : ""}<span class="en">${escapeHtml(s.en)}</span><span class="cn">${escapeHtml(s.cn)}</span>${s.note ? `<span class="note">${escapeHtml(s.note)}</span>` : ""}</div>`)
    .join("");
  const meaning = `${escapeHtml(w.pos || "")} ${escapeHtml(w.meaning || "")}`.trim();
  const wd = String(w.word || "");
  const wcls = wd.length >= 11 ? "word long" : "word";
  return (
    '<div class="card">' +
    freqBadge(w, opts.highFreqMin) +
    '<div class="chead">' +
    `<div class="idx">${String(idx).padStart(2, "0")}</div>` +
    '<div class="wtxt">' +
    `<div class="${wcls}">${escapeHtml(wd)}</div>` +
    `<div class="meta">${escapeHtml(w.phonetic || "")} &nbsp;·&nbsp; <span class="cn">${meaning}</span></div>` +
    "</div></div>" +
    `<div class="split">${segs}</div>` +
    `<div class="story">${escapeHtml(w.story || "")}</div>` +
    '<div class="write">' +
    '<div class="lab">✍ 挑战：盖住上面，把单词默写出来</div>' +
    '<div class="lines"><i></i><i></i></div>' +
    "</div>" +
    '<div class="foot"><span class="box"></span>已攻下</div>' +
    "</div>"
  );
}

export function renderPage(cardsHtml, pageNo, total, title, subtitle) {
  return (
    '<section class="page">' +
    `<div class="ph"><span class="t">${escapeHtml(title)}<small>${escapeHtml(subtitle)}</small></span>` +
    `<span class="n">第 ${pageNo} / ${total} 页</span></div>` +
    `<div class="grid">${cardsHtml.join("")}</div>` +
    "</section>"
  );
}

/**
 * 拼出整份 A4 卡片 HTML。
 * @param {{title?:string, subtitle?:string, words?:Array, highFreqMin?:number}} args
 * @returns {{html:string, pages:number, cards:number, perPage:number, highFreqCards:number}}
 */
export function buildCardHtml({ title = "趣味单词记忆卡", subtitle = "", words = [], highFreqMin = 2 }) {
  const list = Array.isArray(words) ? words : [];
  const chunks = [];
  for (let i = 0; i < list.length; i += PER_PAGE) chunks.push(list.slice(i, i + PER_PAGE));

  const body = chunks.map((chunk, pi) => {
    const cards = chunk.map((w, i) => renderCard(w, pi * PER_PAGE + i + 1, { highFreqMin }));
    while (cards.length < PER_PAGE) {
      cards.push('<div class="card blank"><div class="blanklab">空位 · 错词重写区</div></div>');
    }
    return renderPage(cards, pi + 1, chunks.length, title, subtitle);
  });

  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${CARD_CSS}</style></head><body>${body.join("")}</body></html>`;
  return {
    html,
    pages: chunks.length,
    cards: list.length,
    perPage: PER_PAGE,
    highFreqCards: list.filter((w) => Number(w && w.seenCount) >= Number(highFreqMin || 2)).length,
  };
}

/**
 * Word 版：改用表格排版（Word 对 flex/grid 支持差），每张卡一个表格块，打印友好。
 * 与 PDF 版共用同一份内容，只是容器换成 table。
 */
export function buildDocxHtml({ title = "趣味单词记忆卡", subtitle = "", words = [], highFreqMin = 2 }) {
  const list = Array.isArray(words) ? words : [];
  const blocks = list.map((w, i) => {
    const segs = Array.isArray(w.segs) ? w.segs : [];
    const segRow = segs
      .map((s) => `<td style="border:1px solid #b9cbdd;background:#eef4fb;text-align:center;padding:4px 6px;width:${Math.floor(100 / Math.max(1, segs.length))}%"><b style="color:#1f5a94">${escapeHtml(s.en)}</b><br><b style="color:#c0392b">${escapeHtml(s.cn)}</b></td>`)
      .join("");
    const freq = Number(w && w.seenCount) >= Number(highFreqMin || 2) ? ` <b style="color:#c0392b;font-size:9pt;">［标记 ${Number(w.seenCount)} 次］</b>` : "";
    return `
<table style="width:100%;border-collapse:collapse;border:1.5px solid #1b2a3a;margin:0 0 10px 0;">
  <tr><td style="padding:6px 8px 2px 8px;">
    <b style="font-size:16pt;">${String(i + 1).padStart(2, "0")}.</b>
    <b style="font-size:16pt;"> ${escapeHtml(w.word)}</b>${freq}
    <span style="font-size:9pt;color:#5c6f82;"> ${escapeHtml(w.phonetic || "")} · ${escapeHtml(w.pos || "")} ${escapeHtml(w.meaning || "")}</span>
  </td></tr>
  <tr><td style="padding:2px 8px;"><table style="width:100%;border-collapse:collapse;"><tr>${segRow}</tr></table></td></tr>
  <tr><td style="padding:4px 8px;background:#fdf6f1;border-left:3px solid #e0673a;font-size:10pt;">${escapeHtml(w.story || "")}</td></tr>
  <tr><td style="padding:6px 8px 2px 8px;color:#8798a8;font-size:8pt;">✍ 挑战：盖住上面，把单词默写出来</td></tr>
  <tr><td style="padding:0 8px 8px 8px;">
    <div style="border-bottom:1px dashed #c3d0dd;height:16px;"></div>
    <div style="border-bottom:1px dashed #c3d0dd;height:16px;"></div>
    <div style="margin-top:4px;font-size:8pt;color:#8798a8;">☐ 已攻下</div>
  </td></tr>
</table>`;
  });
  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body style="font-family:'Microsoft YaHei','微软雅黑',sans-serif;color:#1b2a3a;">
<h1 style="font-size:14pt;border-bottom:1.5px solid #1b2a3a;padding-bottom:4px;">${escapeHtml(title)} <span style="font-size:9pt;font-weight:400;color:#7a8b9c;">${escapeHtml(subtitle)}</span></h1>
${blocks.join("\n")}
</body></html>`;
  return { html, cards: list.length };
}

export function findBrowser() {
  for (const p of BROWSER_CANDIDATES) if (existsSync(p)) return p;
  return null;
}

export function findPandoc() {
  for (const p of PANDOC_CANDIDATES) {
    if (p === "pandoc") continue;
    if (existsSync(p)) return p;
  }
  return "pandoc"; // 交给 PATH 解析
}

function run(cmd, args, timeoutMs = 180000) {
  return new Promise((resolve) => {
    let done = false;
    let child;
    try {
      child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    } catch (err) {
      resolve({ code: -1, stderr: err.message });
      return;
    }
    let err = "";
    if (child.stderr) child.stderr.on("data", (d) => { err += d.toString(); });
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        try { child.kill(); } catch { /* 已退出 */ }
        resolve({ code: -2, stderr: `timeout after ${timeoutMs}ms` });
      }
    }, timeoutMs);
    child.on("error", (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code: -1, stderr: e.message });
    });
    child.on("exit", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code: code == null ? -1 : code, stderr: err });
    });
  });
}

function fresh(path, since) {
  return existsSync(path) && statSync(path).mtimeMs >= since - 1000;
}

/**
 * HTML → PDF（Edge/Chrome headless）。
 * 坑（专家包实测）：PDF 被预览器占用时 Edge 写失败但 returncode 仍是 0，必须用 mtime 判断并改名重试。
 */
export async function htmlToPdf(htmlPath, pdfPath) {
  const browser = findBrowser();
  if (!browser) return { ok: false, error: "找不到 Edge/Chrome，无法生成 PDF" };
  mkdirSync(dirname(pdfPath), { recursive: true });
  const t0 = Date.now();
  const url = new URL(`file:///${htmlPath.replace(/\\/g, "/")}`).href;

  let target = pdfPath;
  let rc = await run(browser, ["--headless=new", "--disable-gpu", "--no-pdf-header-footer", `--print-to-pdf=${target}`, url]);
  if (!fresh(target, t0)) {
    for (let n = 2; n < 10; n++) {
      const alt = pdfPath.replace(/\.pdf$/i, `(${n}).pdf`);
      rc = await run(browser, ["--headless=new", "--disable-gpu", "--no-pdf-header-footer", `--print-to-pdf=${alt}`, url]);
      if (fresh(alt, t0)) {
        target = alt;
        break;
      }
    }
  }
  if (!fresh(target, t0)) {
    return { ok: false, error: `PDF 生成失败（可能被预览器占用）: ${String(rc.stderr || "").slice(-300)}` };
  }
  return { ok: true, path: target, renamed: target !== pdfPath, bytes: statSync(target).size };
}

/** HTML → 首页 PNG（A4@96dpi，窗口就是真实页边界，超出会被截断 → 用于排版自检） */
export async function htmlToPng(htmlPath, pngPath, { page = 1 } = {}) {
  const browser = findBrowser();
  if (!browser) return { ok: false, error: "找不到 Edge/Chrome，无法生成预览图" };
  mkdirSync(dirname(pngPath), { recursive: true });
  const url = new URL(`file:///${htmlPath.replace(/\\/g, "/")}`).href;
  const rc = await run(browser, [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--force-device-scale-factor=2",
    "--window-size=794,1123",
    `--screenshot=${pngPath}`,
    url,
  ]);
  if (!existsSync(pngPath)) return { ok: false, error: `截图失败: ${String(rc.stderr || "").slice(-300)}` };
  return { ok: true, path: pngPath, page, bytes: statSync(pngPath).size };
}

/** HTML → Word（pandoc） */
export async function htmlToDocx(htmlPath, docxPath) {
  const pandoc = findPandoc();
  mkdirSync(dirname(docxPath), { recursive: true });
  const rc = await run(pandoc, [htmlPath, "-f", "html", "-t", "docx", "-o", docxPath]);
  if (!existsSync(docxPath)) return { ok: false, error: `pandoc 失败: ${String(rc.stderr || "").slice(-300)}（确认已安装 pandoc）` };
  return { ok: true, path: docxPath, bytes: statSync(docxPath).size };
}

/**
 * 一次出全套：HTML(卡片版) + PDF + Word + 首页预览 PNG。
 * @param {{outDir:string, stem:string, title:string, subtitle:string, words:Array, formats?:string[]}} args
 */
export async function exportCardSet({ outDir, stem, title, subtitle, words, formats = ["html", "pdf", "word"], highFreqMin = 2 }) {
  mkdirSync(outDir, { recursive: true });
  const built = buildCardHtml({ title, subtitle, words, highFreqMin });
  const htmlPath = join(outDir, `${stem}.html`);
  writeFileSync(htmlPath, built.html, "utf8");

  const out = { html: { ok: true, path: htmlPath }, pages: built.pages, cards: built.cards, warnings: [] };
  if (formats.includes("pdf")) out.pdf = await htmlToPdf(htmlPath, join(outDir, `${stem}_记忆卡.pdf`));
  if (formats.includes("word")) {
    const docxHtmlPath = join(outDir, `${stem}_word.html`);
    writeFileSync(docxHtmlPath, buildDocxHtml({ title, subtitle, words, highFreqMin }).html, "utf8");
    out.word = await htmlToDocx(docxHtmlPath, join(outDir, `${stem}_记忆卡.docx`));
  }
  if (formats.includes("png") || out.pdf?.ok) {
    out.preview = await htmlToPng(htmlPath, join(outDir, `${stem}_预览_第1页.png`));
    if (!out.preview.ok) out.warnings.push(`预览图未生成: ${out.preview.error}`);
  }
  if (out.pdf && !out.pdf.ok) out.warnings.push(out.pdf.error);
  if (out.word && !out.word.ok) out.warnings.push(out.word.error);
  if (out.pdf?.renamed) out.warnings.push("原 PDF 文件被占用，本次输出加了序号；关掉预览后重跑可换回正名");
  return out;
}
