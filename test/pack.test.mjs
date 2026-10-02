/**
 * 发版闸门:防止"仓库里有、npm 包里没有"这类只有实装时才暴露的打包漏文件。
 *
 * 背景(2026-10-02 实测事故,dsh-word-vault 1.0.5):
 *   package.json > files 只写了 `scripts/capture.ps1`,而 photos.mjs 运行时要
 *   `join(moduleDir, "scripts", "photo-scan.ps1")`。文件在仓库里(而且 tag v1.0.5 的
 *   git 树里就有),但没进 files 白名单 → npm 实装的 wordvault_scan_photo 一调用
 *   就报「扫描器脚本不存在」。仓库内全部测试照样绿:test/photos.test.mjs 只断言
 *   **仓库里**存在该文件,发现不了它没被打包。
 *
 * 唯一能在发版前发现的方法:看 npm 真正会打包哪些文件 → `npm pack --dry-run --json`。
 * 所以本文件把"打包清单"当作断言对象:新增 scripts/ 下的脚本却忘了放行 files 时,
 * 这里会红,而不是等到用户装完才报错。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let cached = null;

/** npm 真正会打包的文件清单(与用户 `npm i` 拿到的内容一致) */
function packList() {
  if (cached) return cached;
  try {
    const raw = execFileSync("npm", ["pack", "--dry-run", "--json"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      // Windows 上 npm 是 npm.cmd,必须走 shell
      shell: process.platform === "win32",
      maxBuffer: 64 * 1024 * 1024,
    });
    const data = JSON.parse(raw);
    cached = { files: (data[0].files || []).map((f) => String(f.path).replace(/\\/g, "/")) };
  } catch (err) {
    cached = { error: err && err.message ? err.message : String(err) };
  }
  return cached;
}

/** 环境里没有可用的 npm 时明确跳过,而不是静默变绿 */
function requirePack(t) {
  const r = packList();
  if (r.error) {
    t.skip(`本环境跑不了 npm pack,请在带 npm 的环境(CI)复核:${r.error.slice(0, 160)}`);
    return null;
  }
  return r.files;
}

test("打包闸门:scripts/ 下的每个脚本都会进 npm 包", (t) => {
  const files = requirePack(t);
  if (!files) return;
  const scriptsDir = join(root, "scripts");
  assert.ok(existsSync(scriptsDir), "仓库里应有 scripts/ 目录");
  const onDisk = readdirSync(scriptsDir).filter((f) => f.endsWith(".ps1"));
  assert.ok(onDisk.length > 0, "scripts/ 下应有 .ps1 脚本");
  for (const name of onDisk) {
    assert.ok(
      files.includes(`scripts/${name}`),
      `scripts/${name} 在仓库里有,但没进 npm 包 → 实装会报「脚本不存在」。请在 package.json > files 里放行(整个 "scripts" 目录最稳)`,
    );
  }
});

test("打包闸门:运行时必需文件都在包里", (t) => {
  const files = requirePack(t);
  if (!files) return;
  const required = [
    "index.mjs",
    "config.mjs",
    "words.mjs",
    "db.mjs",
    "capture.mjs",
    "photos.mjs",
    "web.mjs",
    "cordis.patch.yml",
    "scripts/capture.ps1",
    "scripts/photo-scan.ps1",
  ];
  for (const f of required) {
    assert.ok(files.includes(f), `${f} 必须在 npm 包里(实装运行时要用)`);
  }
});

test("打包闸门:放行整个 scripts 目录而不是逐个文件", () => {
  const pkg = JSON.parse(
    execFileSync(process.execPath, ["-e", "process.stdout.write(require('fs').readFileSync('package.json','utf8'))"], {
      cwd: root,
      encoding: "utf8",
    }),
  );
  const entries = Array.isArray(pkg.files) ? pkg.files : [];
  assert.ok(
    entries.includes("scripts") || entries.includes("scripts/"),
    "files 里应放行整个 scripts/ 目录,避免以后新增脚本又漏(本事故就是逐个文件白名单造成的)",
  );
});
