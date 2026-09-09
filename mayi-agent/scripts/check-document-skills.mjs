import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve('resources/skills-plugin')
const skillsRoot = join(root, 'skills')
const idPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const criticalFiles = [
  'skills/pdf/scripts/convert_pdf_to_images.py',
  'skills/docx/scripts/ooxml/scripts/validate.py',
  'skills/xlsx/recalc.py',
  'skills/construction-intake/scripts/inventory.mjs',
  'skills/construction-schedule-planning/scripts/calculate-schedule.mjs',
  'skills/construction-standard-registry/references/project-standard-snapshot.schema.json',
  'skills/municipal-construction-methods/references/method-card.schema.json',
  'skills/municipal-construction-methods/cards/road/subgrade.json',
  'skills/construction-standard-validation/SKILL.md',
  'skills/hefei-qingtian-precheck/scripts/check-consistency.mjs'
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

const directories = readdirSync(skillsRoot, { withFileTypes: true }).filter((entry) =>
  entry.isDirectory()
)
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

  const skillContent = readFileSync(skillPath, 'utf8')
  const frontmatter = skillContent.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  const name = frontmatter?.[1]
    .match(/^name:\s*([^\r\n]+)$/m)?.[1]
    .trim()
    .replace(/^['"]|['"]$/g, '')
  const description = frontmatter?.[1].match(/^description:\s*([^\r\n]+)$/m)?.[1].trim()
  if (!name || !idPattern.test(name)) errors.push(`${entry.name} 的 SKILL.md name 无效`)
  if (!description) errors.push(`${entry.name} 的 SKILL.md description 不能为空`)
  const localLinks = skillContent.matchAll(/\]\(((?:references|scripts)\/[^\s)#?]+)(?:#[^)]+)?\)/g)
  for (const match of localLinks) {
    if (!existsSync(join(directory, match[1]))) {
      errors.push(`${entry.name} 引用了不存在的本地资源 ${match[1]}`)
    }
  }

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
  if (
    !manifest.displayName ||
    !manifest.description ||
    !/[\u3400-\u9fff]/u.test(manifest.description) ||
    !manifest.category ||
    !manifest.icon ||
    !manifest.license
  ) {
    errors.push(`${entry.name} 缺少产品展示元数据`)
  }
  if (!versionPattern.test(manifest.version || '')) errors.push(`${entry.name} 的 version 无效`)
  if (manifest.source !== 'builtin') errors.push(`${entry.name} 的 source 必须为 builtin`)
  if (typeof manifest.defaultEnabled !== 'boolean') errors.push(`${entry.name} 缺少 defaultEnabled`)
  const requiredSkills = manifest.requires?.skills || []
  if (
    !Array.isArray(requiredSkills) ||
    requiredSkills.some((id) => typeof id !== 'string' || !idPattern.test(id))
  ) {
    errors.push(`${entry.name} 的 requires.skills 无效`)
  } else if (new Set(requiredSkills).size !== requiredSkills.length) {
    errors.push(`${entry.name} 的 requires.skills 存在重复项`)
  } else {
    dependencies.set(manifest.id, requiredSkills)
  }
}

for (const [skillId, requiredSkills] of dependencies) {
  for (const requiredId of requiredSkills) {
    if (!skillIds.has(requiredId)) errors.push(`${skillId} 依赖不存在的技能 ${requiredId}`)
  }
}

const visited = new Set()
const visiting = new Set()
const dependencyPath = []

// 构建前输出具体依赖环，避免无效技能图进入安装包。
function visitDependency(skillId) {
  if (visited.has(skillId)) return
  if (visiting.has(skillId)) {
    const cycleStart = dependencyPath.indexOf(skillId)
    errors.push(`技能依赖存在循环：${[...dependencyPath.slice(cycleStart), skillId].join(' -> ')}`)
    return
  }
  visiting.add(skillId)
  dependencyPath.push(skillId)
  for (const dependencyId of dependencies.get(skillId) || []) {
    if (dependencies.has(dependencyId)) visitDependency(dependencyId)
  }
  dependencyPath.pop()
  visiting.delete(skillId)
  visited.add(skillId)
}

for (const skillId of dependencies.keys()) visitDependency(skillId)

for (const file of criticalFiles) {
  if (!existsSync(resolve(root, file))) errors.push(`缺少关键资源 ${file}`)
}

if (errors.length) fail(errors)
console.log(`文档技能资源检查通过：${skillIds.size} 个技能`)
