# dsh-word-vault · 英语生词库

多用户英语生词库 DSH 插件：**复制 → 鼠标处弹窗点选 → 入库并反馈**，LLM 自动翻译，SQLite 计次，按时间 / 频次 / 掌握度查询，并输出**可打印的趣味单词记忆卡**（HTML / PDF / Word），后续接考试闭环。

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
| `wordvault_fix_last` | 撤销最近一次录入 / 改到另一个用户库 |`r`n| `wordvault_make_cards` | 生成记忆卡内容(拆词 + 荒诞梗),可只重做指定词 |`r`n| `wordvault_export_cards` | 出记忆卡 HTML / PDF / Word + 首页预览 |`r`n| `wordvault_exam_start` | 按范围出题 + 起本地答题页(可顺带出打印卷) |`r`n| `wordvault_exam_answer` | 手工录分(批改打印卷/对话答题) |`r`n| `wordvault_exam_result` | 考试结算与错题清单 |`r`n| `wordvault_exam_paper` | 导出可打印试卷 + 参考答案 |

## 4. 记忆卡输出（P2）

把选定范围的生词导成**可打印的趣味单词记忆卡**：拆词 + 一句荒诞梗钉住拼写。版式与「拆解三法 / 梗四判据」全部照搬 workbuddy 专家包 `funny-word-cards`（本插件自包含，不依赖那个专家目录）。

### 流程

```
选范围(时间/频次/掌握度/指定词) → 缺卡片的用 LLM 生成拆词+梗 → 落 cards 表 → 出片
   ├─ HTML  卡片版(A4 分页,可直接浏览器打印)
   ├─ PDF   Edge headless 打印成 A4 PDF
   ├─ Word  pandoc 转 .docx(表格版,便于再编辑)
   └─ PNG   首页预览图(排版自检用:确认第 4 行勾选框没被切掉)
```

工具：`wordvault_make_cards`（只生成内容）、`wordvault_export_cards`（出片，缺卡的默认先自动生成）。

### 卡片规格（与专家包一致）

- A4 竖版，**每页 8 张（2 列 × 4 行）**，单面打印
- 每张卡四层：**词头**（序号圆标 + 大字单词 + 音标/词性/释义）→ **拆解块**（字母片段 ↔ 中文音，上下对齐）→ **荒诞句**（橙色左边框一句话）→ **默写区 + 「已攻下」勾选框**
- 单词 ≥11 字母自动缩小字号；不足 8 张时空位印成虚线框「空位 · 错词重写区」，不留白纸
- ⚠️ **每页张数与 CSS 是联动的**（8 张/页时每卡约 65mm 高，字号间距是一整套），所以 `PER_PAGE` 固定在代码里不开放配置；要改必须同步改 `cards.mjs` 的 `CARD_CSS`

### 内容质量闸门（代码侧硬校验，不信模型自述）

| 级别 | 判定 | 处理 |
|---|---|---|
| 硬失败 | 拆解块顺序拼接 ≠ 原词 / 缺拆解 / 缺梗句 | 带着具体原因**重试一次**；仍不合格才记为失败 |
| 质量告警 | 逐字母硬拆（单字母块占比 ≥50% 且 ≥3 块）、拆解块 >4、中文音 >2 字 | 同样重试一次；仍不合格**保留卡片但标 `low`**，并在返回值里列进 `lowQuality` |
| 自动修正 | 音标不合 `/.../` 格式 → 清空（宁缺勿造）；梗句 >60 字 → 截断 | 直接改 |

**实测教训**：第一版提示词只说"短词不要硬凑谐音"，模型给出 `map → m摸/a啊/p铺`、`health → h喝/e鹅/a啊/l乐/t踢/h好`（逐字母硬拆，正是专家包警告的污染发音失败模式）。改成**按读音音节切块 + 明确给出正例/反例**后，同样 13 个词变成 `to特/ma马/to头`、`heal嘿欧/th思`、`pho佛/to头`，质量待改从 8 个降到 **0**。

### 重做与润色（双路）

