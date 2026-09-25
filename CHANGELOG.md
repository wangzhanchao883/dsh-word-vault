# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

本文件记录本项目所有值得注意的改动。格式参考 Keep a Changelog,版本号遵循语义化版本。

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
