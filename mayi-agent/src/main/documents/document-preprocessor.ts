import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { z } from 'zod'
import type { ChatSession, MessageAttachment } from '../../shared/protocol'
import { validateWorkspacePath } from '../security/workspace-guard'

const MAX_FILE_BYTES = 50 * 1024 * 1024
const SUPPORTED_TYPES = new Set(['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'])
const reportSchema = z.object({
  schemaVersion: z.literal(1),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  sourceName: z.string().max(1024),
  status: z.enum(['ready', 'needs_review', 'failed']),
  pageCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  ocrPages: z.number().int().min(0).max(1000),
  cachedPages: z.number().int().min(0).max(1000),
  warnings: z.array(z.string().max(4000)).max(5000),
  pages: z.array(z.object({
    page: z.number().int().min(1).max(1000),
    method: z.enum(['text', 'ocr', 'blank', 'failed']),
    status: z.enum(['ready', 'needs_review', 'failed']),
    textPath: z.string(),
    imagePath: z.string().optional(),
    confidence: z.number().min(0).max(1).optional(),
    warnings: z.array(z.string().max(4000)).max(5000)
  })).max(1000)
})

export interface DocumentPreparation {
  prepare(session: ChatSession, attachments: MessageAttachment[], signal: AbortSignal,
    onProgress: (label: string) => void): Promise<string>
}

interface ProcessResult { code: number | null; stdout: string; stderr: string }
export interface ProcessRequest {
  executable: string
  args: string[]
  cwd: string
  signal: AbortSignal
  timeoutMs: number
  onLine?: (line: string) => void
}
export type ProcessExecutor = (request: ProcessRequest) => Promise<ProcessResult>

export function executeDocumentProcess(request: ProcessRequest): Promise<ProcessResult> {
  request.signal.throwIfAborted()
  return new Promise((resolveResult, reject) => {
    // The parser never inherits provider credentials or executes a shell.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|HOME|USERPROFILE|LOCALAPPDATA|APPDATA|LANG|LC_ALL)$/i.test(key)))
    const child = spawn(request.executable, request.args, {
      cwd: request.cwd, windowsHide: true, shell: false,
      env: { ...env, PYTHONUTF8: '1', OMP_NUM_THREADS: '2' }, stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    let pending = ''
    let failure: Error | undefined
    const abort = () => {
      failure = new Error('文档预处理已取消', { cause: request.signal.reason })
      child.kill('SIGKILL')
    }
    const timer = setTimeout(() => {
      failure = new Error('文档预处理超时；已完成页面已缓存，可重试继续。')
      child.kill('SIGKILL')
    }, request.timeoutMs)
    request.signal.addEventListener('abort', abort, { once: true })
    if (request.signal.aborted) abort()
    const cleanup = () => {
      clearTimeout(timer)
      request.signal.removeEventListener('abort', abort)
    }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout = (stdout + chunk).slice(-64_000)
      pending += chunk
      if (pending.length > 64_000) {
        failure = new Error('文档处理进程返回了过大的协议消息')
        child.kill('SIGKILL')
        pending = ''
        return
      }
      const lines = pending.split('\n')
      pending = lines.pop() || ''
      for (const line of lines) request.onLine?.(line)
    })
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4000) })
    child.once('error', (error) => { cleanup(); reject(failure || error) })
    child.once('close', (code) => {
      cleanup()
      if (failure) reject(failure)
      else resolveResult({ code, stdout, stderr })
    })
  })
}

export class DocumentPreprocessor implements DocumentPreparation {
  private tail: Promise<void> = Promise.resolve()

  constructor(private readonly options: {
    resourceDirectory: string
    pythonCandidates: string[]
    execute?: ProcessExecutor
  }) {}

