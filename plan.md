# 计划:结构优先蓝图(structure-first blueprint)——破坏性重构

> 替代原「守契约引入」计划。本文档是唯一实施依据:**每个决策已定案,无待定项**;
> 所有函数名 / 字段名 / 文件路径均来自对两仓源码的实读,不是推测。
> 来源成果:C:\Users\user\Desktop\code\test\research(wiki-gen 管道——设计 9 stage、现行驱动编号 stage 0–11,语言适配器契约
> 「stage 4–11 零改动」;附录 D(C/Swift)与附录 E(intellij-community 174,497 文件,10/10 门禁 +
> D7 双跑 46,625 产物逐字节一致)均已验证;research/plan.md 现为七仓库阶梯验收计划)。

---

## 0. 定案摘要(22 条,全部封闭)

| # | 决策 | 定案 |
|---|---|---|
| D1 | 管线形态 | 结构(代码)→ 分类命名(LLM)→ 页面命名(LLM)→ 页面生成。**标题精修阶段删除** |
| D2 | 阶段枚举 | `CatalogStage`/`RunStage` = `'structure' \| 'sections' \| 'pages'`;`condense` 角色删除 |
| D3 | 结构主权 | sections / pages / slug / 文件归属**全部由代码构造**;LLM 只填 title / description / scope / summary / group / level |
| D4 | 工具面 | `submit_sections`(schema v2,只收 id+语义字段)、`submit_pages`(新)、`write_page`(不动)。**数量反馈 / 缩编 / 归并回路整体删除** |
| D5 | 页面身份 | page 与切片运行期 1:1(machine id `slice:S<n>`);**跨次运行的身份 = slug(生成期定,sync 继承)** |
| D6 | section 身份 | 运行期 id `sec-<最小切片>`;**跨次运行身份 = title(sync 按页面多数票继承)** |
| D7 | 档位语义 | `blueprint.detail` 区间从「硬校验」改为「机器目标参数」(算 minSliceSize 与选层窗口);区间数值不变 |
| D8 | 失败策略 | 结构构建失败 = **致命报错**(不再回退纯 LLM 路径);命名阶段失败 = 非致命(用机器默认值) |
| D9 | 产物版本 | wiki.json 写 `schemaVersion: 2`。**旧产物不迁移**:sync 拒绝执行并提示重新 generate;verify 覆盖组 SKIP |
| D10 | 覆盖等式 | 文件级排他 + 行级台账(信息性):`\|M\| = Σ\|ownsFiles\| + \|excluded\|`,double-owned/unclaimed = 0 为 FAIL |
| D11 | 行台账来源 | parser 新增可选字段 `lineCount` / `ranges`(tree-sitter 节点 `startPosition/endPosition`,加法式,不改既有字段) |
| D12 | 图边 | 仅 `import`(权 2)/ `reexport`(权 3)两类,按 §5.1 规则解析;符号级引用边**不做**(非目标) |
| D13 | 切分 | 确定性层级 Louvain 移植(research `partition.js` 语义逐条保留:固定节点序、平局按社区号、EPS=1e-12、guard=32;research 默认 `maxLevels=8` 层上限,zread 放开至收敛——见 §5.3;附录 E 的数字复合键与循环 push 两处规模修复语义等价,随移植) |
| D14 | 两级切分 | 切片(细)→ 页面;切片商图再跑同一算法 → 分类(粗)。**一次算法产两级,归属是父子关系,零校验回路** |
| D15 | 全局槽位 | `slot:overview` + hub 槽位(贪心集合覆盖 research `plan.js`,阈值 3、上限 6)+ `slot:seams` 兜底;**全局槽位不拥有文件**(ownsFiles=[]) |
| D16 | minimal | 走结构但**跳过两个命名 Agent**:1 分类 1 页,单页 ownsFiles = 全量(等式平凡闭合) |
| D17 | sync | 纯机械对齐(重叠贪心匹配 + 身份继承);**只有新增页 / 新增分类才跑命名 Agent,且只允许命名新 id** |
| D18 | 旧日志回放 | 仅存的兼容面:run JSONL 里的旧 stage/role 字符串继续可展示(显示层 6 值联合 + 旧 i18n 键保留) |
| D19 | browse | 零改动(wiki.json 字段是超集);跑 `test:browse` 作守卫 |
| D20 | verify | 新增 `coverage` 检查组(V0~V3,见 §5.6);`verify-wiki.ts` 保持只读;CLI verify 渲染代码不改(只改头注释) |
| D21 | 降级 | 解析不出任何源码(symbols 为空)→ 报错终止,错误信息点名「无可解析源文件」;**没有静默回退** |
| D22 | 版本 | 1.22.1 → 1.23.0(次版本 +1;主版本是否升 2.0.0 由用户定,不阻塞本计划) |

---

## 1. 打破的契约清单(AGENTS §4 逐条处置)

| 既有冻结点 | 处置 |
|---|---|
| 工具名 `submit_sections` / `submit_section_topics` / `refine_section_titles` | **改**:`submit_sections` 留名换 schema;`submit_section_topics`、`refine_section_titles` **删除**,由 `submit_pages` 取代 |
| 归档工具 `generate_blueprint` / `generate_sync_blueprint` / `validate_blueprint` | **删除**(实测调用方只有 output-tools 自身与注释) |
| `CatalogEvent` 时序 / `stage` 联合 | 时序不变(requesting→responding→tool_start→tool_result→complete);`stage` 联合改为三值 |
| `BlueprintResult` 字段 | 形状不变;`failedSections[].stage` 收窄为 `'pages'` |
| `WikiOutput.sections?` | 保留推导回退;**新增** `schemaVersion` / `coverage` / `sections[].slices` / `pages[].ownsFiles` / `pages[].refs`,v2 产物内必填(类型上可选,靠 `schemaVersion` 运行期强制) |
| 「新增字段一律可选、旧产物可读」总则 | **废止**:旧 wiki.json 读取仍可(load / browse),但 sync 拒绝、verify 覆盖组 SKIP——不做迁移工具 |
| `WikiTopic` 类型 | **删除**(全仓调用方实测只在被重写的文件与测试里) |
| `judgeQuantity` / 数量反馈 / 缩编 / 代码兜底 | **整族删除**(D4) |
| 工具 schema「不引入 TypeBox」「原样传 pi」 | 不变 |
| `TokenUsage` 归并函数、`result.subtype`、`RetryConfig`、`createAgent/createProvider` 签名 | 不变 |
| `write_page` 名与 schema、内容门、mermaid 校验、`verifyAfterGenerate` 缺省 false、`RunMeta` | 不变 |