- 插件侧：`wordvault_make_cards({ words: "tomato,health", regenerate: true })` 只重做指定的词（已落库卡片会被覆盖）
- 对话侧：直接让我按专家包方法论重写某几个词的拆解/梗，再调 `wordvault_export_cards` 出片
- 卡片内容落 `cards` 表，所以**出片可复现、重出不再烧 token**（除非显式 regenerate）

### 落库

`cards(user_id, word_id, term, phonetic, pos, meaning, segs(JSON), story, model, source, created_at, updated_at)`，`UNIQUE(user_id, word_id)`。`wordvault_query` / `wordvault_status` 会带出卡片状态（`cardStats`: total / withCard / withoutCard / stale）。

## 5. 考试闭环（P3）

英译汉单选题 + 即时判分 + 掌握度自动维护。

### 题干形式（按用户要求）

题干是**包含该词的英文句子**，再单独问这个词在句中的意思：

```
Nice to meet you, Jenny.   句中的 meet 是什么意思？
A. 遇见     B. 错过     C. 送别     D. 邀请
```

句子来源：**优先用你录词时复制下来的那句原文**（存在 `events.context`），没有原文才让模型写一句（≤12 词、校园/家庭/食堂场景）。所以孩子们考到的正是他们真实读到过的句子。

### 三条硬规则（代码侧都校验）

1. **答案位置错开**：按位置配额分配（20 题 → A/B/C/D 各 5 次），并打散"连续 3 题同一位置"。答案存库，**答题页拿不到答案**，判分只在服务端做。
2. **干扰项要有迷惑性**：同词性 + 同语义场；**优先从你自己库里同词性的其他词义取（最多 2 个）**——那正是孩子正在背的词，天然像"对的"；不足由模型补齐，库内还不够再用其它词义兜底。
3. **选项唯一性**：不能与正确答案撞义（含"马铃薯;土豆" vs "土豆"这种多义项/子串情况），干扰项之间也不能重复；展示层每个选项最多留 2 个义项（避免正确答案比干扰项长一截被一眼认出）。

### 答题（本地网页）

`wordvault_exam_start` 出题后，插件在 **127.0.0.1 上起一个临时服务**并给出带随机 token 的链接：

- 浏览器打开 → 逐题作答 → **点选即判分**，立刻显示对错、正确答案、以及"连续答对 N/3"
- 连对 3 次当场提示 🎉已学会；答错且原本已学会 → 提示"已摘牌，需要重新连对 3 次"
- 交卷出成绩页（对了几题、正确率、错题清单）
- 服务只监听本机、URL 带随机 token、空闲超时（默认 30 分钟）自动关闭；插件卸载时一并关闭

### 掌握度口径（唯一实现于 `answerExamQuestion`）

| 情况 | 处理 |
|---|---|
| 答对 | `streak + 1`；`streak >= 3` → 打「已学会」（记 `mastered_at`） |
| 答错 | `streak = 0`；若原本已学会 → **摘牌**回 learning，`wrong_count + 1` |
| 已学会词 | 默认按 `recheckRatio`（10%）混入后续考试做复查；也可用 `status=mastered` 出专项复查卷 |

### 工具

| 工具 | 用途 |
|---|---|
| `wordvault_exam_start` | 按范围出题 + 起答题页（可选顺带导出打印卷），返回链接、答案位置分布、候选池 |
| `wordvault_exam_answer` | 手工录分（批改打印卷／对话里答题），choice 传 `A/B/C/D` 或 0-3 |
| `wordvault_exam_result` | 结算：对了几题、错题清单（你选了什么/正确是什么）、答案位置分布 |
| `wordvault_exam_paper` | 导出可打印试卷 + 参考答案（拆成两个文件：试卷给人做，答案自己留） |

### 出题前自动补翻译

英译汉必须有释义：范围内缺释义的词会**先自动补翻译**（走词典缓存，只翻缺的），不需要手动处理。

### 真机首测发现的三个问题（都已在 P3 修掉）

第一次用**真实词库**出题只成 4/10 道 —— 这类问题单元测试想不到，只有真机跑才露出来：

