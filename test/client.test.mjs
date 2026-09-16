import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { SETTINGS_SPEC } from "../web.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const clientPath = join(here, "..", "client.js");

/** 桩 React:把元素树做成普通对象,便于直接遍历断言(不需要 DOM) */
function stubReact() {
  const hooks = [];
  return {
    createElement(type, props, ...children) {
      // 真实 React 把 children 放进 props.children,函数组件靠它取子节点
      const flat = children.flat();
      return { type, props: { ...(props || {}), children: flat.length === 1 ? flat[0] : flat }, children: flat };
    },
    useState(init) {
      hooks.push(init);
      return [typeof init === "function" ? init() : init, () => {}];
    },
    useEffect() {},
    useRef() {
      return { current: null };
    },
  };
}

/** 在 Node 里加载经典脚本形式的客户端半边,返回 {module, registrations, effects, dictionaries} */
function loadClientBundle() {
  const script = readFileSync(clientPath, "utf8");
  const loads = [];
  const win = { __ModuleLoader__: { load: (m) => loads.push(m) } };
  const react = stubReact();
  const requireFn = (name) => {
    if (name === "react") return react;
    throw new Error(`客户端半边 require 了未声明的模块:${name}`);
  };
  const documentStub = {
    head: { appendChild() {} },
    createElement: () => ({ setAttribute() {}, set textContent(v) {} }),
  };
  // 经典脚本:以 window / require / document 作为形参求值
  new Function("window", "require", "document", script)(win, requireFn, documentStub);
  assert.equal(loads.length, 1, "应调用一次 __ModuleLoader__.load");
  const mod = loads[0];
  assert.equal(mod.id, "dsh-word-vault");
  assert.equal(typeof mod.factory, "function");

  const registrations = [];
  const effects = [];
  const dictionaries = [];
  const slots = {
    inject(name, cb) {
      registrations.push({ slotName: name, entry: cb() });
    },
    register(descriptor, Component) {
      registrations.push({ slotName: descriptor.name, descriptor, Component });
      return () => {};
    },
  };
  const ctx = {
    effect: (fn, label) => {
      effects.push({ label, result: fn() });
      return () => {};
    },
    locale: {
      register: (ns, dict) => {
        dictionaries.push({ ns, dict });
        return () => {};
      },
      bind: () => (key) => key,
    },
    settingsScope: { bind: (opts) => ({ namespace: opts.namespace }) },
    slots,
  };
  const exported = mod.factory(requireFn);
  exported.apply(ctx);
  return { exported, registrations, effects, dictionaries };
}

/** 从元素树里收集所有 label 文本(桩 t 是恒等函数,所以 label 就是字段 key)。
 *  函数组件要"展开"一下 —— React 会调用它们,桩 createElement 只记录元素。 */
function collectLabels(node, out = []) {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const n of node) collectLabels(n, out);
    return out;
  }
  if (typeof node.type === "function") {
    // 组件:用 props 调用一次,把结果继续展开(桩 hooks 能承受)
    try {
      return collectLabels(node.type(node.props), out);
    } catch {
      return out;
    }
  }
  if (node.type === "label" && node.children) for (const c of node.children) if (typeof c === "string") out.push(c);
  for (const c of node.children || []) collectLabels(c, out);
  return out;
}

test("客户端半边:契约正确(导出/注入/槽位/副作用都用 effect 注册)", () => {
  const { exported, registrations, effects, dictionaries } = loadClientBundle();
  assert.equal(exported.name, "dsh-word-vault");
  assert.deepEqual(exported.inject, ["slots", "locale", "settingsScope"]);

  // 样式与词典都必须是 effect(注册即 effect,插件卸载自动摘除)
  assert.equal(effects.length, 2, "应有样式与词典两个 effect");
  assert.ok(effects.every((e) => typeof e.label === "string" && e.label.startsWith("dsh-word-vault:")), "effect 应带可读 label");
  assert.equal(dictionaries.length, 1);
  assert.equal(dictionaries[0].ns, "settings.wordVault");
  assert.ok(dictionaries[0].dict.zh.nav && dictionaries[0].dict.en.nav, "中英文词典都要有 nav");

  // 槽位:settings.section + id/label/inject
  const entry = registrations.find((r) => r.slotName === "settings.section");
  assert.ok(entry, "应注册到 settings.section 槽位");
  assert.equal(entry.descriptor.name, "settings.section");
  assert.equal(entry.descriptor.id, "word-vault");
  assert.equal(entry.descriptor.order, 300);
  assert.equal(entry.descriptor.label(), "nav", "label 应走 locale(桩 t 恒等)");
  assert.equal(typeof entry.descriptor.inject, "function");
  const injected = entry.descriptor.inject();
  assert.ok(injected.scope, "应注入 settingsScope");
  assert.equal(injected.scope.namespace, "dsh-word-vault", "命名空间必须与 host 侧一致");
  assert.equal(typeof entry.Component, "function");
});