§4 更新在 P9:冻结点表改写为上表右列的终态;§3 表格同步(蓝图三阶段行、标题精修行删除、档位行改「目标参数」、交付闸门行加 coverage)。

---

## 2. 现状事实基线(实读,作为改造起点)

```
CLI 生成视图 controller(apps/cli/src/views/wiki-generate/controller.ts:246-275)
  scanFiles → saveCachedManifest → parseFiles → saveCachedSymbols
  → generateWikiCatalog(onEvent, {detail, runLog})
      阶段1 runClassifyStage   : renderClassifyPrompt + EXPLORE_TOOLS + submit_sections
                                 → initWikiSkeleton(sections 骨架)
      阶段2 runTopicsStage     : renderTopicsPrompt(带 scope) + submit_section_topics
                                 → mergeSectionTopics(slug 由 nextPageIndex/uniqueSlug 分配)
      阶段3 runTitlesStage     : prompts/titles + refine_section_titles → applySectionTitles
  → generateWikiContent: buildPagePrompt(associatedFiles) → write_page → content-gate → polish
sync-wiki.ts: scan/parse → diffManifests → (uncoveredAdded 时 runClassifyStage merge)
              → 按 pageMatchesAny 圈 affected → runTopicsStage(reuseExisting) → runTitlesStage
              → computeSyncDiff → writeWikiPages
事件/轨迹: CatalogStage='classify'|'topics'|'titles'(orchestrator types.ts);
           RunStage/RunEventAgentRole 同名(packages/types run-event.ts);
           CLI 显示层 wiki-generate/{types,mapper,index}.ts + i18n stage*/agent* 键
闸门: verify-wiki 五组 structure/content/mermaid/traceability/frontmatter,无覆盖检查
夹具与 mock 面: tools/mock-wiki-run.ts、packages/orchestrator/test/{e2e-blueprint,e2e-sync,blueprint-detail,titles-diagnostic}.ts、
           apps/cli/test/{mock-generate,cli-target-dir,browse-server}.ts、
           apps/cli/src/views/wiki-generate/__tests__/mapper.test.ts、
           packages/trajectory/test/{trajectory-model,session-replay}.ts
```

根因(为何拆不好):R1 无依赖图(R1 无从判断结构)、R2 切分全凭模型 + 数量回路只能管个数、R3 无归属事实源、R4 闸门不查覆盖。方案对症:结构层给图、算法给两级互斥划分、覆盖等式给证明、LLM 只命名。

---

## 3. 目标架构总图

```
scan/parse(controller 或 sync 内,现状不动)
   │ SymbolManifest(新增可选 lineCount/ranges)
   ▼
[structure] buildStructureCache ──► CEG(import/reexport 边)
   │                              ──► 确定性 Louvain → 切片(细级,含 barrel/orphan/折叠)
   │                              ──► 切片商图再 Louvain → 分类窗口选层 + 合并到底
   │                              ──► 槽位集合覆盖(overview/hub/seams) + 覆盖台账
   │                              ──► 落盘审计件 .zread-pi/cache/structure-<detail>.json
   ▼
initWikiBlueprint(机器骨架: sections+pages+coverage+schemaVersion=2)   ← 骨架先落盘,永不悬挂
   │
   ├─[sections] runSectionsNamingStage → submit_sections(只填语义字段;失败→机器默认)
   ├─[pages]    runPagesNamingStage(每分类一个 Agent)→ submit_pages(同上;失败→记 failedSections)
   ▼
generateWikiContent(buildPagePrompt 注入 owns/refs;write_page 及后续链零改动)
   ▼
verifyWiki: 既有五组 + coverage 组(V0~V3)
```

---

## 4. 六条调用链(函数级,逐步骤)

### 链 A:结构预计算(新增 `packages/orchestrator/src/wiki/structure.ts`)

```
ensureStructureContext(detail, variant):
 1. loadCachedManifest();缺失 → scanFiles() + saveCachedManifest()(自愈,覆盖直调 API 的测试)
 2. loadCachedSymbols();null/空 → parseFiles(manifest) + saveCachedSymbols(自愈)
    仍为空 → throw「目标仓库没有可解析的源文件,无法构建结构切分」(D8 致命)
 3. buildStructureCache(symbols, manifest, { detail })        [repo-analyzer/src/structure/, P1]
    内部: §5.1 图 → §5.2 切分 → §5.3 选层 → §5.4 槽位/覆盖
 4. 写审计件 .zread-pi/cache/structure-<detail>.json(含 manifestHash;每次运行重算重写,
    无缓存读路径——确定性由测试保证,产物供 diff 审计)
 5. 返回 { structure, manifestHash }
```

`generateWikiCatalog` 新链(orchestrator.ts):

```
runStructureStage(context):
   emit waiting/running/completed 三事件(agentKey='structure', agentRole='structure',
     agentKey='structure' 行事件;结构阶段无 pi 会话 → 不产生 agent_config,
     RunEventMeta 无 sessionId(与 run 级同规则))
   runLog.append(buildStageEvent({ stage:'structure' }))
   机器骨架 = buildMachineBlueprint(structure, spec, language)   [utils wiki-content.ts, P2]
   await initWikiBlueprint(骨架, config, { variant, minimal })    ← sections+pages+coverage 一次原子写
   失败 → 抛出(generate 失败,UI 行标 failed)

runSectionsNamingStage(context)(minimal 跳过;D16):
   emit waiting;runLog.append(buildStageEvent({stage:'sections'}))
   createAgent({ tools:[...EXPLORE_TOOLS, submit_sections(闭包绑机器骨架, {onlyIds?})],
                 prompts: renderSectionsNamingPrompt(机器清单的 json fence) })
   Agent 抛错 / 未调工具 → sectionsLogger.warn + 行标 failed,**继续**(机器标题兜底)
   → 读回 loadWikiBlueprint 取最终 sections

runPagesNamingStage(context, sections)(minimal 跳过):
   与现 runTopicsStage 同构(pLimit 并发、per-section Agent 行、
   runLog 的 stage/section 事件、markAgentFailed 语义),
   工具换 submit_pages(闭包绑定 section + 其机器页面清单);未调工具/失败 →
   failedSections.push({section, stage:'pages', error})(机器标题已在骨架里)
   emitStageEvent progress {current,total} 同现状

收尾:loadWikiBlueprint → pages 为空抛错(现状) → complete 事件 + BlueprintResult(现状字段)
```

