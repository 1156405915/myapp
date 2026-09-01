import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve('resources/skills-plugin')
const skillsRoot = join(root, 'skills')
const idPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const criticalFiles = [
  'skills/pdf/scripts/convert_pdf_to_images.py',
  'skills/docx/scripts/ooxml/scripts/validate.py',
  'skills/pptx/html2pptx.tgz',
  'skills/pptx/ooxml/scripts/validate.py',
  'skills/xlsx/recalc.py'
]

function fail(messages) {
  console.error(`文档技能资源无效：\n${messages.map((message) => `- ${message}`).join('\n')}`)
  process.exit(1)
}

const errors = []
const pluginPath = join(root, '.claude-plugin', 'plugin.json')
if (!existsSync(pluginPath)) fail(['缺少 .claude-plugin/plugin.json'])

let plugin
try {
  plugin = JSON.parse(readFileSync(pluginPath, 'utf8'))
} catch {
  fail(['plugin.json 不是有效 JSON'])
}
if (typeof plugin.name !== 'string' || !plugin.name.trim()) errors.push('plugin.json 缺少 name')
if (typeof plugin.version !== 'string' || !versionPattern.test(plugin.version)) {
  errors.push('plugin.json version 无效')
}

const directories = readdirSync(skillsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory())
const skillIds = new Set()
const dependencies = new Map()

for (const entry of directories) {
  const directory = join(skillsRoot, entry.name)
  if (lstatSync(directory).isSymbolicLink()) {
    errors.push(`${entry.name} 不能是符号链接`)
    continue
  }
  const skillPath = join(directory, 'SKILL.md')
  const mayiPath = join(directory, 'mayi.json')
  if (!existsSync(skillPath)) errors.push(`${entry.name} 缺少 SKILL.md`)
  if (!existsSync(mayiPath)) errors.push(`${entry.name} 缺少 mayi.json`)
  if (!existsSync(skillPath) || !existsSync(mayiPath)) continue

  const frontmatter = readFileSync(skillPath, 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/)
  const name = frontmatter?.[1].match(/^name:\s*([^\r\n]+)$/m)?.[1].trim().replace(/^['"]|['"]$/g, '')
  const description = frontmatter?.[1].match(/^description:\s*([^\r\n]+)$/m)?.[1].trim()
  if (!name || !idPattern.test(name)) errors.push(`${entry.name} 的 SKILL.md name 无效`)
  if (!description) errors.push(`${entry.name} 的 SKILL.md description 不能为空`)

  let manifest
  try {
    manifest = JSON.parse(readFileSync(mayiPath, 'utf8'))
  } catch {
    errors.push(`${entry.name}/mayi.json 不是有效 JSON`)
    continue
  }
  if (!idPattern.test(manifest.id || '')) errors.push(`${entry.name} 的 mayi.json id 无效`)
  if (manifest.id !== entry.name || manifest.id !== name) {
    errors.push(`${entry.name} 的目录名、SKILL.md name 和 mayi.json id 不一致`)
  }
  if (skillIds.has(manifest.id)) errors.push(`技能 ID 重复：${manifest.id}`)
  skillIds.add(manifest.id)
  if (!manifest.displayName || !manifest.category || !manifest.icon || !manifest.license) {
    errors.push(`${entry.name} 缺少产品展示元数据`)
  }
  if (!versionPattern.test(manifest.version || '')) errors.push(`${entry.name} 的 version 无效`)
  if (manifest.source !== 'builtin') errors.push(`${entry.name} 的 source 必须为 builtin`)
  if (typeof manifest.defaultEnabled !== 'boolean') errors.push(`${entry.name} 缺少 defaultEnabled`)
  const requiredSkills = manifest.requires?.skills || []
  if (!Array.isArray(requiredSkills) || requiredSkills.some((id) => typeof id !== 'string')) {
    errors.push(`${entry.name} 的 requires.skills 无效`)
  } else {
    dependencies.set(manifest.id, requiredSkills)
  }
}

for (const [skillId, requiredSkills] of dependencies) {
  for (const requiredId of requiredSkills) {
    if (!skillIds.has(requiredId)) errors.push(`${skillId} 依赖不存在的技能 ${requiredId}`)
  }
}

for (const file of criticalFiles) {
  if (!existsSync(resolve(root, file))) errors.push(`缺少关键资源 ${file}`)
}

if (errors.length) fail(errors)
console.log(`文档技能资源检查通过：${skillIds.size} 个技能`)
