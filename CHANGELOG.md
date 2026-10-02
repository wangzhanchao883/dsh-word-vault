# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

本文件记录本项目所有值得注意的改动。格式参考 Keep a Changelog,版本号遵循语义化版本。

## [1.0.7] - 2026-10-02

### Fixed / 修复

- **桌面版(DSH 0.2.0 desktop shell)点「打开词库界面」完全没反应。** 桌面壳把 GUI 页面跑在
  Electron 自定义协议 `dsh-app://app` 下(主进程 `protocol.handle("dsh-app", ...)`:静态前端本地发、
  其余请求带 cookie 转发给本机 Host),而插件入口用的是相对链接
  `href="/word-vault" target="_blank"`:
  - Web 版:`location.origin` 就是 `http://127.0.0.1:<端口>`,解析成绝对地址,新标签页正常打开;
  - 桌面版:相对地址解析成 `dsh-app://app/word-vault`,而桌面主窗口的 `setWindowOpenHandler`
    只对 `http:`/`https:` 调用 `shell.openExternal`,其余一律 `{ action: "deny" }`
    → 点击被静默吞掉(同窗口跳转也被 `will-navigate` 拦下)。**不是插件没挂载**:桌面版进程里
    `/word-vault`、`/word-vault/api/*` 实测全 200。
  - 修法:入口地址改由 `globalThis.__DSH_TRANSPORT__.streamBaseUrl`(桌面壳给出的本机 Host 真实
    http origin)拼成**绝对 http 地址**;拿不到 http origin 时退回原来的相对路径,行为与旧版一致。
    桌面版点击后由系统默认浏览器打开词库页(`shell.openExternal` 的既定行为),Web 版不受影响。

### Added / 新增

- 回归闸门 `test/client.test.mjs`:断言桌面壳(`dsh-app://app` + `__DSH_TRANSPORT__`)下两个入口
  都是绝对 http 地址,同时覆盖 web 版、离线预览(退回相对路径)与脏值(`streamBaseUrl` 非法)
  三种情形,防止有人再把入口写回相对链接。
- 回归闸门 `test/pack.test.mjs`:README 里嵌入的**相对路径**图片必须都在 npm 打包清单里
  (绝对 URL 不受打包影响,不查)。1.0.5 那次「README 图片缺失」就是素材没进 `files` 白名单,
  仓库内测试发现不了,只有打包清单能发现。
  说明:`docs/*.png` 只在 README 正文里被反引号提及、并非嵌入图片,故**不进包**(避免白涨 ~350KB)。

## [1.0.6] - 2026-10-02

### Fixed / 修复

- **npm 包里漏了 `scripts/photo-scan.ps1`,拍照通道在实装版必失败。** 1.0.5 的
  `package.json > files` 白名单里只有 `scripts/capture.ps1`(而 tag `v1.0.5` 的 git 树里
  **是**有 `scripts/photo-scan.ps1` 的,属于打包漏放行,不是文件后补),于是 `npm i` 装出来的
  包里 `scripts/` 只剩一个脚本,`wordvault_scan_photo` 一调用就报
  「扫描器脚本不存在:…\node_modules\dsh-word-vault\scripts\photo-scan.ps1」。
  - 修法:`files` 改为放行整个 `scripts/` 目录,不再逐个文件列白名单。
  - 影响面:**所有 npm 装法**(含实装校验用的 profile)拍照通道全废;GitHub 直装不受影响;
    剪贴板通道正常(`capture.ps1` 一直在包里)。

### Added / 新增

- **发版闸门 `test/pack.test.mjs`:** 直接跑 `npm pack --dry-run --json`,断言 `scripts/` 下每个
  脚本 + 全部运行时必需文件都在打包清单里。仓库内测试发现不了「仓库里有、npm 包里没有」
  (1.0.5 的 `test/photos.test.mjs` 只断言仓库里存在该文件,照样绿),只有打包清单能发现。

## [1.0.5] - 2026-10-02

**发布通道迁移 —— 无代码变更、无行为变更。**

改用 npm Trusted Publishing（GitHub Actions + OIDC）发布，不再依赖任何长期令牌。
本版本用于验证新的发布链路，并让该版本带上 provenance（可验证的来源证明）。

## [1.0.4] - 2026-09-29

### Changed / 变更

- **兼容 DSH 0.2 / DSH 0.2 compatibility.** 本机在 `0.2.0-rc.1` 实测通过,**无代码变更**,只改
  `peerDependencies` 两个条目。
  - `@deepseek-ai/dsh-llm` 与 `@deepseek-ai/dsh-tools` 由 `^0.1.1-rc.2`
    （等价于 `>=0.1.1-rc.2 <0.2.0-0`）改为
    `>=0.1.1-rc.2 <0.2.0-0 || >=0.2.0-rc.1 <0.3.0-0`。
  - 原因：DSH 门禁比的是**整个 DSH 的版本号**（与 peer 里写的那个子包实际装哪版无关）。
    旧上界把 0.2.0 的全部预发布排除掉,插件在 0.2.0 的 `plugin add` 阶段被直接
    `installation rejected`；0.1.7 只是启动期 `skipping`,0.2.0 提前成安装期硬拒。
  - **必须显式写预发布分支**：node-semver 只放行「范围内存在同一 `major.minor.patch` 元组、
    且自身带预发布标签的比较符」的预发布版本,故 `>=0.2.0-rc.1 <0.3.0-0` 必须显式列出,
    否则 `0.2.0-rc.1` 会被静默漏掉。
  - **实测结论**：改后可在 `0.2.0-rc.1` 上装入并激活,host 工具、词库、`/word-vault` 页面与
    浏览器端设置面板（`configForms`）均正常；0.1.7 上行为不变。