`runClassifyStage` / `runTopicsStage` / `runTitlesStage` / 缩编与兜底函数整体删除。

### 链 B:分类命名(新 `prompts/classify.ts`)

- 输入 = 机器骨架的 json fence(字段 `machineSections: [{id, title, description?, slices, fileCount}]`,
  这是**提示词-数据契约**,mock 与 e2e 按此解析);
- 模型职责:结构分类的 `title`、全部分类的 `scope`、结构分类的 `description`;
  **基础分类(概览/核心架构)的 title/description 系统固定**(与现 `normalizeBlueprintSections` 强补值语义一致),模型提交会被忽略并回执说明;
- `submit_sections` 校验(无回路、必落盘):id ∉ 机器集 → 丢弃并回执点名;缺失 id → 保留机器默认;
  回执固定含机器清单摘要(替代原「数量反馈」文案);
- 落盘: `applySectionNames(entries, { variant, onlyIds? })` —— 文件锁 + 原子替换,
  **只允许写** `title`(仅结构分类)/`description`(仅结构分类)/`scope`(全部);id/slices/顺序不动。

### 链 C:页面命名(新 `prompts/topics.ts`)

- 每分类一个 Agent;提示词含该分类机器页面 fence:`machinePages: [{id, label, files, refs, seams}]`
  与硬规则「只对列出的 id 命名;slug/文件归属由系统固定」;
- `submit_pages` 入参 `{ section, pages: [{id, title, summary?, group?, level?}] }`;
  校验同链 B(id 未知或不属本分类 → 丢弃回执;缺失 → 机器默认);必落盘;
- 落盘 `applyPageNames(entries, { variant, onlyIds? })`:只允许写
  `title` / `topicSummary` / `group` / `level`;**slug/file/section/ownsFiles/associatedFiles/refs 永不被命名工具触碰**(与原 applySectionTitles 的不可变性纪律同级);
- 机器默认值:title = 切片 label;`topicSummary` = `覆盖切片 <id>(<label>):<n> 个文件,<m> 条跨切片依赖`;
  level = `Intermediate`;group = 缺省。

### 链 D:页面写作注入(`wiki/generate-wiki.ts::buildPagePrompt`)

在现有「关联路径」块之后追加三块(全部来自 wiki.json 机器字段,缺省时是空段而非删块):

1. `**本页拥有(ownsFiles)**` —— 正向写作范围;
2. `**跨页引用(refs)**` —— `{path, reason, ownerSlug}` 清单,只引用不讲解(沿用 page-format 范围纪律);
3. `**触及本页的缝合线` —— refs 即跨页边,供 diagram-guide L3 的调用链 grounding 取数
   (符号级仍走 traceability 的 `collectKnownSymbols`,WARN 语义不变)。

`page-format.*` / `diagram-guide.*` / `reader-first.*` / `humanizer.*` **资产文件零改动**
(注入块属于代码模板,不进资产 → 不触发双语条数约束)。write_page、content-gate、mermaid 校验、polish 全链零改动。

### 链 E:sync(`wiki/sync-wiki.ts` 重写)

```
syncWikiInternal:
 1. loadWikiBlueprint → schemaVersion !== 2 → throw
    「旧版 wiki.json(无 schemaVersion=2),sync 不支持,请重新运行 generate」(D9)
 2. scanFiles / diffManifests:无变更 → 空 diff 返回(现状)
 3. parseFiles + save 缓存(现状)→ ensureStructureContext → buildMachineBlueprint(新机器骨架)
 4. reconcileBlueprint({ machine, old, config })               [utils wiki-content.ts]
    页面匹配(纯函数,确定性):
      pair 重叠 = |oldPage.ownsFiles ∩ newPage.ownsFiles|
      候选对按 (重叠 desc, oldSlug asc, newSlug asc) 排序 → 贪心双射(每边至多命中一次,重叠≥1)
      命中的新页:整份身份继承 {slug, file, title, topicSummary, group, level} +
                  section 归属取机器新值;ownsFiles/associatedFiles/refs 取机器新值
      未命中的新页 = 新页(fresh,待命名);旧页 slug 不在结果集 → 归档(unconditional,
        取代原 filesGone/isPathPresent 逻辑;合并场景内容并入胜者页)
    分类协调:
      结构分类得票 = 其命中页的旧 section title 集合;多数票(>命中页半数,
      平票取旧 wiki.json 中顺序靠前者)→ 继承旧 title/description/scope;
      无票/票冲突落败 → 机器 title(description=机器句),计入「新分类」
      基础分类: title/description 系统固定,description/scope 从旧 wiki.json 继承
      无任何页继承的旧分类 → 从 sections 删除
      输出顺序:[概览, 核心架构, 结构分类(按切片序)];页面顺序:分类序 + 槽位先、切片按序
 5. 新分类/新页存在 → 只对这些 id 跑命名阶段(applySectionNames/applyPageNames 的
    onlyIds = fresh 集合;模型即使提交旧 id 也被丢弃) → **URL 与旧标题物理冻结**
    两者都不存在 → 纯机械 sync,跳过全部 Agent
 6. writeWikiPages(全量页表)→ computeSyncDiff(重写分支:
    new = fresh slug;archived = 旧 slug 缺失(无条件);
    updated = 命中且 (title/group/level/associatedFiles/ownsFiles/section 变化 或 命中 changedFiles);
    保留 pageMatchesAny/coversPath 用于 changedFiles 命中;删除 pathStillPresent/
    pathExistsOnDisk/isPathPresent/filesGone 与 buildSyncTopicsRules/uncoveredAdded/merge 分类分支)
 7. SyncDiff / failedSections('pages') / complete 事件(形状现状)
```

