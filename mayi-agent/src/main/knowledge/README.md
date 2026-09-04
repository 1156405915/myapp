# Construction Knowledge

该目录实现主进程侧的工程标准与市政工法知识库，负责标准元数据登记、适用版本查询、官方增量同步暂存、审核与影响追踪、工法卡匹配、项目快照和标准引用校验。数据库访问和文件写入均保留在受信主进程中，不向渲染进程或 Agent 暴露 SQLite、任意 SQL 和应用数据目录。

## 文件职责

### `construction-knowledge-service.ts`

领域服务和安全边界，主要功能包括：

- 校验并导入结构化标准元数据，自动计算 SHA-256 来源哈希。
- 管理 `pending_review`、`verified_official`、`approved`、`superseded`、`abolished`、`rejected` 等核验状态。
- 按标准编号、地区、专业、适用日期和查询用途执行 Cache-Aside 查询。
- 通过可注入缓存策略管理本地缓存和负缓存，默认新鲜期为 30 天、负缓存为 1 天。
- 使用进程内查询锁合并相同并发请求，避免重复访问官方来源。
- 通过 `OfficialStandardProvider` 接口接入受控官方来源适配器。
- 暂存增量同步批次及来源响应信封，校验最终 URL、MIME、长度、SHA-256 和抓取时间。
- 使用受控状态机记录人工审核历史；废止、替代和驳回会产生受影响工法与项目复核记录。
- 限制官方来源为 HTTPS 白名单，目前覆盖国家标准平台、住建部、安徽省住建厅和合肥市城乡建设局域名。
- 官方查询失败时返回可用的本地过期缓存，并明确标记 `refresh_failed`。
- 创建 `draft` 或 `formal` 项目标准快照；正式快照仅允许已正式核验的标准版本。
- 校验标准实施日期、废止日期、重复选择和项目工作区边界。
- 以 `pending → ready/missing` 状态发布项目标准快照，避免声称 SQLite 与文件系统可跨介质原子提交。
- 组合工法卡匹配、标准引用校验和知识影响查询服务。

### `construction-knowledge-tools.ts`

将知识服务包装为 Claude Agent SDK 内嵌 MCP 工具：

- `query_standard`：查询受控标准缓存及适用版本。
- `create_project_standard_snapshot`：为当前会话创建不可变项目标准快照。
- `latest_project_standard_snapshot`：读取当前会话最近一次标准快照。
- `query_method_cards`：按专业和项目事实匹配已登记工法卡。
- `create_project_method_snapshot`：冻结选中工法版本及其标准快照依赖。
- `latest_project_method_snapshot`：读取最近一次已发布工法快照。
- `validate_standard_references`：校验结构化标准引用并生成项目报告。
- `list_project_knowledge_impacts`：查询标准状态变化产生的待复核影响。

工具使用 Zod 校验输入，并由主进程绑定可信 `sessionId`。Agent 不能通过这些工具导入、审核或删除标准，也不能指定数据库路径、工作区路径或任意官方 URL。

### `standard-code.ts`

提供标准输入正规化和基础校验：

- 统一全角字符、大小写、空格和不同破折号。
- 保留 `GB` 与 `GB/T` 等标准类型差异。
- 支持 `GB`、`GB/T`、`CJJ`、`JGJ`、`DB34`、`DB3401` 等编号前缀。
- 严格校验 `YYYY-MM-DD` 日期并拒绝不存在的日期。
- 对地区、专业和替代标准列表执行去重、排序及长度限制。

### `standard-repository.ts`

封装参数化 SQLite 数据访问：

- 登记标准主体并保存多个历史版本。
- 按标准编号、地区、专业和适用日期选择候选版本。
- 持久化查询结果、失败状态、过期时间和负缓存。
- 更新标准核验状态并写入不可变审核记录。
- 保存官方同步批次和来源记录。
- 计算项目快照修订号。
- 在事务中保存快照头、快照明细和标准版本引用，并单独维护产物发布状态。
- 仅读取 `ready` 状态的最近项目标准快照。

### `method-card-service.ts`

- 从可信内置资源递归加载 JSON 工法卡，拒绝符号链接并限制单卡大小。
- 根据专业、已有事实、必需事实和排除事实执行确定性匹配。
- 正式模式只允许 `approved` 卡片，且必须绑定正式项目标准快照。
- 生成 `.mayi/knowledge/construction/project-method-snapshot-rN.json` 版本化快照。

### `method-card-repository.ts`

- 保存工法卡身份、不可变版本、标准引用和审核历史。
- 保存项目工法快照及 `pending/ready/missing/hash_mismatch` 产物状态。
- 保存标准引用校验报告、问题、知识影响和检索评估事件。
- 在标准废止、替代或驳回后定位受影响工法卡和项目标准快照。

### `standard-validation-service.ts`

- 对章节、策划和工法中的结构化标准引用统一正规化。
- 校验项目快照覆盖、固定版本、实施/废止日期、核验状态和标准名称。
- 有合法条款数据时校验条款存在性；只有元数据时明确标记为“无法验证”。
- 生成 `.mayi/knowledge/construction/standards-validation-rN.json` 版本化报告。

## 核心流程

```text
Agent / 可信界面
       │
       ▼
ConstructionKnowledgeService
       │
       ├─ 本地版本命中 ──────────────► 返回 hit / stale
       │
       ├─ 负缓存命中 ────────────────► 返回 negative_hit
       │
       └─ 本地未命中或已过期
              │
              ▼
       OfficialStandardProvider
              │
              ├─ 发现记录 ─► 保存为 pending_review
              ├─ 未找到 ───► 写入负缓存
              └─ 查询失败 ─► 返回旧缓存或 refresh_failed
```

项目定稿时，从已核验标准版本创建不可变快照。后续全局标准库发生更新，也不会自动改写已有项目快照；需要更新时应创建新的修订版本。

工法流程先从项目事实匹配候选卡片，再冻结明确选择的工法版本。内置首批卡片为 `reviewed`，尚未达到正式输出要求的 `approved`，因此只能进入草案流程。

## 数据存储

本目录通过 `AppStore` 使用应用主数据库中的以下表：

- `standard_registry`
- `standard_versions`
- `standard_queries`
- `project_standard_snapshots`
- `project_standard_snapshot_items`
- `method_cards`
- `method_card_versions`
- `method_standard_refs`
- `project_method_snapshots`
- `project_method_snapshot_items`
- `official_sync_runs`
- `official_source_records`
- `standard_documents`
- `standard_clauses`
- `standard_validation_runs`
- `standard_validation_issues`
- `knowledge_impacts`
- `knowledge_reviews`
- `knowledge_retrieval_events`

共享输入输出类型位于 `src/shared/knowledge-types.ts`，数据库表迁移位于 `src/main/store/app-store.ts`。

## 当前边界

- 当前主要处理标准元数据和版本效力；条款存储结构已建立，但尚未接入合法全文解析器。
- 官方来源同步信封和暂存流程已经建立，但真实网站适配器需要按来源逐个实现和测试。
- 已提供 7 张结构化市政工法卡，状态均为 `reviewed`，不得视为外部专业审批或正式批准。
- 当前不包含 OCR、PDF/Office 标准文本抽取、全文检索、向量检索和模型训练。
- 检索事件仅用于积累零结果率、候选量和延迟等真实数据，后续是否引入向量检索由数据决定。
- 自动发现的标准默认进入 `pending_review`，不能直接用于正式施组快照。
