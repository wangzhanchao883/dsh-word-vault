# dsh-word-vault · 英语生词库

多用户英语生词库 DSH 插件：**复制 → 鼠标处弹窗点选 → 入库并反馈**，LLM 自动翻译，SQLite 计次，按时间 / 频次 / 掌握度查询，后续围绕它做打印卡片与考试闭环。

---

## 1. 录入（P1 已交付两条通道）

| 通道 | 触发 | 取词 | 常驻进程 |
|---|---|---|---|
| ① 剪贴板 + 点选弹窗（主线） | 用户照常 `Ctrl+C` | 助手只**读**剪贴板（序列号检测变更），宿主切词后弹窗 | PowerShell 助手 |
| ③ 对话录入（标配兜底） | 在 DSH 里贴文字 → `wordvault_add` | 宿主直接切词入库 | 不需要 |

### 主线交互（2026-09-16 定案）

用户要求"必须有正反馈、且不要什么复制都往库里灌"，因此改成**点选才入库**：

```
Ctrl+C 复制英文
   → 助手发现剪贴板变化，把文本交给宿主切词（约 0.3s）
   → 在【鼠标所在位置】弹出对话框（多显示器下跟随鼠标那块屏）：
        ┌───────────────────────────────┐
        │ 生词入库 · 识别到 4 词         │
        │ plant  world  share  animal   │
        │ [ 用户1 ] [ 用户2 ] [ 忽略 ]   │
        └───────────────────────────────┘
   → 点「用户N」→ 入库 → 同一窗口变成反馈（2.6s 后自动消失）：
        ┌───────────────────────────────┐
        │ ✔ 已录入成功                   │
        │ 4 词 → 用户1                   │
        │ 今日累计录入 12 词             │
        └───────────────────────────────┘
   → 20 秒没人点（可配）→ 自动消失、**不落库**
```

- **常驻小条**：默认在屏幕右上角（距右边缘 40px），显示「生词库监听中 / 今日累计 N 词 / 最近一次结果」。**可以用鼠标拖到任何地方**，松手即记住位置（写在 `word-vault-runtime\chip-pos.json`，重启后仍在原位；若换了显示器/分辨率导致位置落在屏幕外，会自动回到默认角落）。
- **外观**：白底卡片 + 淡蓝边框/标题条 + 淡黄高亮（今日累计条、忽略按钮）+ 黑字；进程已设为 DPI-aware，在高缩放（本机 125%）下 1:1 渲染不发虚。外观基准图见 `docs/ui-chip.png`（小条）与 `docs/ui-dialog.png`（点选弹窗）——这两张是 `test/helper-visual.ps1` 自动截的实机图。
- **不落库的三种情况**：没人点选、点「忽略」、超时。普通复制（终端命令、配置片段）因此不会被误录。
- 需要旧的"复制即录"手感时，设置里把 `autoCommit` 打开即可。

> 为什么不用全局热键 + 模拟 Ctrl+C：见记忆「全局热键方案的结构性成本」——修饰键侧别码（左 Ctrl = 0xA2）、模拟复制要写剪贴板而**跨进程 OLE 剪贴板写会互锁**、注入的按键需要目标程序泵消息才生效。剪贴板监听把这三点全部消掉。

## 2. 架构

```
① 常驻助手 scripts/capture.ps1（PowerShell + WinForms，纯 ASCII 源码）
   轮询剪贴板序列号 → 变更时读文本/图片 → 追加写队列 JSONL
        ↓ 文件协议（本机 PowerShell 管道回传不可靠，全部走文件）
② 宿主 index.mjs / capture.mjs
   增量读队列(250ms) → 有归属就入库；无归属则切词并写"待点选"提示
   读命令文件(commit/dismiss) → 入库或丢弃 → 写回执(含今日累计)
        ↓
③ 工具层 wordvault_*（对话可用，不依赖助手进程）
```