`SYNC_TOPICS_RULES` 删除,新 `SYNC_NAMING_RULES`(prompts/topics.ts):「只命名待命名清单;旧条目勿提交(提交会被忽略)」。

### 链 F:verify(`wiki/verify-wiki.ts` 新增 coverage 组)

```
前置分支(按序,任一命中 → 整组 SKIP 并一行说明):
  V0 schemaVersion !== 2 → 「旧版产物,重新 generate 后可执行覆盖检查」
  V1 loadCachedManifest() 为 null → 「无缓存清单」
  V2 coverage.manifestHash ≠ 当前清单哈希 → 「产物基于旧清单(哈希点名),跳过」
  V3 loadCachedSymbols() 为 null → 「无符号缓存」(与 traceability 同降级口径)
检查(FAIL 时 details 点名具体路径/页面,不报百分比):
  C1 覆盖等式:|U| == Σ|page.ownsFiles|;unclaimed≠0 → FAIL 列文件;且 coverage.fileOwner
     与 pages.ownsFiles 逐项一致,不一致 → FAIL 列出入
  C2 排他:同一文件出现在 ≥2 页 ownsFiles → FAIL 点名双方
  C3 行台账(存在已测文件时):ranges 出界(start<1 / end>lineCount / start>end)→ FAIL 点名;
     Σ_{measured}(lineCount) == Σ_{measured}(declared∪gap)(verify 从符号缓存独立重算,
     不信任 coverage.lines)→ 不符 FAIL;measured/total 作为信息行展示
     (excluded 文件未解析 = 不计入台账,信息行注明)
  C4 excluded 一致性:coverage.excluded == (manifest − U) → 不符 FAIL
缝合线解释不设门禁(链 D 的注入即保证数据可达;内容正确性归 traceability WARN + 文风纪律)——
不发明新 WARN 状态(VerifyStatus 只有 PASS/FAIL/SKIP,实读确认)。
verify-wiki 保持只读;CLI verify 渲染代码零改动(只改头注释的检查组列表)。
```

---

## 5. 算法与数据结构定案

### 5.1 CEG 构建(`packages/repo-analyzer/src/structure/graph.ts`)

- 节点 = `SymbolManifest.symbols[].file`(全集 U,按 `Array.sort()` 默认字典序固定);
  `excluded` = `manifest.files − U`(原因统一 `unsupported-or-unparsed`);
- `manifestHash = sha256(JSON.stringify(manifest.files.map(f => [f.path, f.language]).sort()))`(只用实读字段 path/language;node:crypto);
- 边抽取(每条 import 节点文本):
  1. 取首个引号字面量(`'…'` / `"…"`,C 的 `#include <…>` 取尖括号内)→ 有:
     - 以 `.` 开头:`join(dirname(from), cand)`;先按原样匹配 U,再按扩展名序列
       `['.ts','.tsx','.js','.jsx','.mjs','.cjs','.vue','.d.ts','.py','.go','.rs','.java','.php','.rb','.swift','.kt','.cs','.c','.h','.cpp','.hpp']` 逐个追加匹配;再无 → 按 basename 唯一匹配;歧义 → 不建边;
     - 非相对:basename(含扩展名)在 U 中唯一匹配,否则视为外部模块不建边;
  2. 无引号字面量(python `from x import y`、rust `use a::b`):取最后一段标识符,
     在 U 中按「去扩展名 basename」唯一匹配,否则不建边;
  3. `exports[]` 中含 ` from ` 的条目按规则 1 的引号逻辑建 `reexport` 边(与 import 去重可共存);
- 权重:import=2, reexport=3;同一有序对取最大权;丢自环;
- 切分输入用**无向投影** `w({u,v}) = max(双向有向权)`;seam 记录保留有向(跨切片的每条有向边一条记录);
- hub.seamDegree = 关联 seam 记录数;排序 `(degree desc, path asc)`。

### 5.2 切分(`structure/partition.ts`,移植 research `wiki-gen/lib/{partition,structures}.js`,按 9/23 版实读对齐)

顺序固定:①确定性层级 Louvain(节点序 = U 字典序;每轮 `comm[i]=i` 起步;平局取社区号最小——
候选按社区号升序遍历、仅 `s > bestScore + EPS` 才替换;EPS=1e-12;while guard<32;
商图聚合与 mapping 链同原实现;research 默认 `maxLevels=8` 层上限,zread 移植不设上限,循环到收敛,见 §5.3)
→ ②barrel 重锚定:
`functions.length===0 && exports.length>0 && exports.every(含" from ")` 的文件,
切片 := 其 reexport 目标的切片众数(平票取切片序号小;无已解析目标 → 保持原切片)
→ ③折叠:文件数 < `minSliceSize` 的切片并入边权最强邻居(平票取社区索引小;循环 guard = 社区数+4;
社区间权重键用数字复合键 `min*2^27+max`——仅 `get` 不迭代、序无关,与 research 现行实现一致)
→ ④孤儿:零度文件并入「同父目录文件所在切片」(多候选取切片序号小);无同目录文件 → 保持独立单文件切片(豁免折叠)
→ ⑤标签:切片代表 = 切片内 fan-in 最大的文件(平票取路径字典序小),`label` = 其去扩展名 basename;
切片按根社区排序编号 `S1..Sn`(物化用循环 push 而非 spread——research 附录 E 的栈溢出修复,语义等价)。

**research 对照(9/23 实读,有意偏差声明)**:
- ① ③ 逐条对应现行 `louvainHierarchy` / `buildSlices`,含附录 E 的数字复合键与循环 push 两处规模修复;
- research 后处理是**实体级**的:`reconcile.js`(`reconcileRanges` 行区间调和 + `pinTrees` 声明树钉合,
  仅 index-jvm 驱动调用)与 `reanchorModules`(module 实体重锚到「其声明实体多数所在切片」,
  平票 slice id `localeCompare`;纯 barrel 无声明 → `total=0` 跳过;zread 节点即文件,不存在被拆分的
  声明树与可移动的 module 实体,三者**结构上不适用**——行级不双持由文件独占直接推出,见 §12.6);