## [1.0.3] - 2026-09-25

### Fixed / 修复

- **兼容 DSH 0.1.7 的设置契约 / DSH 0.1.7 settings-contract compatibility.**
  DSH 0.1.7 移除了旧的 `settingsScope` / `settings.register` 契约,改为
  **宿主侧导出 `Config` schema + 浏览器侧 `ctx.configForms.get(entryId)`**。
  本插件按新契约重写了两半:host 端新增 `export const Config`(顶层为
  `z.object`,所有可写字段标 `.volatile()`),并把原来的
  `settings.register(NS, schema, { base })` + `scope.get()` + `scope.watch()`
  整块换成 `ctx.inject(["settings"], …)` 里的 `settings.describe()` 主动重读;
  浏览器端把 `ctx.settingsScope.bind({ namespace })` 换成
  `ctx.configForms.get("dsh-word-vault")`。 / DSH 0.1.7 dropped the old
  `settingsScope` / `settings.register` contract in favour of a host-side
  exported `Config` schema plus a browser-side `ctx.configForms.get(entryId)`.
  Both halves were rewritten to the new contract.
- 设置面板**功能没有丢失** —— 新 API 与旧 `settingsScope` 同名同义,只是入参从
  `bind({namespace})` 变成 `get(entryId)`;快照结构
  (`{status, value, base, user, revision, writable, mode}`)与读写签名都没变,
  因此前端组件体无需改动。 / No panel functionality was lost: the new API is
  same-name, same-semantics as the old scope — only the argument changed.

### Added / 新增

- 导出 `Config` 时的两处硬性契约(缺一不可,均由 0.1.7 的 `dsh-settings`
  源码门禁强制):
  1. **必须用具名导出** —— `export const Config` / `export function apply`,
     **绝不能加 `export default`**。`cordis-plugin-loader` 的 `unwrapExports`
     会优先取 `default`,一旦存在 `default`,plugin 就变成那个函数,
     `fiber.runtime.Config` 直接读不到,`settings.describe()` 会把本条目过滤掉
     (设置面板整个消失),`settings.write()` 会抛
     `No configurable plugin entry`。
  2. **每个可写字段都要标 `.volatile()`** —— 否则 `volatileForm()` 返回
     `undefined`,条目同样会被 `describe()` 过滤掉。
  以上两点均有测试护栏(递归 walk `Config.dict` 检查 `meta.volatile`)。
- 新增 `.volatile()` 的向后兼容降级包装 `vol()`:`schemastery < 3.18.4` 上没有
  `.volatile` 方法,直接调用会在模块加载期抛 `volatile is not a function`,
  连老版 DSH 一起崩掉。现在老版本上静默降级为普通字段(只是不能免重挂载热改)。
  同时在 `devDependencies` 里显式声明 `"@deepseek-ai/schemastery": "^3.18.4"`。
- 新增插件参数的**扁/嵌套入口归一化** `normalizeConfigInput()`:0.1.7 把
  `cordis.patch.yml` 里 `insert[].config` 的值直接当 `Config` 校验后的对象传入
  (嵌套结构),而历史调用方传的是扁平 key。现在两种入参都能正确解析。

### Changed / 变更

- `package.json`:版本升至 `1.0.3`;`dsh.client` 恢复声明(此前被误删,那等于砍掉
  整个 Web 界面),但**只留真实存在的两个包** ——
  `@deepseek-ai/dsh-client-locale` 与 `@deepseek-ai/dsh-client-ui-settings`;
  移除 `@deepseek-ai/dsh-client-runtime`(0.1.7 已不存在该包,组合器只会静默跳过)。
- `translate.mjs`:`PLUGIN_SOURCE` 由 `{ kind: "plugin", plugin: "dsh-word-vault" }`
  改为 `{ kind: "plugin:dsh-word-vault", form: "instructions" }`。该常量只用于
  `ctx.llm.stream({ messages })` 的消息来源标注,不写入会话,因此不属于 v4 会话
  格式门禁的拦截范围;此处改用自描述的单字段形式。
- 测试:新增 3 条 0.1.7 契约护栏(导出 `Config` 且全字段 volatile / 扁平入口
  归一化 / 设置读取计数),并同步更新客户端注入契约断言。

### Verified / 验证

- `npm run check` 通过;`npm test` **139/139 通过**。
- 逐条对照 0.1.7 一手源码取证:
  - `dsh-settings/lib/index.js` —— `describe()` 返回项字段名为 `ns`(=`profile`
    条目 id)与 `value`;`update(ns, patch, expectedRevision)` 为浅合并语义;
    `write()` 的两道门禁(`No configurable plugin entry` / `is not volatile`)。
  - `cordis/lib/index.js:1631` —— `Config: plugin.Config`。
  - `cordis-plugin-loader/lib/index.js:664` —— `unwrapExports` 优先取 `default`。
  - `dsh-client-ui-settings/lib/types/client/config-form.d.ts` 与
    `contract/slots.d.ts` —— `ConfigForms.get(entryId)` 与 `settings.section` 槽位。
  - 分类讨论:`.volatile()` 只加 `meta.volatile: true`,`type` 与 `toJSON()`
    结构不变(已实测),`volatileForm()` 复刻验证能正确生成表单并过滤非 volatile 字段。
- peerDependencies 的 `^0.1.1-rc.2` **无需改动**:`dsh-app-boot` 的
  `evaluatePluginCompatibility` 用 `semver.satisfies(runtime, range, { includePrerelease: true })`
  判定,实测 `0.1.7-rc.2` 落在 `^0.1.1-rc.2`(= `>=0.1.1-rc.2 <0.2.0`)内。