| 文件 | 方向 | 内容 |
|---|---|---|
| `capture-queue.jsonl` | 助手 → 宿主 | 每行 `{ts,kind:'text'|'image',text,imagePath,via,user}` |
| `capture-prompt.json` | 宿主 → 助手 | `{id,at,wordCount,words[],preview}` → 触发弹窗 |
| `capture-commands.jsonl` | 助手 → 宿主 | 每行 `{ts,action:'commit'|'dismiss',id,user}` |
| `capture-result.json` | 宿主 → 助手 | `{at,ok,message,todayCount,user,kind,id}` → 弹窗/小条显示 |
| `capture-status.json` | 助手 → 宿主 | 助手状态（含 `dialog.visible/title`，供自检与测试） |
| `capture-trigger.txt` | 宿主 → 助手 | 写入用户名 = 立刻抓一次当前剪贴板 |
| `capture-debug.log` | 助手 → 宿主 | 调试日志（`debug=true` 时） |

运行时文件落在 `<dbPath 所在目录>\word-vault-runtime\`。

## 3. 工具

| 工具 | 用途 |
|---|---|
| `wordvault_add` | 把一段英文录入指定用户库（切词 → 翻译 → 落库 → 计次） |
| `wordvault_query` | 按时间区间 / 出现次数区间 / 掌握状态 / 排序 查询词条 |
| `wordvault_status` | 库统计 + 各用户 + 助手状态 + 最近录入日志（自检排障用） |
| `wordvault_capture_clipboard` | 请求助手立刻抓一次剪贴板 |
| `wordvault_fix_last` | 撤销最近一次录入 / 改到另一个用户库 |

## 4. 数据模型（node:sqlite）

```
users(id,name,enabled,created_at)
dict(term PK,phonetic,pos,meaning,source,created_at,updated_at)   -- 全局词典缓存,一个词只翻一次
words(id,user_id,kind,term,lemma,first_seen_at,last_seen_at,seen_count,status,streak,wrong_count,last_exam_at,mastered_at)
      UNIQUE(user_id,kind,lemma)                                  -- kind=word 单词 / kind=phrase 词组
events(id,user_id,word_id,kind,via,context,capture_id,created_at) -- 每次录入一条,统计与回滚的依据
captures(id PK,user_id,via,text,item_count,status,created_at,updated_at)
exam_sessions / exam_answers                                      -- P3 考试闭环预留
```

- **计次口径**：同一批内按 `lemma` 去重（同一次录入里重复出现只算一次）；跨批次每录一次 `seen_count + 1`；`term` 保留最近一次原文形态，展示以 `lemma` 为准。
- **今日累计**：`todayCount()` 取 `substr(created_at,1,10)` 与本地日期比较（不用 SQLite `date()`,它会按 UTC 归一,跨零点算错一天）。
- **撤销**：删掉该次 `capture_id` 的 events，受影响词条按剩余 events 重算；不再有任何 event 的词条整条删除（即"这次新建的"）。
- **可重建性**：`words` 是 `events` 的投影，`rebuildCounters()` 可全量重算。

## 5. 配置（settings 命名空间 `dsh-word-vault`）

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | true | 总开关 |
| `dbPath` | `D:\workout\AI助理\英语趣味单词\单词库\words.db` | 库文件 |
| `wordsDir` / `outputDir` / `imageDir` | 既有 `英语趣味单词\` 目录约定 | 词表 JSON / 产物 / 剪贴板截图 |
| `provider` / `model` | `deepseek-official` / `deepseek-v4-flash` | 翻译与后续卡片生成 |
| `autoTranslate` | true | 录入即翻译（关掉只记词形） |
| `defaultUser` | 用户1 | `autoCommit=true` 时的归属 |
| `users` | 用户1 / 用户2 | 多用户列表（弹窗按钮按它生成） |
| `helperEnabled` | true | 是否常驻助手 |
| **`autoCommit`** | **false** | 复制后是否**直接**入默认库（默认关：必须点选） |
| **`promptTimeoutMs`** | **20000** | 弹窗等待上限，超时丢弃（0=一直等） |
| **`showDialog`** | **true** | 是否显示点选弹窗 |
| `showFloatWindow` | true | 常驻小条（监听状态 + 今日累计） |
| `clipPollMs` | 350 | 剪贴板轮询间隔 |
| `minLen` / `maxLen` | 2 / 400 | 忽略过短与过长文本 |
| `floatOffsetX/Y` | 40 / 40 | 小条默认位置：**距屏幕右边缘 / 距顶部**的像素偏移（不是绝对坐标）；拖动后以记住的位置为准 |
| `floatAutoHide` | false | 小贴鼠标移开后淡化 |
| `watchImages` | true | 剪贴板图片也交给插件（P4 拍照通道用） |
| `keepPhrases` | true | 2~5 词短文本另存一条「词组」 |
| `maxWordsPerCapture` | 30 | 单次录入最多收多少词 |
| `extraStopwords` | [] | 追加停用词 |

## 6. 安装与重载

```powershell
dsh plugin --profile web add D:/workout/deepseekharness/dsh-plugin/dsh-word-vault
# 注意:dsh plugin add 只往 dependencies 加 link 行,还需把 "dsh-word-vault" 手工加进
#      package.json 的 dsh.profile.bundles,否则 --dump-config 里看不到它