- ② 是 research 090(barrel 多数派)规则在文件级的**显式后处理**:现行 research 无此步骤,靠
  reexport=3 边把 barrel 在 Louvain 内自然聚到目标侧 + 上述 reanchorModules;zread 把它显式化为
  确定性兜底(有意偏差;§5.1 的 reexport=3 边仍是第一机制);
- ④ research 现行代码无孤儿目录规则(零度社区在折叠中并入序号最小的其它社区);zread 取 docs 089a
  「同包吸附」的文件级对应 = 同父目录(有意偏差,目录语义更可读);
- ⑤ research 现行 `chooseLabel` 为「包名 + 导出成员」启发式(依赖实体/`packageName`,面向切片标题);
  zread 文件级无包名元数据,取 fan-in 代表文件(docs 07/089c 口径,有意偏差)。

`minSliceSize = max(1, round(N / targetPages))`,
`targetPages = spec.sections.max × max(1, round((spec.topics.min + spec.topics.max) / 2))`,
`N = |U|`。(`exhaustive`/max 档**不**进公式,只影响命名提示词文案——与现状语义一致。)

### 5.3 两级切分与选层(`structure/coverage.ts`)

- 页面级 = ⑤之后的切片(细级);
- 分类级:在切片商图上再跑同一确定性层级算法(research 默认 `maxLevels=8` 层上限;zread 移植不设
  该上限,循环到 count=1——无边退化图首层即 count=n 停止,由下文「合并到底 / 接受」两分支兜住),
  得到计数序列 `L=[c0…cm]`(层层合并,末层恒为 1(退化图除外,见前注));
- 窗口 `Tmin = max(1, spec.sections.min − 2)`、`Tmax = max(Tmin, spec.sections.max − 2)`(非 minimal;基础分类恒 2 个);
- 选层:`in = {c ∈ L | Tmin≤c≤Tmax}` 非空 → 取 **最大** c;否则取 `d(c)= c>Tmax ? c−Tmax : Tmin−c`
  最小者,平票取 c 大者;
- 选中 c > Tmax → 聚类合并到底:每轮合并「区间权重最大」的一对(平票取社区代表切片 id 字典序小),
  直到 = Tmax;选中 c < Tmin → **接受**(退化图不强行拆分,定案 D7:区间是目标不是硬约束);
- 结构分类顺序 = 社区内最小切片序号升序;每个结构分类 `slices` = 其成员切片(互斥完备);
- `sec id = 'sec-' + 社区内最小切片 id`;基础分类 id:`overview` / `core`;
- 极小化路径:切片数 ≥1 恒成立 ⇒ 结构分类 ≥1 ⇒ 核心架构不再持有切片页(只持全局槽位)。

### 5.4 槽位与全局文章(移植 research `plan.js` 的集合覆盖)

- `slot:overview`:隶属基础分类「概览」,ownsFiles=[],associatedFiles = 所选 hub 路径(≤6);
- hub 候选 = `seamDegree ≥ 3` 的文件(排序 §5.1);贪心集合覆盖:每轮取「新覆盖未解释 seam 数」最大者
  (平票路径字典序小),上限 6 → `slot:hub:<path>`,ownsFiles=[],associatedFiles=[该文件];
- 若仍有未覆盖 seam **或** hub 槽位为 0 → 追加 `slot:seams`(associatedFiles = seam 端点去重排序取 6 条);
- **保证核心架构 ≥1 个槽位页**(集合覆盖为空时 slot:seams 兜底)。

research `plan.js` 现行对照:`HUB_THRESHOLD=3` / `MAX_HUB_ARTICLES=6` 不变;hub 候选先按
(seam 数 desc、标题 asc)预截断 top-6 再进集合覆盖;未覆盖缝合线兜底成「跨切片依赖地图」文章
(与 `slot:seams` 同构);实体级 `MENTION_BUDGET=16`(每篇局部文章提及上限)不移植——zread refs
是文件级出边清单,数量受文件自身 import/reexport 数约束。

### 5.5 slug 与 id 规范(生成期一次性分配)

- 分配顺序:`slot:overview`(0) → `slot:seams`(1) → hub 槽位(2..) → 切片页(续),
  slug = `<全局序号>-<slugStem(label)>`,冲突走现 `uniqueSlug` 加 `-2` 后缀;`file = slug + '.md'`;
- 运行期 id 仅用于本轮工具绑定(`slot:*` / `slice:S<n>` / `sec-*` / `overview` / `core`);
- **跨次运行身份**:页 = slug,分类 = title(见链 E 继承规则)——id 允许随重切分漂移,不承担身份。

### 5.6 台账字段

- parser:`SymbolInfo.lineCount?: number`(公式:`text === '' ? 0 : text.split(/\r?\n/).length`,
  末元素为空串则移除)、`SymbolInfo.ranges?: Array<{name; start; end}>`
  (capture 集 `fn/method/class/iface/struct/enum/trait/module/type`,`start = startPosition.row + 1`,
  `end = endPosition.row + 1`,clip 到 `[1, lineCount]`,越界丢弃;import/export 不进 ranges——
  按 research 惯例计入间隙行;vue 段 ranges=[] = 不测);`extractWithQuery` 与 `extractBasic` 同步记录;
- `WikiCoverage = { manifestHash, universeCount, excluded: string[], fileOwner: Record<path, slug>,
  slicesBySection: Record<secId, sliceId[]>, modularity, seamCount, lines?: {measured, total, declared, gap} }`;
- 等式(文件级,FAIL 判据):`|M| = Σ|ownsFiles| + |excluded|`,等价于 `|U| = Σ|ownsFiles|`(U 内恰一次);
  行级为独立台账(C3),不参与归属。

---

## 6. 数据契约终态

