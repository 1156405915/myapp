# Resources 资源说明

本目录存放 Electron 安装包需要复制到 `process.resourcesPath` 的静态资源，包括应用图标和内置办公文档技能插件。

## 应用图标

将正式应用图标放在本目录，例如：

- `icon.ico`：Windows 安装包和可执行文件图标。
- `icon.icns`：macOS 应用图标。
- `icon.png`：Linux 或通用高分辨率图标。

添加图标后，需要在项目根目录 `package.json` 的 electron-builder 配置中填写对应 `icon` 路径。

## 内置文档技能插件

`skills-plugin` 是随应用发布的本地 Claude Agent SDK 插件。插件通过 `.claude-plugin/plugin.json` 声明，并由主进程显式启用以下四个技能：

| SKILL | 主要文件类型 | 核心用途 |
| --- | --- | --- |
| `pdf` | `.pdf` | 创建、读取、提取、合并、拆分、旋转、加密、OCR 和表单处理 |
| `docx` | `.docx` | 创建、读取、编辑、批注、修订、模板复用和 OOXML 校验 |
| `pptx` | `.pptx` | 创建、读取、编辑演示文稿，处理布局、图表、备注和模板 |
| `xlsx` | `.xlsx`、`.xlsm`、`.csv`、`.tsv` | 创建、编辑、分析表格，处理公式、格式、图表和公式重算 |

技能目录：

```text
resources/skills-plugin/
├─ .claude-plugin/plugin.json
└─ skills/
	├─ pdf/
	├─ docx/
	├─ pptx/
	└─ xlsx/
```

### PDF SKILL

PDF 技能用于生成正式 PDF 文件，以及处理已有 PDF 文档。

主要能力：

- 使用 `pypdf` 读取页数、文本、元数据和页面结构。
- 合并、拆分、旋转、裁剪、加密、解密和添加水印。
- 使用 `pdfplumber` 提取带布局的文本和表格。
- 使用 ReportLab 创建包含标题、段落、图片、页眉页脚和复杂表格的 PDF。
- 使用 OCR 处理扫描件或无文本层的 PDF。
- 识别可填写表单，并按照 `FORMS.md` 中的流程填写字段。
- 使用 `pdftoppm` 或 `pypdfium2` 将每一页渲染为图片进行视觉验收。

生成质量要求：

1. 明确设置纸张尺寸、页边距和可打印内容宽度。
2. 表格必须设置列宽、单元格换行、垂直对齐和跨页重复表头。
3. 中文表格需要使用支持中文的字体和 CJK 换行规则。
4. 生成后必须确认 PDF 页数大于零，并检查预期文本是否存在。
5. 必须逐页渲染检查裁切、越界、重叠、乱码、空白页和表格溢出。
6. 验证失败时必须修复并重新生成，不能交付 HTML 或打印预览代替 PDF。

常用依赖：`pypdf`、`pdfplumber`、`pypdfium2`、`reportlab`、Poppler、OCR 工具。

### DOCX SKILL

DOCX 技能用于创建专业 Word 文档，以及在尽量保留原有格式的情况下修改现有文档。

主要能力：

- 使用 `docx` JavaScript 库创建标题、正文、目录、页眉、页脚、分页符和表格。
- 明确控制页面尺寸、页边距、字体、段落间距、列表和标题层级。
- 读取正文、批注和修订内容。
- 将 DOCX 解包为 OOXML，精确编辑文档结构后重新打包。
- 添加批注、处理修订标记并保留已有样式和模板约定。
- 使用内置 XSD 和 OOXML 校验脚本检查文档结构。
- 通过 LibreOffice 转换为 PDF，再逐页检查最终排版。

执行流程：

1. 新建文档时先确定纸张、版式、样式体系和内容结构。
2. 修改文档时先读取或解包原文件，不得直接覆盖未知结构。
3. 完成后执行 DOCX/OOXML 结构校验。
4. 将 DOCX 转换为 PDF，并检查分页、标题孤行、表格断裂、图片溢出和字体替换。
5. 仅在结构和视觉检查全部通过后交付 `.docx` 文件。

常用依赖：Node.js、`docx`、Python、`lxml`、Pandoc、LibreOffice、Poppler。

### PPTX SKILL

PPTX 技能用于创建、分析和编辑 PowerPoint 演示文稿，重点保证每张幻灯片的视觉完整性。

主要能力：

