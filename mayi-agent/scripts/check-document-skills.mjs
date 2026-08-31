import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

// 脚本由项目根目录启动，清单只充当各技能关键资源的最小完整性哨兵。
const root = resolve('resources/skills-plugin')
const requiredFiles = [
  '.claude-plugin/plugin.json',
  'skills/pdf/SKILL.md',
  'skills/pdf/scripts/convert_pdf_to_images.py',
  'skills/docx/SKILL.md',
  'skills/docx/scripts/ooxml/scripts/validate.py',
  'skills/pptx/SKILL.md',
  'skills/pptx/html2pptx.tgz',
  'skills/pptx/ooxml/scripts/validate.py',
  'skills/xlsx/SKILL.md',
  'skills/xlsx/recalc.py'
]

// 任一关键资源缺失都应在构建阶段失败，而不是留到用户执行技能时才暴露。
const missing = requiredFiles.filter((file) => !existsSync(resolve(root, file)))
if (missing.length) {
  console.error(`文档技能资源不完整：\n${missing.map((file) => `- ${file}`).join('\n')}`)
  process.exit(1)
}

console.log('文档技能资源检查通过')
