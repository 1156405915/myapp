import { createHash } from 'node:crypto'
import {
  createReadStream,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const STAGES = ['00', '01', '02', '03', '04', '05', '06', '07', '08']
const DEFAULT_MAX_FILES = 50_000
const DEFAULT_MAX_DEPTH = 40

const CATEGORY_RULES = [
  ['clarification', /补疑|答疑|澄清|变更公告|更正公告|补充通知|修改通知/u],
  ['tender', /招标文件|采购文件|投标人须知|评标办法|技术标准和要求|发包文件/u],
  ['bill-of-quantities', /工程量清单|招标清单|最高投标限价|控制价|扬尘污染防治费|价差|主要材料|计价/u],
  ['survey-and-utilities', /地勘|勘察|地质|测量|物探|管线探测|地下管线|勘探点|水文/u],
  ['contract', /合同|专用条款|通用条款|协议书|履约/u],
  ['management-requirements', /管理制度|管理规定|管理办法|封样|第三方巡查|关键工艺/u],
  ['bidder-resources', /项目经理|技术负责人|人员配置|组织机构|企业业绩|类似业绩|机械设备|资格证|职称证/u],
  ['site-survey', /现场踏勘|踏勘|现场照片|航拍|临水|临电|施工出入口|周边环境/u],
  ['reference', /评估报告|参考|范本|模板|案例|历史施组|施工组织设计/u],
  ['drawing', /图纸|设计说明|施工图|设计图|图纸目录|总平面|平面图|纵断面|横断面/u]
]

const CATEGORY_LABELS = {
  tender: '招标主文件',
  clarification: '补疑、答疑和变更',
  drawing: '图纸及设计说明',
  'bill-of-quantities': '清单及控制价',
  'survey-and-utilities': '地勘、测量及管线',
  contract: '合同条件',
  'management-requirements': '建设单位管理要求',
  'bidder-resources': '投标人资源资料',
  'site-survey': '现场踏勘资料',
  reference: '参考资料',
  other: '其他资料'
}

const SOURCE_PRIORITIES = {
  clarification: 100,
  tender: 90,
  drawing: 80,
  'bill-of-quantities': 70,
  contract: 60,
  'management-requirements': 50,
  'survey-and-utilities': 50,
  'site-survey': 45,
  'bidder-resources': 40,
  reference: 20,
  other: 10
}

const EXTENSION_CATEGORIES = {
  '.dwg': 'drawing',
  '.dxf': 'drawing',
  '.hfzf': 'tender',
  '.zb': 'tender',
  '.18zhzb': 'tender'
}

const EXPECTED_SIGNATURES = {
  '.pdf': ['pdf'],
  '.docx': ['zip'],
  '.xlsx': ['zip'],
  '.xlsm': ['zip'],
  '.pptx': ['zip'],
  '.doc': ['ole'],
  '.xls': ['ole'],
  '.ppt': ['ole'],
  '.png': ['png'],
  '.jpg': ['jpeg'],
  '.jpeg': ['jpeg'],
  '.gif': ['gif'],
  '.webp': ['webp'],
  '.dwg': ['dwg']
}

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.json', '.csv', '.tsv', '.xml', '.yaml', '.yml', '.html', '.htm'
])
const ARCHIVE_EXTENSIONS = new Set(['.zip', '.7z', '.rar', '.tar', '.gz', '.tgz'])
const PROPRIETARY_EXTENSIONS = new Set(['.hfzf', '.zb', '.18zhzb'])

function parseArguments(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || value === undefined) throw new Error(`无效参数：${key || ''}`)
    values[key.slice(2)] = value
  }
  for (const key of ['input', 'output']) {
    if (!values[key]) throw new Error(`缺少 --${key} 参数`)
  }
  return values
}

function normalizePathForComparison(value) {
  const normalized = resolve(value).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized
}

function isWithin(rootPath, targetPath) {
  const root = normalizePathForComparison(rootPath)
  const target = normalizePathForComparison(targetPath)
  const relation = relative(root, target)
  return relation === '' || (!relation.startsWith('..') && !isAbsolute(relation))
}