```jsonc
// wiki.json(schemaVersion=2;缺该字段 = 旧产物)
{
  "schemaVersion": 2,
  "sections": [ { "id": "overview", "title": "概览", "description": "…", "scope": ["…"], "slices": [] },
                { "id": "sec-S2", "title": "…", "description": "…", "scope": ["…"], "slices": ["S2","S5"] } ],
  "pages":    [ { "slug": "0-overview", "title": "…", "file": "0-overview.md", "section": "概览",
                  "level": "Intermediate", "group": "…", "topicSummary": "…",
                  "ownsFiles": [], "associatedFiles": ["…"],
                  "refs": [ { "path": "…", "reason": "import 来自 …", "ownerSlug": "3-…" } ] } ],
  "coverage": { "manifestHash": "…", "universeCount": 21, "excluded": ["README.md"],
                "fileOwner": { "src/a.ts": "2-core" }, "slicesBySection": { "sec-S2": ["S2"] },
                "modularity": 0.81, "seamCount": 12, "lines": { "measured": 21, "total": 555, "declared": 429, "gap": 126 } }
}
```

- 类型(types/wiki.ts):`schemaVersion?: number`、`WikiSection.id?/slices?`、
  `WikiPage.ownsFiles?/refs?`、`WikiOutput.coverage?`(类型可选 = 读旧文件免 cast;
  **运行期由 schemaVersion 强制 v2 必填**,verify/sync 负责执法);
- `WikiTopic` 删除;`WikiSection.scope` 保留;`associatedFiles` 保留字段名、语义改为机器派生(owns ∪ ref 路径);
- 审计件 `structure-<detail>.json`:§5 全部中间产物 + `manifestHash` + 参数快照(minSliceSize/选层/Tmin/Tmax)。

---

## 7. 删除清单(代码即断点,一次性列全)

**逻辑/工具**:runClassifyStage、runTopicsStage、runTitlesStage、runSectionCondenseAgent、
runTopicsCondenseAgent、persistSectionsAfterQuantityFailure、persistTopicsAfterQuantityFailure、
loadSectionPageTitles、buildClassifyPrompt/buildTopicsPrompt/buildTitlesPrompt(旧版)、TITLE_TOOLS;
output-tools 的 createSubmitSectionTopicsTool、createRefineSectionTitlesTool、
createSubmitCondensedSectionsTool、createSubmitCondensedTopicsTool、
GenerateBlueprintTool 归档三件套、normalizeTopicInput、outOfRangeResult;
blueprint-detail 的 judgeQuantity、formatQuantityFeedback、buildSectionQuantityStrategy、
buildTopicsQuantityStrategy、CONDENSE_SYSTEM_PROMPT、buildCondenseSectionTask、
buildCondenseTopicsTask、codeFallbackSections、condenseTopicsToMax、
MAX_QUANTITY_FEEDBACK_ROUNDS、DEFAULT_CONDENSE_TOKEN_BUDGET、QUANTITY_FALLBACK_NOTE、
QuantityToolState、QuantityVerdict、JudgeQuantityOptions、QuantityFeedbackOptions、
`BlueprintDetailSpec.refineTitles` 字段;
create-agent 的 OUTPUT_TOOL_NAMES 收敛为 `{submit_sections, submit_pages, write_page}`。

**utils**:initWikiSkeleton、mergeWikiSections、mergeSectionTopics、applySectionTitles、
mergeBlueprintSections、normalizeBlueprintSections、generateWikiJson(实测调用方仅归档工具)
—— 含 `utils/src/index.ts` 对应导出。

**sync**:buildSyncTopicsRules、SYNC_TOPICS_RULES、uncoveredAdded/merge 分类分支、
pathStillPresent、pathExistsOnDisk、isPathPresent、filesGone 语义。

**类型/文件**:WikiTopic(types/wiki.ts + index 导出)、prompts/titles.ts、
orchestrator types 的 `CatalogStage`/`CatalogAgentRole` 旧联合与 `BlueprintFailedSection.stage` 旧联合。

**测试/脚本**:packages/orchestrator/test/titles-diagnostic.ts 删除;package.json 的
`test:titles` 删除、`test:blueprint` 链去掉 titles-diagnostic、前置加 machine-blueprint;
`test:analyzer` 链加 structure.ts。

**i18n**:不删旧键(回放需要);新增键见 §10 P8。

---

## 8. 新增清单

| 位置 | 内容 |
|---|---|
| `packages/types/src/structure.ts` + index 导出 | StructureCache / MachinePageId / PageRef 等 |
| `packages/types/src/wiki.ts` | §6 新字段、WikiCoverage |
| `packages/repo-analyzer/src/structure/{graph,partition,coverage,index}.ts` | §5.1~5.4 |
| `packages/repo-analyzer/test/structure.ts` | 确定性 / 互斥 / 等式 / barrel / orphan / 选层 / 合并 |
| `packages/utils/src/output/wiki-content.ts` | buildMachineBlueprint、initWikiBlueprint、applySectionNames、applyPageNames、reconcileBlueprint |
| `packages/utils/test/machine-blueprint.ts` | 骨架构成 / slug 序 / 命名冻结 / minimal / 行台账 |
| `packages/orchestrator/src/wiki/structure.ts` | ensureStructureContext(链 A) |
| `packages/orchestrator/src/agents/blueprint-stages.ts` | runStructureStage、runSectionsNamingStage、runPagesNamingStage(重写) |
| `packages/orchestrator/src/tools/output-tools.ts` | submit_sections v2、submit_pages |
| `prompts/classify.ts` / `prompts/topics.ts` | 命名版提示词 + json fence 契约 + SYNC_NAMING_RULES |
| `wiki/verify-wiki.ts` | coverage 组 V0~V3 |
| verify 测试 | v2 正常 / 旧版 SKIP / 双归属 FAIL 三场景 |

---

## 9. 失败路径与兼容(全部封闭,无静默分支)