  async prepare(session: ChatSession, attachments: MessageAttachment[], signal: AbortSignal,
    onProgress: (label: string) => void): Promise<string> {
    const documents = attachments.filter((item) => SUPPORTED_TYPES.has(item.mimeType))
    if (!documents.length) return ''
    signal.throwIfAborted()
    onProgress('等待本地文档解析；不占用模型执行轮次')
    // A single worker bounds native OCR memory across concurrent sessions.
    const previous = this.tail
    let release!: () => void
    this.tail = new Promise<void>((done) => { release = done })
    const ready = previous.then(() => signal.throwIfAborted())
    let rejectAbort!: () => void
    const cancelled = new Promise<never>((_, reject) => {
      rejectAbort = () => reject(new Error('文档预处理已取消'))
      signal.addEventListener('abort', rejectAbort, { once: true })
      if (signal.aborted) rejectAbort()
    })
    try {
      await Promise.race([ready, cancelled])
      const python = await this.findPython(signal)
      const summaries: string[] = []
      const failures: string[] = []
      for (const document of documents) {
        signal.throwIfAborted()
        const result = await this.prepareOne(session, document, python, signal, onProgress)
        summaries.push(result.summary)
        if (result.failed) failures.push(result.summary)
      }
      if (failures.length) {
        throw new Error(`文档解析未完成，已停止模型分析，避免把缺失内容当作完整资料。已成功页面会在重试时复用。\n${failures.join('\n')}\n依赖缺失时请在应用使用的 Python 中安装随附 document-processing/requirements.txt；不要让 Agent 反复重建解析脚本。`)
      }
      onProgress('文档预处理完成，正在开始分析')
      return `应用已执行本地文档预处理（不是业务审核通过）。优先读取以下报告及按页文本，不要重复提取全文、全量转图或搜索其他会话检查点。OCR 数字、表格关系和低置信度内容仍需对照原页复核；Word 编号是逻辑块，不是物理页码。\n${summaries.join('\n')}`
    } finally {
      signal.removeEventListener('abort', rejectAbort)
      void previous.then(release)
    }
  }

  private async findPython(signal: AbortSignal): Promise<string> {
    const execute = this.options.execute || executeDocumentProcess
    const failures: string[] = []
    for (const executable of this.options.pythonCandidates) {
      signal.throwIfAborted()
      try {
        const result = await execute({ executable,
          args: ['-I', '-c', 'import sys; import pypdfium2; from PIL import Image; print("MAYI_DOCUMENT_READY")'],
          cwd: this.options.resourceDirectory, signal, timeoutMs: 8000 })
        if (result.code === 0 && result.stdout.includes('MAYI_DOCUMENT_READY')) return executable
        failures.push(executable)
      } catch {
        signal.throwIfAborted()
        failures.push(executable)
      }
    }
    throw new Error(`未找到可用文档 Python 环境（需要 pypdfium2、Pillow，OCR 另需 rapidocr-onnxruntime）。请安装随附 document-processing/requirements.txt，并可通过 MAYI_DOCUMENT_PYTHON 指定解释器绝对路径。已检查：${failures.join('、')}`)
  }

