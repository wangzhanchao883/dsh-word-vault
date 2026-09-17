# dsh-word-vault · 英语生词库

多用户英语生词库 DSH 插件：**复制 → 鼠标处弹窗点选 → 入库并反馈**，LLM 自动翻译，SQLite 计次，按时间 / 频次 / 掌握度查询，并输出**可打印的趣味单词记忆卡**（HTML / PDF / Word），后续接考试闭环。

---

## 界面预览 / Screenshots

| 词库总览 / Library | 记忆卡（每块带 IPA）/ Cards |
| --- | --- |
| ![library](https://raw.githubusercontent.com/wangzhanchao883/dsh-word-vault/main/assets/screenshots/01-library.png) | ![cards](https://raw.githubusercontent.com/wangzhanchao883/dsh-word-vault/main/assets/screenshots/02-cards.png) |
| **在线答题 / Quiz** | **原生设置面板 / Settings** |
| ![exam](https://raw.githubusercontent.com/wangzhanchao883/dsh-word-vault/main/assets/screenshots/03-exam.png) | ![settings](https://raw.githubusercontent.com/wangzhanchao883/dsh-word-vault/main/assets/screenshots/04-settings.png) |

> 四张图分别对应：词库总览、记忆卡（每块上排真实音标 / 下排中文谐音 + 规律小字）、
> 在线答题（四选项、连对 3 次标记已学会）、DSH 原生设置面板。
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
| `wordvault_scan_photo` | 扫照片找被标记的印刷词(输出联络图) |
| `wordvault_photo_status` | 照片通道进度 |

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

## 6. 照片通道（P4）

把作业/课本照片上**被标记的印刷词**录进词库。

### 认哪些标记（按用户口径）

- **各色荧光笔**（绿 / 黄 / 粉 / 蓝…）
- **红笔的红线 / 勾 / 圈**
- **不认**：铅笔与黑色手写、红笔手写批注。饱和度天然把铅笔排除（不饱和不进掩码），红笔手写由模型判读那一步跳过。

### 两步分工：CV 管召回，模型管精度

**① 确定性 CV（插件侧 `scripts/photo-scan.ps1`，内联 C# 逐像素）**
掩码 → 连通域 + 形状判据 → 同行合并 → 上扩 30px 裁剪 → **输出一张联络图**。

| 判据 | 取值 | 为什么 |
|---|---|---|
| 荧光笔 | `w≥24`，`6≤h≤60` | 是盖住词的条带，不是插图 |
| 红线/勾/圈 | `w≥30, h≤14, w/h≥3` | **必须用绝对尺寸**：改用"相对自身宽度的长游程"时，汉字的一横就能占满自身宽度 60%，实测产生 **66 个假阳性** |
| 红圈 | `fill≤0.3` 且框内**印刷黑字 ≥60px** | 红圈里一定包着印刷字；红笔汉字框内只有自己的笔画 |
| 合并 | 竖向重叠且**合并后高度 ≤72px** | 不加高度上限会链式吞并，实测出现 354×270 的巨框 |
| 裁剪有效性 | 框内印刷黑字**横向铺开 ≥45% 的列** | 剔除空白边距与插图 |

性能：1279×1704 约 **2 秒/张**（逐像素别用 PowerShell 的 `GetPixel`，跨托管边界会慢到不可用）。

**② 模型读联络图判读**：只取被标记的**印刷体**词/短语，跳过手写与插图 → 调 `wordvault_add` 入库。
**每张照片一次调用** ⇒ 一张照片就是一条可整张撤销的记录。

### 两条入口（都支持）

- **对话里发照片**：我现场跑扫描器、读联络图、入库
- **`photoDir` 目录扫描**：`wordvault_scan_photo` 扫目录里未处理的新照片（按内容 hash 去重），目录与判据参数都在**插件设置页**可改

### 工具

| 工具 | 用途 |
|---|---|
| `wordvault_scan_photo` | 扫单张/目录 → 返回联络图路径与候选区域数；已扫过的自动跳过（`force` 重扫） |
| `wordvault_photo_status` | 照片通道进度：共多少张、已扫 / 已入库多少、联络图在哪 |

### 实测（2026-09-16 真实作业照片）

| 照片 | 标记 | 候选区域 | 识别入库 |
|---|---|---|---|
| p1 | 绿荧光笔（覆盖阅读段落） | 38 | 22 词：farm / kinds / animals / cakes / pick / vegetables / fruit / fishing / river / enjoy / restaurant / give / swim / pay / adult / child / Sunday / afternoons / apple / potato / plants / birds / picture / welcome |
| p2 | 红笔（批改 + 红线） | 30 | 23 词：standing / right / answer / games / circle / sit / different / kinds / between / village / working / place / country / farmers / dinner / city / sheep / hill / beautiful / air / holidays / children / other / parents / interesting / stories |

**隐私**：真实照片与裁剪产物都落在 `英语趣味单词\拍照测试|拍照处理\`，**不进仓库**；仓库里的 `docs/sample-photo-scan.png` 是合成图（`test/fixture.mjs` 生成）跑的样张。

### 落库与回滚

不新建表：走既有 `events(capture_id, context)` / `captures`。因为每张照片一次 `wordvault_add`，`wordvault_fix_last({action:'undo'})` 可**整张撤销**。

## 7. 词库界面（P5.1）

在 **DSH 自己的 Web 服务器上**挂一个只读总览页：`http://127.0.0.1:3080/word-vault`（端口随 DSH 的配置走）。

**载体选择依据**（官方文档 `docs/subsystems/web-server.md`）：`ctx.webServer.register({kind:'prefix', path, handler})` 允许插件注册同源路由，因此**不需要客户端半边**——官方 cookbook 明确说客户端 bundle 必须自己复刻 loader 的 lazy-CJS 工厂产物（官方未发布该预设），成本与风险都高。同源 fetch 自带浏览器会话 cookie，鉴权沿用 DSH 既有机制。没有 `webServer` 服务时（如 headless profile）走 progressive injection **静默跳过**，插件照常工作。

### 页面上有什么（P5.1 只读）

| 区块 | 内容 |
|---|---|
| 统计卡 | 总词数 / 已记住 / 没记住 / 高频词（标记 ≥ `highFreqMin` 次）/ **高频易错** / 已有记忆卡 |
| 四组视图 | **全部**、**已记住**（`mastered`）、**没记住**（未打已记住）、**高频易错**（标记 ≥ 阈值 **且** 未记住） |
| 搜索 | 单词 / 词性 / 中文释义，大小写不敏感，输入即筛 |
| 排序 | 标记次数↓（默认）、最近录入、最早录入、字母序 |
| 表格列 | 单词（红角标「标记 N 次」+ 状态 pill）、音标、词性·释义、标记次数、状态、连对 streak、考错次数、最近出现、首见、**来源**（渠道 via + 原文片段） |

**「高频易错词」口径**（用户 2026-09-16 定）：`seen_count >= highFreqMin` **且** `status != mastered` —— 反复被标记但还没学会的，就是最该优先考的。考错次数与连对数单独列出来给人看，代码不替用户加权。

**来源列**的用途：`events` 没有独立 source 列，所以展示「最近一次录入的 via + context 片段」。若看到 `entities`、`monorepo`、`--flag` 这类片段，说明当时复制的不是课本内容（终端输出被当生词录进来了）—— P5.2 会提供勾选批量删除。

### 路由

| 路由 | 用途 |
|---|---|
| `GET /word-vault` | 总览页（自包含 HTML/CSS/JS，无外部资源） |
| `GET /word-vault/api/library?group=&q=&sort=&limit=&user=` | 页面数据（JSON：统计 + 分组计数 + 行） |

非 GET/HEAD → 405；未知子路径 → 404；未知用户 → 404。

### P5.2 写操作与动作按钮（已完成）

| 操作 | 接口 | 说明 |
|---|---|---|
| 改释义 | `POST /api/word/update` | 点表格里的释义就地编辑（释义/词性/音标），写 `dict`（全局词典缓存，`source` 置为 `manual`） |
| 手动掌握度 | `POST /api/word/mastery` | 「标已记住 / 标回没记住」，与考试判分同一套字段（`status` + `streak`） |
| 删除预览 | `POST /api/words/delete-preview` | 先列出**会连带清掉什么**（录入记录 / 记忆卡 / 考试题 / 作答条数） |
| 删除 | `POST /api/words/delete` | 勾选 → 弹窗确认（列出单词与影响）→ 执行；返回逐词清理回执 |
| 出记忆卡 | `POST /api/actions/cards` | 按当前筛选（分组/搜索/排序）→ 缺卡片的先调模型补生成 → HTML/PDF/Word + 预览图 |
| **在线答题** | `POST /api/actions/exam` `mode=answer` | 只出题 + 起本地答题页（**不产 PDF**），页面给一个大按钮直接开做；逐题判分、连对 3 次打「已学会」、成绩归档入库 |
| **打印试卷 PDF** | `POST /api/actions/exam` `mode=paper` | 只出打印用 PDF（题目页 + 答案页，**不起答题服务**），页面给「打开试卷 PDF / 打开参考答案」两个按钮 |
| 打开文件 | `GET /file?p=<绝对路径>` | 把生成的文件**从页面直接打开**（PDF 内嵌打开、图片预览、HTML 直接看）——用户不用再去路径里翻；只允许输出目录内的文件，越界/穿越一律 403 |
| 打开目录 | `POST /api/open` | 用系统默认程序打开文件或其所在目录（同样限定在输出目录内） |

**删除必须连带清理（实测坑）**：库开着 `PRAGMA foreign_keys = ON`，而旧的 `deleteWord` 只删 `events + words` —— 于是**任何有记忆卡或考过试的词都删不掉**（SQLite 直接抛 `FOREIGN KEY constraint failed`）。现在按外键依赖顺序清：`exam_answers → exam_questions → cards → events → words`，并有专门的回归测试守着。

**安全**：写操作一律 `POST` + `Content-Type: application/json`（挡掉简单表单式跨站提交，缺类型回 415）；非 GET/POST 回 405；删除**必先预览影响再确认**；`/file` 与 `/api/open` 都做目录白名单（防路径穿越）。

**交付形态（用户反馈后改的）**：早先点一次「出试卷」会一次抛出 5 个文件路径（paperHtml/keyHtml/paperPdf/keyPdf/preview），要用户自己去翻——现在拆成两个语义明确的按钮（**在线答题** / **打印试卷 PDF**），结果区只给**可点的主入口**（答题页链接、PDF 链接），其余格式收进「其它格式」折叠区。

**页面筛选 → 查询范围**（`resolveScope`，纯函数、有单测）：`hot` = `status=learning` + `minCount=highFreqMin`；搜索词按「指定词」处理（出题侧用 `scope.includeWords`）；数量上限 200。

### P5.3 使用说明页 + 设置表单（已完成）

| 页面 | 路由 | 内容 |
|---|---|---|
| 词库 | `GET /word-vault` | 总览 + 写操作 + 动作（P5.1 / P5.2） |
| **使用说明** | `GET /word-vault/help` | 四种录入方式、三个视图口径、三个动作按钮、掌握度规则、写操作与安全、常见问题 |
| **设置** | `GET /word-vault/settings` | 18 个设置项按五组（复习口径 / 录入 / 记忆卡 / 考试 / 照片）成表单，每项带说明与配置键；「保存本组」只提交改动过的字段 |

三个页面共用导航条，互相可达。

**设置是真写**（不是摆设）：宿主侧用 `ctx.settings.update(ns, patch)` 把改动合并进该命名空间的**用户分节**（官方 `subsystems/settings.md` 的 owner scope 写入路径），因此：

- 与 DSH 原生设置页（插件配置 · dsh-word-vault）读写**同一份**配置，不存在两套真相
- 写入会触发本插件已有的 `scope.watch(...)` → `liveConfig` 热更新 → 需要时自动重启常驻助手（实测：改 `highFreqMin` + `photoPadUp` 后助手自动重启）
- 页面只允许提交 `SETTINGS_SPEC` 里列出的键（防手滑写坏未知字段：未知键回 400）
- `settings` 服务不可用时（如 headless 场景）页面读写回 501 + 可读说明，而不是静默失败

**路径类字段**：设置页底部给「📁 打开输出目录 / 📁 打开照片目录」两个按钮，直接调系统默认程序打开，省得手打路径。

### P5.4 原生设置页面板（客户端半边，已完成）

用户要求「设置也参考其他插件，弄个界面出来，类似截图这种」——即 **DSH 原生设置页 · 插件配置分区**里的自定义面板。参照本机可用的 `dsh-study-notebook/client.js` 实现，照它的模式手写一个客户端半边（**无构建步骤、无 JSX**）：

| 要点 | 做法 |
|---|---|
| 产物形态 | 经典脚本注册到 `window.__ModuleLoader__.load({ id, factory })`，工厂内 `require("react")`，一律 `React.createElement` |
| 注册槽位 | `ctx.slots.inject("settings.section", …)` + `slots.register({ name:"settings.section", id:"word-vault", order:300, label:()=>t("nav"), locale, inject })`——`label()` 就是左侧入口文字 |
| 读写设置 | `ctx.settingsScope.bind({ namespace: "dsh-word-vault" })` → `getSnapshot()` / `set(field, value)` / `subscribe()`。**`set` 只支持单段路径**，这正是两个插件 host 侧 schema 都用扁平结构的原因；分组只是客户端的展示结构 |
| 主题 | 配色全部用 DSH 主题变量（`--dsw-alias-label-primary` / `--dsw-alias-border-l2` / `--dsw-alias-bg-layer-1|2` / `--dsw-alias-label-tertiary` / `--dsw-alias-state-business-primary`），跟随明暗主题；括号里给降级色便于离线预览 |
| 生命周期 | 样式与词典都通过 `ctx.effect(…, "dsh-word-vault: styles|dictionaries")` 注册，插件卸载自动摘除 |
| 保存语义 | 文本/数字本地草稿，失焦或回车提交；开关立即提交；右上角短暂提示「已保存 / 保存失败」 |
| 打包声明 | `package.json` 里 `exports["./client"] = "./client.js"` + `dsh.client = { platform:"web", inject:[dsh-client-locale, dsh-client-runtime, dsh-client-ui-settings] }`（与参照插件逐字一致） |

面板分组：**通用**（启用插件 / 词库数据库 / 产物输出目录）、**录入**（不点选入库 / 常驻小条 / 自动翻译 / 词组 / 弹窗超时 / 单次上限）、**复习口径**（高频门槛）、**记忆卡**（标题 / 副标题 / 批大小）、**考试**（题量 / 抽查比例 / 空闲关闭）、**照片**（照片目录 / 裁剪输出 / 保留裁剪 / 饱和度 / 上扩像素 / 每次限流）；底部两个快捷入口跳到 `/word-vault` 与 `/word-vault/help`。

**两套界面，一份配置**：原生面板与宿主页 `/word-vault/settings` 读写同一份 settings 命名空间（`SETTINGS_SPEC` 与客户端面板字段**必须一致**，有测试守着——这条守卫第一次运行就抓出了 `cardsSubtitle` 漏登记）。

### 后续（未做）

- **P5.2（已完成）** 写操作与动作按钮：改释义、手动掌握度、删词（含连带清理 + 影响预览 + 弹窗确认）、按当前筛选出记忆卡/出试卷/开始答题
- **P5.3（已完成）** 使用说明页（`/help`，四种录入方式 / 视图口径 / 动作说明 / 常见问题）+ 设置表单（`/settings`，18 项五组，走宿主 settings 服务真读真写、触发助手热重启）
- **P5.4**（可选）官方客户端半边（设置卡片），作后续增强

## 8. 数据模型（node:sqlite）

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
- **高频**：`seen_count >= highFreqMin`（默认 2）即视为高频。`wordvault_query({ highFreq: true })` 只取高频词；`wordvault_status` 给出高频榜；记忆卡/Word 版在卡面右上角印「标记 N 次」红色角标（低频词不印，避免噪音）。考试想专挑「高频且不会」，用 `minCount` + `status: 'learning'` + `orderBy: 'count'` 组合即可。
- **今日累计**：`todayCount()` 取 `substr(created_at,1,10)` 与本地日期比较（不用 SQLite `date()`,它会按 UTC 归一,跨零点算错一天）。
- **撤销**：删掉该次 `capture_id` 的 events，受影响词条按剩余 events 重算；不再有任何 event 的词条整条删除（即"这次新建的"）。
- **可重建性**：`words` 是 `events` 的投影，`rebuildCounters()` 可全量重算。

## 9. 配置（settings 命名空间 `dsh-word-vault`）

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
| **`highFreqMin`** | **2** | 高频词门槛：累计被标记（录入）达到这个次数就算高频，查询/出片据此标记与筛选 |
| `cardsTitle` / `cardsSubtitle` | 趣味单词记忆卡 / （空=自动） | 记忆卡页眉文案 |
| `cardsBatchSize` | 8 | 记忆卡内容每次交给模型几个词 |
| **`examCount`** | **10** | 默认出多少题 |
| **`examRecheckRatio`** | **0.1** | 已学会词混入复查的比例（答错自动摘牌） |
| **`examMinutes`** | **30** | 答题页空闲多久自动关闭（分钟） |
| `examBatchSize` | 6 | 出题时每次交给模型几个词 |
| **`photoDir`** | 英语趣味单词\拍照 | 照片目录（可直接往里丢照片，也可以在对话里发图） |
| `photoOutDir` | 英语趣味单词\拍照处理 | 裁剪块与联络图落盘目录 |
| `photoRecursive` | true | 是否递归扫子目录 |
| `photoKeepCrops` | true | 是否保留逐块裁剪 PNG（联络图总是保留） |
| `photoSatMin` | 40 | 算作「标记墨迹」的最低饱和度（荧光笔/红笔饱和，铅笔不饱和） |
| `photoPadUp` | 30 | 裁剪上扩像素（红线在词下方，必须把词带进来） |
| `photoMaxCropH` | 160 | 单个裁剪块的最大高度 |
| `photoMinDarkSpread` | 0.45 | 裁剪块内印刷黑字至少铺开多少比例的列（剔空白边距/插图） |
| `photoMaxPerRun` | 8 | 每次最多处理几张新照片 |

## 10. 安装与重载

```powershell
dsh plugin --profile web add D:/workout/deepseekharness/dsh-plugin/dsh-word-vault
# 注意:dsh plugin add 只往 dependencies 加 link 行,还需把 "dsh-word-vault" 手工加进
#      package.json 的 dsh.profile.bundles,否则 --dump-config 里看不到它

dsh --profile web --dump-config      # 应出现 "# == dsh-word-vault" 且无 FAILED
```

- 宿主侧改动（`index.mjs` / `capture.mjs` / 工具 / 设置项）：**必须重启 DSH**。
- 助手脚本改动（`scripts/capture.ps1`）：重启 DSH 会重新拉起助手即可生效。
- 依赖：`@deepseek-ai/dsh-tools` 与 `dsh-llm` 声明为 **peerDependencies**（宿主共享包，避免插件市场"遮蔽宿主版本"告警），本机同时在 `devDependencies` 里保留，供 `npm install` 装进插件自己的 `node_modules`（link 安装不会替插件装依赖）。

## 11. 测试

```powershell
cd D:\workout\deepseekharness\dsh-plugin\dsh-word-vault
node --test test/words.test.mjs test/db.test.mjs test/capture.test.mjs test/index.test.mjs test/cards.test.mjs test/exam.test.mjs test/photos.test.mjs test/translate.test.mjs test/web.test.mjs test/client.test.mjs
# 126 项:切词/词形还原、库 CRUD/撤销/改库/今日计数、宿主编排(点选/忽略/超时/autoCommit/翻译缓存)、
#        插件契约与工具链路(含 P2 的 make_cards/export_cards)、记忆卡版式与转义、
#        拆解质量闸门(逐字母硬拆判定/重试/保留标记)、真实 Edge 出 PDF+预览图、pandoc 出 Word、
#        P3 考试(答案位置配额/撞义去重/原文句优先/掌握度升降/真 HTTP 答题服务/试卷导出)、
#        P4 照片扫描(合成图判据回归 + 真照片回归 + 按内容 hash 去重/限流/裁剪开关)、
#        翻译分批与重试(整批失败不丢词)、高频词计次与高亮角标、P5 词库页面(分组计数/搜索排序/写操作/动作/页面脚本语法自检/HTTP 端到端)、
#        使用说明页与设置表单(P5.3)、客户端设置面板(P5.4:内核契约/字段一致性守卫/主题变量)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File test/helper-clipboard.ps1
# 17 项断言:剪贴板入队、弹窗出现、真实点击「用户1」→ commit、成功反馈+今日累计+自动消失、
#             超时→dismiss、点忽略→dismiss、超长/无字母过滤、图片只入队一次

powershell.exe -NoProfile -ExecutionPolicy Bypass -File test/helper-visual.ps1
# 14 项断言:助手在 capture-status.json 上报 chip/dialog 真实矩形 → 按该矩形截图并做像素断言
#            (小条 白底/淡黄条/淡蓝边框/黑字;弹窗 淡蓝标题条/白底/淡蓝按钮/淡蓝边框),
#            再模拟一次拖动断言"位移=鼠标位移"且位置已持久化。截图落在临时目录供人眼复核。
```

助手端到端测试**不需要人工操作**：它用 `EnumChildWindows` 找到弹窗里的按钮句柄，`SendMessage(BM_CLICK)` 真点一下，再断言命令文件；视觉测试用 `CopyFromScreen` 截图后逐像素比对颜色。

## 12. 实测踩坑

> **翻译整批失败会让词「只剩词形」（2026-09-16 实测）**：照片整批录入时有两批共 51 个词全部没有释义（`ctx.llm` 调用异常被静默吞掉），连带卡都出不了。修法：`translateWords` **分批（默认 12/次）+ 未返回的词重试一轮 + 日志报出未成功的词**；事后用补翻译脚本一次性把 46 个词补齐（词典 45 → 91）。
（都已在代码/测试里处理，改代码前务必看）

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

## 13. 路线

- **P1（已完成）** 剪贴板 + 点选弹窗录入、对话录入、翻译落库、查询统计、撤销/改库
- **P2（已完成）** 记忆卡输出：选范围 → LLM 生成拆词 + 荒诞梗 → HTML / PDF（Edge headless）/ Word（pandoc）+ 首页预览图；沿用 workbuddy 专家包的卡片版式与「拆解三法」
- **P3（已完成）** 考试闭环：英译汉单选（含该词的句子 + 单独问该词；干扰项同库同词性优先）→ 本地网页答题即时判分 → 连续 3 次答对打「已学会」、答错摘牌、已学会词 10% 抽样复查 → 可打印试卷
- **P4（已完成）** 拍照通道：饱和色掩码 + 形状判据定位「被标记的印刷词」→ 联络图 → 模型只读印刷体入库（真实作业照片实测 p1 22 词 / p2 23 词）
- **P5.1 / P5.2 / P5.3（已完成）** 词库界面：总览（四组视图 + 搜索排序 + 来源列）、写操作（改释义 / 手动掌握度 / 删除带影响预览）、动作（出记忆卡 / 在线答题 / 打印试卷 PDF）、使用说明页与设置表单；三个页面共用导航
- **P5.3（已完成）** 使用说明页 + 设置表单（三个页面共用导航，设置与 DSH 原生设置页同一份配置）

## 14. 版本与回滚

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