| 场景 | 行为 | 可见信号 |
|---|---|---|
| symbols 为空(语言不可解析 / md-only 仓库) | 结构阶段 throw,generate 终止 | 错误点名「无可解析源文件」(D21;md-only 不支持,已知限制) |
| manifest / symbols 缓存缺失 | 结构阶段自愈重建(scan+parse+save) | logger.info 一行 |
| 结构算法异常 | throw(不回退旧路径) | UI structure 行 failed + run end failed |
| sections 命名 Agent 失败/未调工具 | 机器标题兜底,继续 | 行 failed + logger.warn |
| pages 命名单分类失败 | 机器标题兜底 + failedSections(`stage:'pages'`) | 现有 failedSections 事件链 |
| 模型提交未知 id / 旧 id | 丢弃 + 回执点名 | tool_result 文本 |
| 旧 wiki.json 跑 sync | throw 提示重新 generate | 一次性报错(无迁移工具,非目标) |
| 旧 wiki.json 跑 verify | coverage 组 SKIP,其余组照常 | 一行 SKIP 说明 |
| 生成后仓库又变更(哈希不一致) | coverage 组整组 SKIP | 哈希点名 |
| 旧 run 日志回放 | 显示层 6 值联合 + 保留旧 i18n 键 | mapper.test 含 legacy 用例 |
| WASM 解析器缓存缺失 | 按现状下载;mock/测试在覆盖 HOME 前把真实 `~/.zread-pi/parsers` 拷入临时家目录,拷不到则一次性下载(网络,诚实声明) | wasm-loader 既有日志 |
| 无边/零度/单文件仓库 | §5.2 孤儿规则 + §5.4 兜底槽位,等式仍闭合 | structure 单测覆盖 |

---

## 10. 分阶段实施(每阶段独立提交、独立验证、全绿才进下一阶段)

### P1 结构层(纯加法)
改动:types/structure.ts、parser 的 lineCount/ranges、repo-analyzer/src/structure/*、
`packages/repo-analyzer/test/structure.ts`、package.json `test:analyzer` 链。
断言:两次构建逐字节一致;切片并集=U 无双归属;barrel/orphan 定案用例;选层窗口与合并到底用例;
hello-python 实跑(走真实家目录 WASM 缓存,与现 smoke-analyzer 同口径)。
验证:`bun run typecheck && bun run test:analyzer && bun run test`。

### P2 机器蓝图(纯加法)
改动:wiki-content.ts 的 buildMachineBlueprint / initWikiBlueprint / applySectionNames /
applyPageNames + `packages/utils/test/machine-blueprint.ts` + `test:blueprint` 链前置。
断言:骨架构成(基础分类序、槽位序、slug 序)、命名工具只能写允许字段(逐字段不可变断言)、
minimal 单页 ownsFiles=U、coverage 字段齐全。
验证:`bun run typecheck && bun run packages/utils/test/machine-blueprint.ts && bun run test`。

### P3 generate 链重写(破坏核心)
改动:orchestrator/wiki/structure.ts、blueprint-stages 三阶段重写、output-tools v2、
prompts/classify+topics 重写、prompts/titles 删除、blueprint-detail 瘦身、
create-agent 工具名单、orchestrator.ts 接线、orchestrator types 联合、
测试面同步:tools/mock-wiki-run.ts(命名分派按 json fence、parsers 拷贝播种、
`expectedPages` 改为读 wiki.json 的 `pages.length` 后再比对 generateWikiContent 的 completed)、
e2e-blueprint 重写、blueprint-detail 测试重写、titles-diagnostic 与 `test:titles` 删除。
e2e 断言组(替换旧 9 页/数量反馈/精修标题断言):
- 骨架先落盘(sections+pages 同时非空,链 A 后即可加载);
- `stage` 事件 = structure/sections/pages;Agent 行 = `structure`、`sections`、
  `pages:<分类>` 各自 running→completed;无 titles/condense 行;
- 命名回执:未知 id 被丢弃的回执文本;机器标题兜底(no-sections / section-skip 两个旧失败模式
  改为:run 完成 + failedSections 或 sections 行 failed + 页面仍在);
- coverage 字段写入且 fileOwner 无冲突;slug 数字前缀正则(既有断言保留);
- 跨 Agent 聚合用量、AGENTS/humanizer 注入、max_tokens 断言(既有,不动)。
验证:`bun run typecheck && bun run test:blueprint && bun run mock:wiki && bun run test`。

### P4 sync 链重写
改动:sync-wiki.ts(链 E)、reconcileBlueprint(computeSyncDiff 分支重写)、
e2e-sync 重写。
断言:schemaVersion≠2 抛错;重叠匹配继承(命中页 slug/title 逐字不变);新增页只跑 pages 命名、
旧 id 提交被丢弃;旧页未命中 → archived(无条件);无新页新分类 → 零 Agent 调用;
归属变化进 updated;`SyncDiff` 语义字段不变。
验证:`bun run typecheck && bun run test:blueprint && bun run mock:wiki && bun run test`。

### P5 死代码收口
改动:§7 删除清单(逻辑已在 P3/P4 停用,本阶段物理删除 + utils/index 导出清理 +
types 的 WikiTopic)。
验证:`bun run typecheck && bun run test`(全量回归证明无残留引用)。

### P6 verify coverage 组
改动:verify-wiki.ts(V0~V3)、CLI verify.ts 头注释、`test/verify-wiki.ts` 扩三场景。
断言:v2 产物 C1/C2/C4 PASS;手工构造双归属/漏归属 → FAIL 且 details 点名文件;
旧格式 → SKIP;哈希不一致 → SKIP;ranges 出界 → C3 FAIL。
验证:`bun run typecheck && bun run test:verify && bun run test:traceability && bun run mock:wiki && bun run test`
(mock:wiki 的结构检查从此**连带覆盖 coverage 组**——它本就断言非 content 组全绿)。

### P7 页面写作注入
改动:generate-wiki.ts buildPagePrompt 三块;`test/e2e-page-generation.ts` 断言
owns/refs/seam 块出现与空段文案。
验证:`bun run typecheck && bun run test:pages && bun run test:page-format && bun run test:mermaid && bun run mock:wiki && bun run test`
(page-format/diagram-guide 资产零改动,以其既有测试作守卫)。

### P8 轨迹与 CLI 展示层
改动:
- types/run-event.ts:`RunStage`、`RunEventAgentRole`(去 classify/topics/titles/condense,
  加 structure/sections/pages,保留 page/polish/run)、`FailedSectionsEvent.stage: 'pages'`;
- CLI wiki-generate/types.ts 本地联合改 **6 值**(含 legacy 三值,回放用);
  mapper.ts 默认值保持 `'classify'`(仅旧日志会命中);agentLabel 增 structure/sections/pages 分支
  且保留 topics/titles/condense 旧分支;stageStatusText 联合 6 值;
- i18n zh/en 新增 `stageStructure/stageSections/stagePages(+Idle)`、
  `agentStructure/agentSections/agentPages`,**不删**旧 stage*/agent* 键;