  private async prepareOne(session: ChatSession, attachment: MessageAttachment, python: string,
    signal: AbortSignal, onProgress: (label: string) => void): Promise<{ summary: string; failed: boolean }> {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(session.id) || !/^[a-zA-Z0-9_-]{1,128}$/.test(attachment.id)) {
      throw new Error('文档会话或附件标识无效')
    }
    const input = resolve(session.cwd, attachment.relativePath)
    const owner = resolve(session.cwd, '.mayi', 'attachments', session.id)
    const relation = relative(owner, input)
    if (!relation || relation.startsWith('..') || isAbsolute(relation)) throw new Error('文档附件不属于当前会话')
    const source = await this.readSafe(session.cwd, input, MAX_FILE_BYTES)
    if (source.length !== attachment.size) throw new Error('文档附件大小已变化，请重新导入')
    signal.throwIfAborted()
    const hash = createHash('sha256').update(source).digest('hex')
    const outputRelative = `.mayi/documents/${session.id}/${attachment.id}/${hash}`
    const output = resolve(session.cwd, outputRelative)
    const validation = validateWorkspacePath(session.cwd, output, true)
    if (!validation.allowed) throw new Error(validation.reason || '文档缓存目录无效')
    await this.rejectLinks(session.cwd, output)
    onProgress(`正在解析 ${attachment.name}`)
    const result = await (this.options.execute || executeDocumentProcess)({
      executable: python,
      args: ['-I', join(this.options.resourceDirectory, 'worker.py'), '--input', input,
        '--output', output, '--sha256', hash, '--name', attachment.name],
      cwd: this.options.resourceDirectory, signal, timeoutMs: 30 * 60_000,
      onLine: (line) => {
        let event: { type?: string; page?: number; total?: number; method?: string }
        try { event = JSON.parse(line) } catch { return }
        if (event.type === 'progress' && Number.isInteger(event.page) && Number.isInteger(event.total)) {
          onProgress(`${attachment.name}：${event.page}/${event.total} 页/逻辑块（${event.method === 'ocr' ? 'OCR，待复核' : event.method === 'failed' ? '失败' : '解析/缓存'}）`)
        }
      }
    })
    signal.throwIfAborted()
    let report: z.infer<typeof reportSchema>
    try {
      report = reportSchema.parse(JSON.parse((await this.readSafe(session.cwd, join(output, 'report.json'), 8 * 1024 * 1024)).toString('utf8')))
    } catch {
      throw new Error(`文档处理未生成有效报告：${attachment.name}（退出码 ${result.code}）。请检查文档依赖或重新导入文件。`)
    }
    if (report.sourceHash !== hash || report.sourceName !== attachment.name ||
        report.pages.length > report.pageCount ||
        (report.status !== 'failed' && report.pages.length !== report.pageCount) ||
        report.pages.some((page, index) =>
          page.page !== index + 1 || page.textPath !== `page-${String(page.page).padStart(4, '0')}.txt` ||
          (page.imagePath && page.imagePath !== `page-${String(page.page).padStart(4, '0')}.png`))) {
      throw new Error('文档报告归属或页码无效')
    }
    const failedPages = report.pages.filter((page) => page.status === 'failed')
    const diagnostic = [...report.warnings, ...failedPages.flatMap((page) => page.warnings)].slice(0, 8)
    const failed = result.code !== 0 || report.status === 'failed' || failedPages.length > 0
    return {
      failed,
      summary: JSON.stringify({ attachmentId: attachment.id, sourceName: attachment.name,
        status: failed ? 'failed' : report.status, pages: report.pageCount, ocrPages: report.ocrPages,
        cachedPages: report.cachedPages, failedPages: failedPages.map((page) => page.page),
        report: `${outputRelative}/report.json`, text: `${outputRelative}/full.txt`,
        ...(failed ? { diagnostics: diagnostic } : {}) })
    }
  }

  private async rejectLinks(workspace: string, target: string): Promise<void> {
    let current = resolve(target)
    const root = resolve(workspace)
    while (true) {
      try {
        if ((await lstat(current)).isSymbolicLink()) throw new Error('文档路径不允许符号链接或目录连接')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      if (current === root) break
      const parent = dirname(current)
      if (parent === current) throw new Error('文档路径超出工作区')
      current = parent
    }
  }

  private async readSafe(workspace: string, target: string, limit: number): Promise<Buffer> {
    const validation = validateWorkspacePath(workspace, target)
    if (!validation.allowed) throw new Error(validation.reason || '文档路径无效')
    await this.rejectLinks(workspace, target)
    const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.nlink !== 1 || info.size > limit) throw new Error('文档文件类型或大小无效')
      const buffer = Buffer.alloc(info.size + 1)
      let size = 0
      while (size < buffer.length) {
        const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null)
        if (!bytesRead) break
        size += bytesRead
      }
      if (size !== info.size) throw new Error('读取过程中文档发生变化')
      return buffer.subarray(0, size)
    } finally { await handle.close() }
  }
}
