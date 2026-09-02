---
name: hefei-qingtian-precheck
description: Perform a pre-submission, evidence-based readiness review of construction technical bids for projects that explicitly mention Hefei's Qingtian model, AI-assisted evaluation, or equivalent local requirements. Check scoring coverage, contradictions, project specificity, rejection and anonymous-bid risks, and document consistency; do not claim access to the official Qingtian system, predict an official score, or certify award success.
---

# 合肥青天适配预审

1. 确认项目招标文件是否明确采用青天大模型、AI辅助评审或相关机制；未明确时只能按通用技术标质量预审，不得假定适用青天规则。
2. 收集完整草案、`project-facts.json`、`scoring-matrix.json`、`requirement-traceability.json`、`construction-plan.json`、招标文件和全部补疑。没有草案且用户要求直接生成时，先调用 `construction-organization-design`。
3. 阅读 [references/review-model.md](references/review-model.md) 和 [references/output-contract.md](references/output-contract.md)。招标文件明示规则始终高于本技能的通用检查维度。
4. 结构化成果齐全时运行 `node scripts/check-consistency.mjs --facts <project-facts.json> --matrix <scoring-matrix.json> --plan <construction-plan.json> --output <consistency-report.json>`，把确定性缺项和矛盾纳入问题台账。
5. 调用 `document-review` 检查全文、目录、表格、页眉页脚、图片、文件属性和交叉引用；扫描版或复杂图表必须结合 `pdf`/`docx` 的实际渲染结果审查。
6. 按“阻断、高、中、低”分级输出问题、位置、依据、影响、修复动作和复核证据。优先关闭否决风险、评分漏项、事实矛盾、其他项目残留、暗标泄露和过期规范。
7. 用户要求修订时，将问题台账交回 `construction-organization-design` 修改；重新运行确定性检查和文档审查，直至不存在阻断或高风险问题，或缺失资料使问题无法关闭。
8. 输出“预审就绪/需修订/资料不足”，不得输出“通过青天审核”“官方评分”或“保证中标”。相似性只能针对用户提供或合法可用的对比语料，不能声称完成全平台雷达比对。
