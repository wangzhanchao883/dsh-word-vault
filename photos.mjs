/**
 * P4 照片通道:扫目录/单张照片 → 调 scripts/photo-scan.ps1 定位"被标记的印刷词"候选区域。
 *
 * 分工(实测定案,见 README P4):
 *   本模块 + PowerShell 扫描器 = **确定性 CV,负责召回**(宁可多给候选,不漏真标记)
 *   随后由对话里的模型读联络图 = **负责精度**(判断印刷体 vs 手写、读出到底是哪几个词)
 * 所以本模块不调模型、不判语义,只产出:每个候选区域的裁剪 PNG + 一张联络图。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const PHOTO_EXTS = [".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff"];

/** 扫描器脚本位置(与本模块同仓库) */
export function scannerScript(moduleDir = dirname(fileURLToPath(import.meta.url))) {
  return join(moduleDir, "scripts", "photo-scan.ps1");
}

/** 文件夹里的照片(默认递归),按修改时间倒序 */
export function findPhotos(dir, { recursive = true } = {}) {
  const out = [];
  const walk = (d) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDirectory()) {
        if (recursive && !e.name.startsWith(".")) walk(full);
        continue;
      }
      if (PHOTO_EXTS.includes(extname(e.name).toLowerCase())) out.push(full);
    }
  };
  walk(dir);
  return out
    .map((p) => {
      let mtime = 0;
      try {
        mtime = statSync(p).mtimeMs;
      } catch {
        /* 忽略 */
      }
      return { path: p, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime)
    .map((x) => x.path);
}

/** 照片内容 hash(去重用;同名不同内容也算新照片) */
export function photoHash(photoPath) {
  return createHash("sha256").update(readFileSync(photoPath)).digest("hex").slice(0, 16);
}

/** 生成一个安全的文件名主干 */
export function photoStem(photoPath, hash) {
  const base = basename(photoPath, extname(photoPath)).replace(/[^\w\u4e00-\u9fa5-]+/g, "_").slice(0, 24);
  return `${base}_${hash.slice(0, 8)}`;
}

export function loadProgress(progressFile) {
  try {
    return JSON.parse(readFileSync(progressFile, "utf8"));
  } catch {
    return {};
  }
}

export function saveProgress(progressFile, data) {
  mkdirSync(dirname(progressFile), { recursive: true });
  writeFileSync(progressFile, JSON.stringify(data, null, 2), "utf8");
  return progressFile;
}

function run(cmd, args, timeoutMs = 300000) {
  return new Promise((res) => {
    let done = false;
    let child;
    try {
      child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (err) {
      res({ code: -1, stdout: "", stderr: err.message });
      return;
    }
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => {
      out += d.toString();
    });
    child.stderr.on("data", (d) => {
      err += d.toString();
    });
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        try {
          child.kill();
        } catch {
          /* 已退出 */
        }
        res({ code: -2, stdout: out, stderr: `timeout after ${timeoutMs}ms` });
      }
    }, timeoutMs);
    child.on("error", (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      res({ code: -1, stdout: out, stderr: e.message });
    });
    child.on("exit", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      res({ code: code == null ? -1 : code, stdout: out, stderr: err });
    });
  });
}

/**
 * 扫描一张照片,产出裁剪块 + 联络图。
 * @returns {Promise<{ok:boolean, error?:string, stem?:string, cropDir?:string,
 *                    regions?:Array, sheets?:string[], skipped?:number, dropped?:number, ms?:number}>}
 */