function toRelative(rootPath, targetPath) {
  return relative(rootPath, targetPath).split(sep).join('/')
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${process.pid}.tmp`
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(temporaryPath, path)
}

function detectSignature(buffer) {
  if (buffer.length >= 5 && buffer.subarray(0, 5).toString('ascii') === '%PDF-') return 'pdf'
  if (buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && [0x03, 0x05, 0x07].includes(buffer[2]) && [0x04, 0x06, 0x08].includes(buffer[3])) return 'zip'
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) return 'ole'
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png'
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg'
  if (buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'))) return 'gif'
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp'
  if (buffer.length >= 6 && /^AC10\d{2}$/u.test(buffer.subarray(0, 6).toString('ascii'))) return 'dwg'
  if (buffer.length >= 6 && buffer.subarray(0, 6).equals(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]))) return '7z'
  if (buffer.length >= 7 && buffer.subarray(0, 7).equals(Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]))) return 'rar'
  return 'unknown'
}

function readHeader(path, size = 32) {
  const handle = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(size)
    const bytesRead = readSync(handle, buffer, 0, size, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    closeSync(handle)
  }
}

function hashFile(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolveHash(hash.digest('hex')))
  })
}

function classifyFile(relativePath, extension) {
  const normalized = relativePath.normalize('NFKC')
  for (const [category, pattern] of CATEGORY_RULES) {
    if (pattern.test(normalized)) return category
  }
  return EXTENSION_CATEGORIES[extension] || 'other'
}

function normalizeVersionKey(relativePath) {
  const extension = extname(relativePath).toLocaleLowerCase('en-US')
  const directory = dirname(relativePath).split(sep).join('/').toLocaleLowerCase('zh-CN')
  const stem = basename(relativePath, extname(relativePath))
    .normalize('NFKC')
    .toLocaleLowerCase('zh-CN')
    .replace(/(?:最终|终审|审定|送审|修改|修订|更新|新版|最新版|挂网|签章|成果|正式|定稿|发布)版?/gu, '')
    .replace(/(?:v(?:ersion)?\s*)?\d+(?:\.\d+){0,3}/giu, '')
    .replace(/20\d{2}[-_.年]?\d{1,2}[-_.月]?\d{1,2}日?/gu, '')
    .replace(/\d{2}[-_.]\d{1,2}[-_.]\d{1,2}/gu, '')
    .replace(/[\s_（）()【】\[\]-]+/gu, '')
  return `${directory}/${stem}${extension}`
}

function affectedStagesForCategories(categories) {
  let earliest = 8
  for (const category of categories) {
    if (['tender', 'clarification', 'contract', 'management-requirements'].includes(category)) earliest = Math.min(earliest, 1)
    else if (['drawing', 'bill-of-quantities', 'survey-and-utilities', 'site-survey', 'bidder-resources'].includes(category)) earliest = Math.min(earliest, 2)
    else if (category === 'reference') earliest = Math.min(earliest, 3)
    else earliest = Math.min(earliest, 0)
  }
  return STAGES.slice(earliest)
}

function compareInventories(previous, currentFiles) {
  if (!previous?.files || !Array.isArray(previous.files)) {
    return { baselineAvailable: false, added: [], removed: [], modified: [], affectedStages: STAGES }
  }
  const before = new Map(previous.files.map((file) => [file.relativePath, file]))
  const after = new Map(currentFiles.map((file) => [file.relativePath, file]))
  const added = []
  const removed = []
  const modified = []
  const categories = new Set()

  for (const [path, file] of after) {
    const oldFile = before.get(path)
    if (!oldFile) {
      added.push(path)
      categories.add(file.category)
    } else if (oldFile.sha256 !== file.sha256 || oldFile.size !== file.size) {
      modified.push(path)
      categories.add(file.category)
      if (oldFile.category) categories.add(oldFile.category)
    }
  }
  for (const [path, file] of before) {
    if (!after.has(path)) {
      removed.push(path)
      if (file.category) categories.add(file.category)
    }
  }
  return {
    baselineAvailable: true,
    added: added.sort(),
    removed: removed.sort(),
    modified: modified.sort(),
    affectedStages: added.length || removed.length || modified.length ? affectedStagesForCategories(categories) : []
  }
}

function updateTaskState(taskStatePath, fingerprint, changeSummary) {
  if (!taskStatePath) return
  const state = existsSync(taskStatePath)
    ? JSON.parse(readFileSync(taskStatePath, 'utf8'))
    : { schemaVersion: 1, stages: {} }
  state.inputFingerprint = fingerprint
  state.updatedAt = new Date().toISOString()
  state.stages ||= {}
  for (const stageId of changeSummary.affectedStages) {
    const stage = state.stages[stageId]
    if (stage?.status === 'completed') {
      state.stages[stageId] = { ...stage, status: 'stale', staleAt: state.updatedAt }
    }
  }
  writeJsonAtomic(taskStatePath, state)
}

function buildGroups(files) {
  const hashes = new Map()
  const versions = new Map()
  for (const file of files) {
    const hashGroup = hashes.get(file.sha256) || []
    hashGroup.push(file.relativePath)
    hashes.set(file.sha256, hashGroup)

    const versionKey = normalizeVersionKey(file.relativePath)
    const versionGroup = versions.get(versionKey) || []
    versionGroup.push(file)
    versions.set(versionKey, versionGroup)
  }
  const duplicateGroups = [...hashes.entries()]
    .filter(([, paths]) => paths.length > 1)
    .map(([sha256, paths], index) => ({ id: `DUP-${String(index + 1).padStart(3, '0')}`, sha256, files: paths.sort() }))
  const versionCandidates = [...versions.entries()]
    .filter(([, group]) => group.length > 1 && new Set(group.map((file) => file.sha256)).size > 1)
    .map(([key, group], index) => ({
      id: `VER-${String(index + 1).padStart(3, '0')}`,
      normalizedKey: key,
      files: group
        .map((file) => ({ relativePath: file.relativePath, modifiedAt: file.modifiedAt, sha256: file.sha256 }))
        .sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'zh-CN'))
    }))
  return { duplicateGroups, versionCandidates }
}

function buildCompleteness(files, issues) {
  const counts = Object.fromEntries(Object.keys(CATEGORY_LABELS).map((category) => [category, 0]))
  for (const file of files) counts[file.category] = (counts[file.category] || 0) + 1
  const checks = [
    { id: 'tender-main', label: '招标主文件', present: counts.tender > 0 },
    { id: 'clarifications', label: '补疑、答疑或变更资料', present: counts.clarification > 0, optional: true },
    { id: 'drawings', label: '图纸或设计说明', present: counts.drawing > 0 },
    { id: 'bill-of-quantities', label: '工程量清单或控制价', present: counts['bill-of-quantities'] > 0 }
  ]
  const blockingIssues = issues.filter((issue) => issue.severity === 'blocking')
  const missingRequired = checks.filter((check) => !check.optional && !check.present)
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    gate: 'G0',
    ready: blockingIssues.length === 0 && missingRequired.length === 0,
    status: blockingIssues.length ? 'blocked' : missingRequired.length ? 'incomplete' : 'ready',
    categoryCounts: counts,
    checks,
    blockingIssueCount: blockingIssues.length,
    missingRequired: missingRequired.map((check) => check.label),
    notes: ['本报告只确认资料已登记和基础可读，不代表文件内容已完成专业审查。']
  }
}

export async function createInventory(options) {
  const inputRoot = resolve(options.input)
  const outputRoot = resolve(options.output)
  const maxFiles = Number(options.maxFiles || DEFAULT_MAX_FILES)
  const maxDepth = Number(options.maxDepth || DEFAULT_MAX_DEPTH)
  if (!existsSync(inputRoot) || !statSync(inputRoot).isDirectory()) throw new Error('输入目录不存在或不是文件夹')
  if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 500_000) throw new Error('maxFiles 无效')
  if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 100) throw new Error('maxDepth 无效')
  if (normalizePathForComparison(inputRoot) === normalizePathForComparison(outputRoot)) throw new Error('输出目录不能等于输入目录')

  const taskStatePath = options.taskState ? resolve(options.taskState) : undefined
  if (taskStatePath && !isWithin(dirname(outputRoot), taskStatePath)) throw new Error('task-state 必须位于 construction-plan 输出目录内')
  const generatedFilesRoot = isWithin(inputRoot, outputRoot) ? dirname(outputRoot) : outputRoot

  const files = []
  const issues = []
  const directories = [{ path: inputRoot, depth: 0 }]

  while (directories.length) {
    const current = directories.pop()
    let entries
    try {
      entries = readdirSync(current.path, { withFileTypes: true })
    } catch (error) {
      issues.push({ severity: 'blocking', code: 'directory-read-failed', relativePath: toRelative(inputRoot, current.path), message: String(error) })
      continue
    }
    entries.sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))
    for (const entry of entries) {
      const absolutePath = resolve(current.path, entry.name)
      if (isWithin(generatedFilesRoot, absolutePath)) continue
      const relativePath = toRelative(inputRoot, absolutePath)
      let entryStat
      try {
        entryStat = lstatSync(absolutePath)
      } catch (error) {
        issues.push({ severity: 'high', code: 'stat-failed', relativePath, message: String(error) })
        continue
      }
      if (entryStat.isSymbolicLink()) {
        issues.push({ severity: 'high', code: 'symbolic-link-skipped', relativePath, message: '未跟随符号链接或目录连接' })
        continue
      }
      if (entryStat.isDirectory()) {
        if (current.depth >= maxDepth) {
          issues.push({ severity: 'high', code: 'max-depth-exceeded', relativePath, message: `目录深度超过限制 ${maxDepth}` })
        } else {
          directories.push({ path: absolutePath, depth: current.depth + 1 })
        }
        continue
      }
      if (!entryStat.isFile()) continue
      if (files.length >= maxFiles) throw new Error(`文件数量超过限制 ${maxFiles}`)

      const extension = extname(entry.name).toLocaleLowerCase('en-US')
      const category = classifyFile(relativePath, extension)
      const officeLockFile = entry.name.startsWith('~$') && ['.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx'].includes(extension)
      let sha256
      let signature = 'unknown'
      let status = 'readable'
      const fileIssues = []
      try {
        sha256 = await hashFile(absolutePath)
        if (entryStat.size > 0) signature = detectSignature(readHeader(absolutePath))
      } catch (error) {
        sha256 = null
        status = 'unreadable'
        fileIssues.push({ severity: 'blocking', code: 'file-read-failed', message: String(error) })
      }
      if (entryStat.size === 0) {
        status = 'unreadable'
        fileIssues.push({ severity: 'blocking', code: 'empty-file', message: '文件大小为 0' })
      }
      const expected = EXPECTED_SIGNATURES[extension]
      if (officeLockFile) {
        status = 'ignored'
        fileIssues.push({ severity: 'low', code: 'office-lock-file', message: 'Office 临时锁文件不作为正式资料' })
      } else if (expected && signature !== 'unknown' && !expected.includes(signature)) {
        status = 'unreadable'
        fileIssues.push({ severity: 'blocking', code: 'signature-mismatch', message: `扩展名 ${extension} 与文件头 ${signature} 不一致` })
      } else if (expected && signature === 'unknown' && entryStat.size > 0) {
        status = 'unreadable'
        fileIssues.push({ severity: 'high', code: 'signature-not-recognized', message: `未识别到 ${extension} 的预期文件头` })
      }
      if (TEXT_EXTENSIONS.has(extension) && entryStat.size <= 5 * 1024 * 1024) {
        try {
          new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(absolutePath))
        } catch {
          fileIssues.push({ severity: 'medium', code: 'text-encoding-unverified', message: '不是有效 UTF-8，需确认文本编码' })
          if (status === 'readable') status = 'needs-conversion'
        }
      }
      if (ARCHIVE_EXTENSIONS.has(extension)) {
        fileIssues.push({ severity: 'medium', code: 'archive-not-extracted', message: '压缩包已登记但未解压，需使用安全解压流程' })
        if (status === 'readable') status = 'needs-extraction'
      }
      if (PROPRIETARY_EXTENSIONS.has(extension)) {
        fileIssues.push({ severity: 'medium', code: 'proprietary-format-unverified', message: '专有格式只完成登记，内容尚未验证' })
        if (status === 'readable') status = 'unverified'
      }
      for (const issue of fileIssues) issues.push({ ...issue, relativePath })
      files.push({
        relativePath,
        name: entry.name,
        extension: extension || null,
        size: entryStat.size,
        modifiedAt: entryStat.mtime.toISOString(),
        sha256,
        signature,
        category,
        categoryLabel: CATEGORY_LABELS[category],
        sourcePriority: SOURCE_PRIORITIES[category],
        status,
        issues: fileIssues.map((issue) => issue.code)
      })
    }
  }

  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'zh-CN'))
  const fingerprint = createHash('sha256')
    .update(files.map((file) => `${file.relativePath}\0${file.size}\0${file.sha256 || ''}`).join('\n'))
    .digest('hex')
  const groups = buildGroups(files)
  const previousPath = options.previous ? resolve(options.previous) : resolve(outputRoot, 'file-inventory.json')
  const previous = existsSync(previousPath) ? JSON.parse(readFileSync(previousPath, 'utf8')) : null
  const changeSummary = compareInventories(previous, files)
  const completeness = buildCompleteness(files, issues)
  const generatedAt = new Date().toISOString()
  const inventory = {
    schemaVersion: 1,
    generatedAt,
    root: inputRoot,
    inputFingerprint: fingerprint,
    summary: {
      fileCount: files.length,
      totalBytes: files.reduce((sum, file) => sum + file.size, 0),
      issueCount: issues.length,
      duplicateGroupCount: groups.duplicateGroups.length,
      versionCandidateCount: groups.versionCandidates.length
    },
    files
  }
  const sourceRegister = {
    schemaVersion: 1,
    generatedAt,
    categories: Object.entries(CATEGORY_LABELS).map(([id, label]) => ({
      id,
      label,
      priority: SOURCE_PRIORITIES[id],
      files: files.filter((file) => file.category === id).map((file) => file.relativePath)
    })),
    duplicateGroups: groups.duplicateGroups,
    versionCandidates: groups.versionCandidates
  }
  const unreadableFiles = { schemaVersion: 1, generatedAt, issues }
  const changeReport = { schemaVersion: 1, generatedAt, previousFingerprint: previous?.inputFingerprint || null, currentFingerprint: fingerprint, ...changeSummary }

  mkdirSync(outputRoot, { recursive: true })
  writeJsonAtomic(resolve(outputRoot, 'file-inventory.json'), inventory)
  writeJsonAtomic(resolve(outputRoot, 'source-register.json'), sourceRegister)
  writeJsonAtomic(resolve(outputRoot, 'unreadable-files.json'), unreadableFiles)
  writeJsonAtomic(resolve(outputRoot, 'completeness-report.json'), completeness)
  writeJsonAtomic(resolve(outputRoot, 'change-summary.json'), changeReport)
  updateTaskState(taskStatePath, fingerprint, changeReport)
  return { inventory, sourceRegister, unreadableFiles, completeness, changeSummary: changeReport }
}

async function main() {
  try {
    const args = parseArguments(process.argv.slice(2))
    const result = await createInventory({
      input: args.input,
      output: args.output,
      previous: args.previous,
      taskState: args['task-state'],
      maxFiles: args['max-files'],
      maxDepth: args['max-depth']
    })
    process.stdout.write(`${JSON.stringify({
      status: result.completeness.status,
      ready: result.completeness.ready,
      files: result.inventory.summary.fileCount,
      issues: result.inventory.summary.issueCount,
      fingerprint: result.inventory.inputFingerprint
    }, null, 2)}\n`)
    process.exitCode = result.completeness.ready ? 0 : 2
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main()
}