dsh --profile web --dump-config      # 应出现 "# == dsh-word-vault" 且无 FAILED
```

- 宿主侧改动（`index.mjs` / `capture.mjs` / 工具 / 设置项）：**必须重启 DSH**。
- 助手脚本改动（`scripts/capture.ps1`）：重启 DSH 会重新拉起助手即可生效。
- 依赖：`@deepseek-ai/dsh-tools` 与 `dsh-llm` 声明为 **peerDependencies**（宿主共享包，避免插件市场"遮蔽宿主版本"告警），本机同时在 `devDependencies` 里保留，供 `npm install` 装进插件自己的 `node_modules`（link 安装不会替插件装依赖）。

## 7. 测试

```powershell
cd D:\workout\deepseekharness\dsh-plugin\dsh-word-vault
node --test test/words.test.mjs test/db.test.mjs test/capture.test.mjs test/index.test.mjs
# 38 项:切词/词形还原、库 CRUD/撤销/改库/今日计数、宿主编排(点选/忽略/超时/autoCommit/翻译缓存)、插件契约与工具链路

powershell.exe -NoProfile -ExecutionPolicy Bypass -File test/helper-clipboard.ps1
# 17 项断言:剪贴板入队、弹窗出现、真实点击「用户1」→ commit、成功反馈+今日累计+自动消失、
#             超时→dismiss、点忽略→dismiss、超长/无字母过滤、图片只入队一次

