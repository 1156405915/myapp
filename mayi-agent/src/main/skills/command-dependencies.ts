import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

const WINDOWS_PACKAGES: Record<string, string> = {
  python: 'Python.Python.3.13',
  node: 'OpenJS.NodeJS.LTS',
  pandoc: 'JohnMacFarlane.Pandoc',
  libreoffice: 'TheDocumentFoundation.LibreOffice',
  pdftoppm: 'oschwartz10612.Poppler'
}

const COMMAND_LABELS: Record<string, string> = {
  python: 'Python',
  node: 'Node.js',
  pandoc: 'Pandoc',
  libreoffice: 'LibreOffice',
  pdftoppm: 'Poppler（pdftoppm）'
}

const resolvedCommands = new Map<string, string | null>()

function findExecutable(root: string, fileName: string, depth = 4): string | null {
  if (!root || !existsSync(root) || depth < 0) return null
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isFile() && entry.name.toLocaleLowerCase() === fileName.toLocaleLowerCase()) return path
    if (entry.isDirectory()) {
      const match = findExecutable(path, fileName, depth - 1)
      if (match) return match
    }
  }
  return null
}

function windowsCandidates(id: string): string[] {
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files'
  const localAppData = process.env.LOCALAPPDATA || ''
  const candidates: string[] = []
  if (id === 'libreoffice') {
    candidates.push(join(programFiles, 'LibreOffice', 'program', 'soffice.com'))
    candidates.push(join(programFiles, 'LibreOffice', 'program', 'soffice.exe'))
  }
  if (id === 'pandoc' && localAppData) {
    candidates.push(join(localAppData, 'Pandoc', 'pandoc.exe'))
  }
  if (id === 'pdftoppm' && localAppData) {
    const packages = join(localAppData, 'Microsoft', 'WinGet', 'Packages')
    if (existsSync(packages)) {
      for (const entry of readdirSync(packages, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith('oschwartz10612.Poppler_')) continue
        const executable = findExecutable(join(packages, entry.name), 'pdftoppm.exe')
        if (executable) candidates.push(executable)
      }
    }
  }
  return candidates
}

function commandCandidates(id: string): string[] {
  const aliases: Record<string, string[]> = {
    python: process.platform === 'win32' ? ['python.exe', 'py.exe'] : ['python3', 'python'],
    node: ['node'],
    pandoc: ['pandoc'],
    libreoffice: process.platform === 'win32' ? ['soffice.com', 'soffice.exe'] : ['soffice', 'libreoffice'],
    pdftoppm: ['pdftoppm']
  }
  return [...(aliases[id] || [id]), ...(process.platform === 'win32' ? windowsCandidates(id) : [])]
}

export function commandLabel(id: string): string {
  return COMMAND_LABELS[id] || id
}

export function resolveCommandDependency(id: string): string | null {
  if (resolvedCommands.has(id)) return resolvedCommands.get(id) || null
  for (const candidate of commandCandidates(id)) {
    if (candidate.includes('\\')) {
      if (existsSync(candidate)) {
        resolvedCommands.set(id, candidate)
        return candidate
      }
      continue
    }
    const locator = process.platform === 'win32' ? 'where.exe' : 'which'
    const result = spawnSync(locator, [candidate], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 2_000
    })
    if (result.error || result.status !== 0) continue
    const matches = result.stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)
    const resolved = matches.find(
      (path) =>
        !(
          id === 'python' &&
          path.toLocaleLowerCase().includes('\\microsoft\\windowsapps\\python')
        )
    )
    if (resolved) {
      resolvedCommands.set(id, resolved)
      return resolved
    }
  }
  resolvedCommands.set(id, null)
  return null
}

export function clearResolvedCommandDependencies(ids: string[]): void {
  for (const id of ids) resolvedCommands.delete(id)
}

export function canInstallCommandDependency(id: string): boolean {
  return process.platform === 'win32' && Boolean(WINDOWS_PACKAGES[id])
}

function runInstaller(executable: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true })
    let output = ''
    child.stdout.on('data', (chunk) => (output += String(chunk)))
    child.stderr.on('data', (chunk) => (output += String(chunk)))
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`依赖安装失败（退出码 ${code ?? '未知'}）：${output.trim().slice(-600)}`))
    })
  })
}

export async function installCommandDependencies(ids: string[]): Promise<void> {
  if (process.platform !== 'win32') throw new Error('当前仅支持在 Windows 上自动安装依赖')
  const packages = [...new Set(ids.map((id) => WINDOWS_PACKAGES[id]).filter(Boolean))]
  if (packages.length !== ids.length) throw new Error('包含不支持自动安装的依赖')
  if (!resolveCommandDependency('winget')) throw new Error('未找到 Windows 程序包管理器 winget')

  for (const packageId of packages) {
    await runInstaller('winget', [
      'install',
      '--id',
      packageId,
      '--exact',
      '--silent',
      '--accept-package-agreements',
      '--accept-source-agreements',
      '--disable-interactivity'
    ])
  }
}