- 测试:views/wiki-generate/__tests__/mapper.test.ts 重写(新值 + 1 条 legacy 回放用例)、
  apps/cli/test/{mock-generate,cli-target-dir,browse-server}.ts 分派与 fixture 改新工具名/新角色、
  smoke-tui 断言同步(含第 508 行「分类数」档位文案核对:区间数值不变仅语义改「目标」,
  文案提及"校验/归并"处改写后保持断言绿)、real-run-check 按新词表更新;
  packages/trajectory/test fixtures 的 stage/role 字面量改为新值(编译约束),
  旧字符串兼容由 mapper.test 的 legacy 用例承担。
验证:`bun run typecheck && bun run test:tui && bun run test:trajectory && bun run test:browse && bun run mock:wiki && bun run test`。

### P9 文档 / 版本 / 收尾
- README:管线说明、structure 审计件、verify coverage 输出样例(命令实跑后贴)、
  `test:titles` 移除后的脚本表、旧产物需重新 generate 的提示;
- AGENTS.md:§3 表(蓝图行改 `submit_sections/submit_pages`;删除标题精修行;档位行改目标参数;
  交付闸门行加 coverage;新增「结构层」行:`typecheck + test:analyzer + test:blueprint + mock:wiki + test`)、
  §4 冻结点表按 §1 终态改写、§7 增补「旧 wiki.json 需重新生成」「WASM 缓存播种」;
- `.github/release-notes/v1.23.0.md` 随分支提交;
- 版本 1.22.1 → 1.23.0(独立 chore 提交,依据:新增功能 → 次版本 +1;若用户定义主版本则改由用户定);
- 全矩阵实跑并记录输出;`git status --short` 为空。

---

## 11. 测试与验证矩阵(AGENTS §3 对齐)

| 触及 | 必跑 | 新增断言要点 |
|---|---|---|
| structure / parser | typecheck + test:analyzer + test | 确定性、互斥、选层、barrel/orphan、ranges |
| 机器蓝图 / 命名工具 | typecheck + test:blueprint + mock:wiki + test | 骨架序、字段冻结、fence 契约、失败兜底 |
| sync | typecheck + test:blueprint(e2e-sync) + mock:wiki + test | 身份继承、fresh-only 命名、无条件归档 |
| verify | typecheck + test:verify + test:traceability + test | coverage 三场景 + SKIP 分支 |
| 页面生成 | typecheck + test:pages + test:page-format + test:mermaid + mock:wiki + test | 注入块 / 空段 |
| 展示层 / 轨迹 | typecheck + test:tui + test:trajectory + test:browse + test | 新旧词表、legacy 回放 |
| 文档 | typecheck;README 命令实跑 | — |

**合并前总验收(全部真实执行并记录)**:① `bun run typecheck` 0 错误;② `bun run test` 全绿;
③ `bun run mock:wiki` 完成且结构检查(含 coverage)全绿;④ 确定性:连续两次 mock:wiki 的
`structure-<detail>.json` 与 `coverage.fileOwner` 逐字节一致(口径同 research 附录 E 的 D7 双跑);⑤ 反向夹具:双归属/漏归属 → coverage FAIL 点名;
⑥ sync 二次运行:无变更 → 空 diff 且零 Agent 请求;⑦ `git log master..HEAD --oneline` 复核。

---

## 12. 风险与已知限制(诚实声明)

1. **结构社区 ≠ 语义领域**:选层窗口给的是结构分类,可读性靠命名阶段兜底;
   窗口偏粗/偏细的取舍已定(最大可容纳层 + 合并到底 + 允许低于 Tmin),不再有模型侧数量修正;
2. **import-only 图**:反射调用、动态注册、宏生成边不在图内(研究 C 适配器的 scanUsage 级
   符号引用是后续方向,非目标);
3. **sync 合并语义变化**:两篇旧页的文件并入同一新切片时,重叠小的一篇会被归档
   (内容并入胜者页)——由 §4 链 E 规则显式承担;
4. **WASM 依赖**:mock/测试首次在临时家目录解析需要播种或一次性网络下载(见 §9);
5. **md-only / 不可解析语言仓库不再可用**(D21 fail-loud,已知限制);
6. **行台账是信息性台账**,不改变文件级归属粒度(行级归属没有增量价值:文件独占 ⇒ 行独占);
7. **真实 API 全链路仍未跑过**(AGENTS §7 ① 不变;本期验证仍基于 faux/mock/内置夹具);
8. **切片大小重尾**(research 附录 E 实测:p50=3、max=173,861 实体——生成代码/测试数据强聚簇,
   `minSize` 折叠对巨簇失效):zread 结构层在含大量生成代码的仓库同样可能产出巨型切片,
   单页 ownsFiles 数百级、写作粒度失控;本期由命名阶段兜底 + 失败可见,生成代码豁免/粒度重标定属后续方向。

---

## 13. 非目标(明确不做)

概念检测器(13 种 TS 模式)、正文相似度去重(S8)、种子化抽样审计、行级所有权等式、实体级区间调和/声明树钉合与同文件先验(research `reconcile.js`、`sameFileBonus`,
文件级图不适用)、符号级关系边、旧 wiki.json 迁移工具、多档位 structure 复用缓存、
MCP / Skill / shell 工具迁移、「中断续跑」接线——均不在本计划内。

---

## 14. 交付清单(AGENTS §6 对照)

- [ ] P1~P9 全部提交,§11 矩阵输出真实记录
- [ ] 文档同步:README、AGENTS(§1/§3/§4/§7)、release notes
- [ ] 版本 1.22.1 → 1.23.0(独立提交;主版本变更权留给用户)
- [ ] tag 摘要建议:`v1.23.0 —— 结构优先蓝图:代码库切分由算法定界、LLM 只命名,拆分完整性升级为覆盖等式`
- [ ] 分支 `feat/structure-first-blueprint` 小步提交 → 提请用户 `git merge --no-ff`(AI 不自行合并)
- [ ] `git status --short` 为空