test("客户端半边:面板覆盖 SETTINGS_SPEC 的全部字段(两个界面不许漂移)", () => {
  const { registrations } = loadClientBundle();
  const entry = registrations.find((r) => r.slotName === "settings.section");
  const scope = {
    getSnapshot: () => ({ status: "ready", value: { enabled: true, highFreqMin: 2, autoCommit: false } }),
    subscribe: () => () => {},
    set: () => Promise.resolve(),
  };
  const tree = entry.Component({ scope, t: (k) => k });
  const labels = collectLabels(tree);

  const specKeys = SETTINGS_SPEC.map((s) => s.key);
  const missing = specKeys.filter((k) => !labels.includes(k));
  assert.deepEqual(missing, [], `客户端面板缺少这些字段:${missing.join(", ")}`);

  // 反向:面板里出现的字段也必须在 SETTINGS_SPEC 里(防止面板写了 host 不认识的键)
  const extra = labels.filter((k) => /^[a-zA-Z][a-zA-Z0-9]*$/.test(k) && !specKeys.includes(k));
  assert.deepEqual(extra, [], `面板里有 host 侧设置清单没有的字段:${extra.join(", ")}`);
});

test("客户端半边:面板按分组渲染,且带上说明与两个入口", () => {
  const { registrations } = loadClientBundle();
  const entry = registrations.find((r) => r.slotName === "settings.section");
  const scope = { getSnapshot: () => ({ status: "ready", value: {} }), subscribe: () => () => {}, set: () => Promise.resolve() };
  const tree = entry.Component({ scope, t: (k) => k });
  const htmlish = JSON.stringify(tree);
  for (const g of ["gGeneral", "gCapture", "gReview", "gCards", "gExam", "gPhoto"]) {
    assert.ok(htmlish.includes(`"${g}"`), `缺少分组 ${g}`);
  }
  assert.ok(htmlish.includes("/word-vault"), "应有词库界面入口");
  assert.ok(htmlish.includes("/word-vault/help"), "应有使用说明入口");
  // 状态未就绪时给可读提示,而不是崩
  const loading = entry.Component({ scope: { getSnapshot: () => ({ status: "loading" }), subscribe: () => () => {} }, t: (k) => k });
  assert.equal(loading.props.className, "wv-tip");
});

test("客户端半边:package.json 声明 ./client 与 dsh.client(照参照插件写法)", () => {
  const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));
  assert.equal(pkg.exports["./client"], "./client.js");
  assert.equal(pkg.dsh.client.platform, "web");
  assert.deepEqual(pkg.dsh.client.inject, [
    "@deepseek-ai/dsh-client-locale",
    "@deepseek-ai/dsh-client-runtime",
    "@deepseek-ai/dsh-client-ui-settings",
  ]);
  assert.ok(pkg.files.includes("client.js"), "client.js 要在 files 白名单里");
  const src = readFileSync(clientPath, "utf8");
  assert.ok(src.includes("window.__ModuleLoader__.load"), "必须是经典脚本形式的 loader 产物");
  assert.ok(!/^\s*import\s/m.test(src.split("factory:")[0]), "不得用 ESM import");
  for (const token of ["--dsw-alias-border-l2", "--dsw-alias-label-primary", "--dsw-alias-bg-layer-2"]) {
    assert.ok(src.includes(token), `配色应使用 DSH 主题变量 ${token}`);
  }
});