| 现象 | 真实原因 | 修法 |
|---|---|---|
| 10 个词判"缺少包含该词的句子" | 录词时的 `context` 可能是**中文备注**（没有英文句），于是要模型现写；而模型爱用**派生词**（`health`→`healthy`、`kind`→`kindness`），旧校验只认原词与 -s/-ed/-ing | **补句子重试**：窄指令再问一次，提示词里写明"不许用派生词"并给正/反例 → 当次 10/10 成题 |
| `entity` 的题干就是 `entities` 一个词 | 复制终端内容时录进来的**裸词**被当成了句子 | 句子质量门槛 `looksLikeSentence`（≥3 个英文词、≥8 字符）才算题干 |
| 终端垃圾词（`entity`/`structure`/`geometry`/`monorepo`）混进考卷 | 录入通道不区分"生词"和"复制到的任意英文片段" | `scope.excludeWords` 可点名排除；出题/出片前建议先清库（P5 词库管理界面会做批量清理） |

### 落库

- `exam_sessions(user_id, scope, size, correct, created_at, finished_at, status, token)`
- `exam_questions(session_id, seq, word_id, prompt_word, sentence, sentence_src, correct_meaning, options(JSON), answer_index, chosen_index, is_correct, is_recheck, answered_at)`
- `exam_answers(...)`：每题的不可变答题流水，便于日后分析

## 6. 数据模型（node:sqlite）

```
users(id,name,enabled,created_at)
dict(term PK,phonetic,pos,meaning,source,created_at,updated_at)   -- 全局词典缓存,一个词只翻一次
words(id,user_id,kind,term,lemma,first_seen_at,last_seen_at,seen_count,status,streak,wrong_count,last_exam_at,mastered_at)
      UNIQUE(user_id,kind,lemma)                                  -- kind=word 单词 / kind=phrase 词组
events(id,user_id,word_id,kind,via,context,capture_id,created_at) -- 每次录入一条,统计与回滚的依据
captures(id PK,user_id,via,text,item_count,status,created_at,updated_at)
cards(id PK,user_id,word_id,term,phonetic,pos,meaning,segs,story,model,source,created_at,updated_at)`r`n      UNIQUE(user_id,word_id)                                     -- 记忆卡内容(segs 存 JSON),出片可复现`r`nexam_sessions / exam_answers                                      -- P3 考试闭环预留
```

- **计次口径**：同一批内按 `lemma` 去重（同一次录入里重复出现只算一次）；跨批次每录一次 `seen_count + 1`；`term` 保留最近一次原文形态，展示以 `lemma` 为准。
- **今日累计**：`todayCount()` 取 `substr(created_at,1,10)` 与本地日期比较（不用 SQLite `date()`,它会按 UTC 归一,跨零点算错一天）。
- **撤销**：删掉该次 `capture_id` 的 events，受影响词条按剩余 events 重算；不再有任何 event 的词条整条删除（即"这次新建的"）。
- **可重建性**：`words` 是 `events` 的投影，`rebuildCounters()` 可全量重算。

## 7. 配置（settings 命名空间 `dsh-word-vault`）

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
| `cardsTitle` / `cardsSubtitle` | 趣味单词记忆卡 / （空=自动） | 记忆卡页眉文案 |
| `cardsBatchSize` | 8 | 记忆卡内容每次交给模型几个词 |
| **`examCount`** | **10** | 默认出多少题 |
| **`examRecheckRatio`** | **0.1** | 已学会词混入复查的比例（答错自动摘牌） |
| **`examMinutes`** | **30** | 答题页空闲多久自动关闭（分钟） |
| `examBatchSize` | 6 | 出题时每次交给模型几个词 |

## 8. 安装与重载

```powershell
dsh plugin --profile web add D:/workout/deepseekharness/dsh-plugin/dsh-word-vault
# 注意:dsh plugin add 只往 dependencies 加 link 行,还需把 "dsh-word-vault" 手工加进
#      package.json 的 dsh.profile.bundles,否则 --dump-config 里看不到它

dsh --profile web --dump-config      # 应出现 "# == dsh-word-vault" 且无 FAILED
```

