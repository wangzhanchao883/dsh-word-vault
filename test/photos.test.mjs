import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, mkdirSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makeWorkbookCanvas } from "./fixture.mjs";
import { findPhotos, photoHash, photoStem, scanPhoto, scanPhotos, loadProgress, scannerScript, PHOTO_EXTS } from "../photos.mjs";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "wv-photo-"));
}

/** 造一张测试页并落盘 */
function writeFixture(dir, name = "page1.bmp") {
  const p = join(dir, name);
  writeFileSync(p, makeWorkbookCanvas().toBmp());
  return p;
}

/** 该区域是否落在某个 y 区间内 */
function regionAtY(regions, y0, y1) {
  return regions.filter((r) => r.y0 <= y1 && r.y1 >= y0);
}

test("合成测试图能被识别:荧光笔 / 红线 / 红圈各命中,纯红涂鸦被剔除", async (t) => {
  if (process.platform !== "win32") return t.skip("照片扫描器依赖 Windows PowerShell + System.Drawing");
  const dir = tempDir();
  try {
    const photo = writeFixture(dir);
    const r = await scanPhoto({ photoPath: photo, outDir: join(dir, "out") });
    assert.equal(r.ok, true, r.error || "");

    // 荧光笔条带(y≈118-150)
    const hl = regionAtY(r.regions, 118, 150);
    assert.ok(hl.length >= 1, `没找到荧光笔区域;实际区域:${r.regions.map((x) => `${x.y0}-${x.y1}:${x.reasons}`).join(" | ")}`);
    assert.ok(hl.some((x) => x.reasons.includes("highlighter")), "荧光笔区域理由不对");

    // 红线(y≈292-298,裁剪上扩后覆盖到 264 附近的印刷词)
    const rl = regionAtY(r.regions, 292, 298);
    assert.ok(rl.length >= 1, "没找到红线区域");
    assert.ok(rl.some((x) => x.reasons.includes("red-line")), `红线区域理由不对:${rl.map((x) => x.reasons).join()}`);

    // 红圈(y≈510-575)
    const rc = regionAtY(r.regions, 515, 575);
    assert.ok(rc.length >= 1, "没找到红圈区域");
    assert.ok(rc.some((x) => x.reasons.includes("red-circle")), `红圈区域理由不对:${rc.map((x) => x.reasons).join()}`);

    // 纯红涂鸦区(y≈420-460)必须没有区域
    const scribble = regionAtY(r.regions, 415, 465);
    assert.equal(scribble.length, 0, `纯红涂鸦被误判成标记:${scribble.map((x) => `${x.y0}-${x.y1}:${x.reasons}`).join()}`);

    // 联络图存在,裁剪块也在
    assert.ok(r.sheets.length >= 1);
    assert.ok(existsSync(r.sheets[0]));
    assert.ok(r.regions.every((x) => existsSync(x.path)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("同一张照片重复扫描会被跳过(force 才重扫)", async (t) => {
  if (process.platform !== "win32") return t.skip("依赖 Windows");
  const dir = tempDir();
  try {
    const photo = writeFixture(dir);
    const outDir = join(dir, "out");
    const progressFile = join(dir, "progress.json");

    const first = await scanPhotos({ photos: [photo], outDir, progressFile });
    assert.equal(first.scanned, 1);
    assert.equal(first.reused, 0);
    assert.equal(loadProgress(progressFile)[photoHash(photo)].regions >= 1, true);

    const second = await scanPhotos({ photos: [photo], outDir, progressFile });
    assert.equal(second.scanned, 0);
    assert.equal(second.reused, 1);
    assert.equal(second.results[0].status, "already-scanned");

    const forced = await scanPhotos({ photos: [photo], outDir, progressFile, force: true });
    assert.equal(forced.scanned, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("maxPerRun 之外的先标 pending", async (t) => {
  if (process.platform !== "win32") return t.skip("依赖 Windows");
  const dir = tempDir();
  try {
    const a = writeFixture(dir, "a.bmp");
    const b = makeWorkbookCanvas().toBmp();
    b[100] = 7; // 让内容不同 -> hash 不同
    const bPath = join(dir, "b.bmp");
    writeFileSync(bPath, b);
    const r = await scanPhotos({ photos: [a, bPath], outDir: join(dir, "out"), progressFile: join(dir, "p.json"), maxPerRun: 1 });
    assert.equal(r.scanned, 1);
    assert.equal(r.pending, 1);
    assert.equal(r.results.filter((x) => x.status === "pending").length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("keepCrops=false 只留联络图", async (t) => {
  if (process.platform !== "win32") return t.skip("依赖 Windows");
  const dir = tempDir();
  try {
    const photo = writeFixture(dir);
    const r = await scanPhoto({ photoPath: photo, outDir: join(dir, "out"), keepCrops: false });
    assert.equal(r.ok, true, r.error || "");
    assert.ok(r.sheets.length >= 1 && existsSync(r.sheets[0]));
    const crops = r.regions.filter((x) => existsSync(x.path));
    assert.equal(crops.length, 0, "keepCrops=false 时不该留逐块 PNG");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findPhotos 递归找图并按扩展名过滤", () => {
  const dir = tempDir();
  try {
    const sub = join(dir, "sub");
    mkdirSync(sub);
    writeFileSync(join(dir, "a.JPG"), "x");
    writeFileSync(join(sub, "b.png"), "x");
    writeFileSync(join(dir, "notes.txt"), "x");
    const flat = findPhotos(dir, { recursive: false });
    assert.deepEqual(flat.map((p) => p.split(/[\\/]/).pop()), ["a.JPG"]);
    const deep = findPhotos(dir, { recursive: true });
    assert.equal(deep.length, 2);
    assert.ok(PHOTO_EXTS.includes(".png"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("photoHash 同名不同内容算两张", () => {
  const dir = tempDir();
  try {
    const p1 = join(dir, "x.bmp");
    writeFileSync(p1, makeWorkbookCanvas().toBmp());
    const h1 = photoHash(p1);
    const buf = makeWorkbookCanvas().toBmp();
    buf[200] = 9;
    const p2 = join(dir, "x2.bmp");
    writeFileSync(p2, buf);
    assert.notEqual(h1, photoHash(p2));
    assert.equal(photoStem(p1, h1).includes(h1.slice(0, 8)), true);
    assert.ok(scannerScript().endsWith("photo-scan.ps1"));
    assert.ok(existsSync(scannerScript()), "扫描器脚本应在仓库 scripts/ 下");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("照片不存在/脚本缺失给出可读错误", async () => {
  const dir = tempDir();
  try {
    const missing = await scanPhoto({ photoPath: join(dir, "nope.jpg"), outDir: join(dir, "o") });
    assert.equal(missing.ok, false);
    assert.match(missing.error, /不存在/);
    const noScript = await scanPhoto({ photoPath: writeFixture(dir), outDir: join(dir, "o"), script: join(dir, "nope.ps1") });
    assert.equal(noScript.ok, false);
    assert.match(noScript.error, /扫描器脚本不存在/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("真照片回归:若测试照片存在则跑一遍(照片不进仓库,缺了就跳过)", async (t) => {
  const realDir = "D:\\workout\\AI助理\\英语趣味单词\\拍照测试";
  if (process.platform !== "win32" || !existsSync(join(realDir, "p1.jpg"))) return t.skip("本机没有真照片");
  const dir = tempDir();
  try {
    const photo = join(dir, "p1.jpg");
    copyFileSync(join(realDir, "p1.jpg"), photo);
    const r = await scanPhoto({ photoPath: photo, outDir: join(dir, "out") });
    assert.equal(r.ok, true, r.error || "");
    // 真实页面上标记很多:至少该有 10 个区域,且必须出现荧光笔区域
    assert.ok(r.regions.length >= 10, `真照片区域太少:${r.regions.length}`);
    assert.ok(r.regions.some((x) => x.reasons.includes("highlighter")), "真照片上应有荧光笔区域");
    assert.ok(r.sheets.length >= 1 && existsSync(r.sheets[0]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