export async function scanPhoto({
  photoPath,
  outDir,
  script,
  options = {},
  keepCrops = true,
  logger,
  timeoutMs = 300000,
}) {
  if (!existsSync(photoPath)) return { ok: false, error: `照片不存在:${photoPath}` };
  const scriptPath = script || scannerScript();
  if (!existsSync(scriptPath)) return { ok: false, error: `扫描器脚本不存在:${scriptPath}` };
  const hash = photoHash(photoPath);
  const stem = photoStem(photoPath, hash);
  const cropDir = join(outDir, stem);
  mkdirSync(cropDir, { recursive: true });

  const args = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath,
    "-ImagePath",
    photoPath,
    "-OutDir",
    cropDir,
    "-Stem",
    stem,
  ];
  if (options.satMin !== undefined) args.push("-SatMin", String(options.satMin));
  if (options.padUp !== undefined) args.push("-PadUp", String(options.padUp));
  if (options.maxCropH !== undefined) args.push("-MaxCropH", String(options.maxCropH));
  if (options.minDarkSpread !== undefined) args.push("-MinDarkSpread", String(options.minDarkSpread));

  const t0 = Date.now();
  const r = await run("powershell.exe", args, timeoutMs);
  const jsonPath = join(cropDir, `${stem}_marks.json`);
  if (!existsSync(jsonPath)) {
    const tail = String(r.stderr || r.stdout || "").slice(-400);
    if (logger) logger.warn(`dsh-word-vault: 照片扫描失败 ${basename(photoPath)} - ${tail}`);
    return { ok: false, error: `扫描失败:${tail || "没有产出结果文件"}` };
  }
  let data;
  try {
    data = JSON.parse(readFileSync(jsonPath, "utf8"));
  } catch (err) {
    return { ok: false, error: `结果文件解析失败:${err.message}` };
  }
  const sheets = (data.sheets || []).map((s) => join(cropDir, s));

  if (!keepCrops) {
    for (const f of readdirSync(cropDir)) {
      if (/^.*_r\d+_y\d+-\d+\.png$/.test(f)) {
        try {
          rmSync(join(cropDir, f));
        } catch {
          /* 删不掉就留着 */
        }
      }
    }
  }

  return {
    ok: true,
    hash,
    stem,
    cropDir,
    sheets,
    regions: (data.regions || []).map((x) => ({ ...x, path: join(cropDir, x.file) })),
    skipped: data.skipped || 0,
    dropped: (data.dropped || []).length,
    image: { width: data.width, height: data.height },
    ms: Date.now() - t0,
  };
}

/**
 * 批量扫描(自动跳过已处理过的照片,除非 force)。
 * @returns {Promise<{results:Array, scanned:number, reused:number, pending:number}>}
 */
export async function scanPhotos({
  photos,
  outDir,
  progressFile,
  force = false,
  options = {},
  keepCrops = true,
  maxPerRun = 8,
  script,
  logger,
}) {
  const progress = loadProgress(progressFile);
  const results = [];
  let scanned = 0;
  let reused = 0;

  for (const photoPath of photos) {
    let hash;
    try {
      hash = photoHash(photoPath);
    } catch (err) {
      results.push({ photo: photoPath, status: "error", error: `读取失败:${err.message}` });
      continue;
    }
    const known = progress[hash];
    if (known && !force && known.sheets && known.sheets.length && known.sheets.every((s) => existsSync(s))) {
      reused += 1;
      results.push({ photo: photoPath, status: "already-scanned", hash, ...known });
      continue;
    }
    if (scanned >= maxPerRun) {
      results.push({ photo: photoPath, status: "pending", hash });
      continue;
    }
    const r = await scanPhoto({ photoPath, outDir, script, options, keepCrops, logger });
    if (!r.ok) {
      results.push({ photo: photoPath, status: "error", hash, error: r.error });
      continue;
    }
    scanned += 1;
    const entry = {
      photo: photoPath,
      hash,
      stem: r.stem,
      cropDir: r.cropDir,
      sheets: r.sheets,
      regions: r.regions.length,
      image: r.image,
      ms: r.ms,
      scannedAt: new Date().toISOString(),
    };
    progress[hash] = entry;
    results.push({ photo: photoPath, status: "scanned", ...entry });
  }

  saveProgress(progressFile, progress);
  return {
    results,
    scanned,
    reused,
    pending: results.filter((r) => r.status === "pending").length,
    total: photos.length,
  };
}