powershell.exe -NoProfile -ExecutionPolicy Bypass -File test/helper-visual.ps1
# 14 项断言:助手在 capture-status.json 上报 chip/dialog 真实矩形 → 按该矩形截图并做像素断言
#            (小条 白底/淡黄条/淡蓝边框/黑字;弹窗 淡蓝标题条/白底/淡蓝按钮/淡蓝边框),
#            再模拟一次拖动断言"位移=鼠标位移"且位置已持久化。截图落在临时目录供人眼复核。
```

助手端到端测试**不需要人工操作**：它用 `EnumChildWindows` 找到弹窗里的按钮句柄，`SendMessage(BM_CLICK)` 真点一下，再断言命令文件；视觉测试用 `CopyFromScreen` 截图后逐像素比对颜色。

## 8. 实测踩坑（都已在代码/测试里处理，改代码前务必看）

**PowerShell / 助手侧**
1. PS 5.1 把无 BOM 的 UTF-8 `.ps1` 当 ANSI/GBK 读 → 中文字面量被撕碎、语法报错。因此 `capture.ps1` **全 ASCII 源码**，中文文案从 UTF-8 JSON 配置注入。
2. PS 5.1 的 `Set-Content/Add-Content -Encoding UTF8` **会写 BOM** → 污染 JSONL 首行。助手所有写出改用 `[System.IO.File]::WriteAllText/AppendAllText` + `UTF8Encoding($false)`。
3. **单元素数组在函数返回时被拆包** → `$lines[0]` 变成第一个字符。调用方一律 `@(...)`；函数内 `return ,@()` 会破坏管道语义（本次踩过）。
4. 低级键盘钩子的修饰键是**侧别码**（左 Ctrl = 0xA2），不是 0x11（已放弃该方案，记录备查）。
5. 跨进程写 OLE 剪贴板会**互锁**（实测卡死 95 秒级）→ 助手全程只读剪贴板。

**交互 / WinForms**
6. 弹窗按钮放在 `Panel` 里，`FindWindowEx` **只搜直接子窗口**找不到 → 自检/测试要用 `EnumChildWindows` 遍历后代。
7. 状态文件用"临时文件 + Move-Item"原子替换，读侧（Node/PS）可能刚好撞上 → 两侧都要重试/容错。
8. 弹窗/小条必须带 `WS_EX_NOACTIVATE` + `ShowWithoutActivation`，否则点击会夺走源程序焦点。
9. 多显示器：用 `Screen::FromPoint(Cursor.Position)` 定位，不要固定用 `PrimaryScreen`。
10. **DPI 缩放是最大的坑（本机 1920×1080 @125%，虚拟屏幕只有 1536×864）**：DPI-unaware 进程拿到的是**虚拟化坐标**，于是 `Form.Left/Top` 与物理像素不一致 → 拖动时窗口"甩飞"（实测跳到 x=1394）、默认右上角定位偏移、文字发虚。修法：在**创建任何窗口之前**调 `SetProcessDPIAware()`（见 `[WvClip]::MakeDpiAware()`）；自检/截图脚本也必须同样声明，否则 `CopyFromScreen` 采到的坐标全错位。
11. 视觉自检不要**猜坐标**：`floatOffsetX/Y` 是"距右边缘/距顶部的偏移"，不是绝对坐标 —— 一开始按 (40,40) 采样，结果全采到浏览器上了。正确做法是让助手把窗口真实矩形上报进 `capture-status.json`，测试按矩形截图/采样。
12. 拖动用"按下时的光标偏移 + `Cursor.Position` 差值"计算，并给被按住的控件设 `Capture=$true`，否则快速拖出控件范围就丢事件。

**宿主 / 依赖**
13. `dsh plugin add <path>` 只加依赖行、**不改 bundles**。
14. link 安装不会替插件装依赖，插件必须自带 `node_modules`；宿主共享包声明成 `dependencies` 会被插件市场告警（改 peer + dev 两份）。
15. `todayFor()` 一度把用户对象当名字查（`String(obj)` → `[object Object]`）→ "今日累计"恒为 0；已修并有回归测试。
16. 反馈不能等慢操作：翻译曾在落库之前 → 弹窗长时间停在"处理中…"。现在先落库+写回执，再补翻译。

## 9. 路线

- **P1（已完成）** 剪贴板 + 点选弹窗录入、对话录入、翻译落库、查询统计、撤销/改库
- **P2** 记忆卡输出：选范围 → LLM 生成拆词 + 荒诞梗 → HTML / PDF（Edge headless）/ Word（pandoc），沿用 workbuddy 专家包的卡片版式与「拆解三法」
- **P3** 考试闭环：英译汉单选（干扰项优先取同库词义）→ 在线答题 → 判分回写 → 连续 3 次答对打「已学会」、答错清零、已学会词 10% 抽样复查
- **P4** 拍照通道：颜色掩码定位标记（荧光笔色块 + 红色下划线）→ 连通域聚类 → 裁剪 → 视觉模型只读印刷体 → 批量入库；判不清一律丢弃
- **P5** 词库管理界面（浏览 / 改释义 / 删词 / 手动改标签）+ 统计（高频榜 / 最近新增 / 久未复习）

## 10. 版本与回滚

本仓库（https://github.com/wangzhanchao883/dsh-word-vault）是插件的独立源码仓库，存在的意义就是**改炸了能回到已知可用状态**。

- **已打标签**：`v0.1.0-p1` = P1 交付时点（38 项 node 测试 + 17 项助手交互断言 + 14 项视觉/拖动断言全绿）
- **整仓回滚到该标签**（会丢弃未提交改动，先确认或先 stash）：
  ```powershell
  cd D:\workout\deepseekharness\dsh-plugin\dsh-word-vault
  git stash push -m "wip before rollback"     # 或先自己 commit
  git fetch --tags
  git reset --hard v0.1.0-p1
  ```
- **只回滚某个文件**：`git checkout v0.1.0-p1 -- scripts/capture.ps1`
- **看"炸了之后到底改了什么"**：`git diff v0.1.0-p1 --stat`，再 `git diff v0.1.0-p1 -- <文件>`
- **回滚不会碰你的单词库**：数据库与运行时文件都在 `D:\workout\AI助理\英语趣味单词\单词库\`，不在本仓库内 —— 回滚代码永远不会影响已录入的词。
- **建议节奏**：每完成一个可交付阶段（P2/P3/P4/P5）打一个标签，命名沿用 `v0.x.0-pN`。

> 回滚后要生效记得**重启 DSH**（宿主侧代码在启动时加载）。