- 宿主侧改动（`index.mjs` / `capture.mjs` / 工具 / 设置项）：**必须重启 DSH**。
- 助手脚本改动（`scripts/capture.ps1`）：重启 DSH 会重新拉起助手即可生效。
- 依赖：`@deepseek-ai/dsh-tools` 与 `dsh-llm` 声明为 **peerDependencies**（宿主共享包，避免插件市场"遮蔽宿主版本"告警），本机同时在 `devDependencies` 里保留，供 `npm install` 装进插件自己的 `node_modules`（link 安装不会替插件装依赖）。

## 9. 测试

```powershell
cd D:\workout\deepseekharness\dsh-plugin\dsh-word-vault
node --test test/words.test.mjs test/db.test.mjs test/capture.test.mjs test/index.test.mjs test/cards.test.mjs test/exam.test.mjs
# 81 项:切词/词形还原、库 CRUD/撤销/改库/今日计数、宿主编排(点选/忽略/超时/autoCommit/翻译缓存)、`r`n#        插件契约与工具链路(含 P2 的 make_cards/export_cards)、记忆卡版式与转义、`r`n#        拆解质量闸门(逐字母硬拆判定/重试/保留标记)、真实 Edge 出 PDF+预览图、pandoc 出 Word、`r`n#        P3 考试(答案位置配额/撞义去重/原文句优先/掌握度升降/真 HTTP 答题服务/试卷导出)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File test/helper-clipboard.ps1
# 17 项断言:剪贴板入队、弹窗出现、真实点击「用户1」→ commit、成功反馈+今日累计+自动消失、
#             超时→dismiss、点忽略→dismiss、超长/无字母过滤、图片只入队一次

powershell.exe -NoProfile -ExecutionPolicy Bypass -File test/helper-visual.ps1
# 14 项断言:助手在 capture-status.json 上报 chip/dialog 真实矩形 → 按该矩形截图并做像素断言
#            (小条 白底/淡黄条/淡蓝边框/黑字;弹窗 淡蓝标题条/白底/淡蓝按钮/淡蓝边框),
#            再模拟一次拖动断言"位移=鼠标位移"且位置已持久化。截图落在临时目录供人眼复核。
```

助手端到端测试**不需要人工操作**：它用 `EnumChildWindows` 找到弹窗里的按钮句柄，`SendMessage(BM_CLICK)` 真点一下，再断言命令文件；视觉测试用 `CopyFromScreen` 截图后逐像素比对颜色。

## 10. 实测踩坑（都已在代码/测试里处理，改代码前务必看）

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

## 11. 路线

- **P1（已完成）** 剪贴板 + 点选弹窗录入、对话录入、翻译落库、查询统计、撤销/改库
- **P2（已完成）** 记忆卡输出：选范围 → LLM 生成拆词 + 荒诞梗 → HTML / PDF（Edge headless）/ Word（pandoc）+ 首页预览图；沿用 workbuddy 专家包的卡片版式与「拆解三法」
- **P3（已完成）** 考试闭环：英译汉单选（含该词的句子 + 单独问该词；干扰项同库同词性优先）→ 本地网页答题即时判分 → 连续 3 次答对打「已学会」、答错摘牌、已学会词 10% 抽样复查 → 可打印试卷
- **P4** 拍照通道：颜色掩码定位标记（荧光笔色块 + 红色下划线）→ 连通域聚类 → 裁剪 → 视觉模型只读印刷体 → 批量入库；判不清一律丢弃
- **P5** 词库管理界面（浏览 / 改释义 / 删词 / 手动改标签）+ 统计（高频榜 / 最近新增 / 久未复习）

## 12. 版本与回滚

本仓库（https://github.com/wangzhanchao883/dsh-word-vault）是插件的独立源码仓库，存在的意义就是**改炸了能回到已知可用状态**。

- **已打标签**：`v0.1.0-p1` = P1（38+17+14 全绿）；`v0.2.0-p2` = P2（57+17+14 全绿）；`v0.3.0-p3` = P3（81 项 node + 17 助手 + 14 视觉全绿，考试闭环可用）
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