- 使用 `html2pptx` 和 PptxGenJS 创建 16:9 或指定比例的演示文稿。
- 从模板、母版和主题中提取字体、颜色、版式和占位符信息。
- 创建文本、图片、图标、表格、图表和数据可视化。
- 读取和修改备注、批注、动画关系及底层 OOXML。
- 对已有 PPTX 执行解包、编辑、重新打包和结构校验。
- 将 PPTX 转换为 PDF 或图片，对每一张幻灯片进行视觉检查。

执行流程：

1. 创建前完整阅读 `html2pptx.md` 和 `css.md`；编辑 OOXML 前完整阅读 `ooxml.md`。
2. 先确定演示目标、受众、视觉方向、颜色、字体和逐页内容大纲。
3. 使用固定幻灯片尺寸创建布局，避免依赖不确定的自动排版。
4. 生成 PPTX 后执行 OOXML 校验，防止 PowerPoint 无法打开或自动修复。
5. 通过 LibreOffice 转换并逐页检查文字裁切、重叠、边界、对齐、对比度和视觉层级。
6. 任一幻灯片不合格时调整间距、字号或重新设计布局，然后重新生成。

常用依赖：Node.js、`pptxgenjs`、`playwright`、`react-icons`、LibreOffice、Poppler、Python OOXML 校验依赖。

### XLSX SKILL

XLSX 技能用于创建、编辑和分析电子表格，并保证公式、格式和可打印结果可用。

主要能力：

- 使用 `pandas` 读取、清洗、聚合和分析表格数据。
- 使用 `openpyxl` 创建工作簿、公式、样式、条件格式、图表和打印区域。
- 修改现有模板时保留原有布局、样式、公式和命名约定。
- 使用单元格公式而不是在 Python 中计算后写入静态结果，使工作簿可继续更新。
- 使用 `recalc.py` 调用 LibreOffice 重算公式缓存值。
- 扫描所有工作表中的 `#REF!`、`#DIV/0!`、`#VALUE!`、`#N/A`、`#NAME?`、`#NULL!` 和 `#NUM!`。
- 为财务模型提供输入、公式、跨表引用、外部引用和关键假设的颜色约定。

执行流程：

1. 先分析输入数据、现有模板和目标工作表结构。
2. 写入动态公式、格式、冻结窗格、筛选、图表和打印设置。
3. 检查所有公式引用、范围边界、循环引用和跨表引用。
4. 使用 LibreOffice 重算公式，再使用 `openpyxl` 读取缓存结果。
5. 必须达到零公式错误，并检查工作表显示、列宽、行高、换行和打印区域。
6. 缺少 LibreOffice 或重算失败时，不得将工作簿报告为已完成。

常用依赖：Python、`pandas`、`openpyxl`、LibreOffice。

## 技能加载与安全边界

- 主进程通过本地插件路径加载技能，不扫描用户磁盘上的任意技能目录。
- `skills` 白名单只允许 `pdf`、`docx`、`pptx` 和 `xlsx`。
- `settingSources` 保持为空，防止用户级或项目级 Claude 配置覆盖应用安全策略。
- 技能可以读取和分析文件；写文件、编辑文件和执行 Bash 命令仍需要用户授权。
- 缺少生成或验证依赖时，Agent 必须明确报告缺失项，不能跳过验证后声称完成。

## 构建与打包

项目根目录的 `scripts/check-document-skills.mjs` 会在构建前检查四个技能的关键文件。任一关键资源缺失都会直接终止构建。

electron-builder 通过 `extraResources` 将整个 `resources/skills-plugin` 复制到安装目录：

```text
<安装目录>/resources/skills-plugin
```

开发环境从项目内的 `resources/skills-plugin` 加载；安装后的应用从 `process.resourcesPath/skills-plugin` 加载。

## 外部运行依赖

技能说明和脚本会随应用打包，但以下大型运行时工具目前需要目标电脑单独安装：

- LibreOffice：DOCX/PPTX 转换、XLSX 公式重算。
- Poppler：`pdftoppm`、`pdftotext` 等 PDF 渲染和文本工具。
- Python 及对应包：PDF、OOXML、Excel 分析和校验脚本。
- Node.js 文档包：`docx`、`pptxgenjs`、`playwright`、`react-icons` 等。

这些依赖属于质量验证链路的一部分。依赖不存在时应停止对应任务并提示安装，禁止降低标准或输出未经验证的残缺文件。
