import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DocumentPreprocessor,
  executeDocumentProcess,
  type ProcessExecutor,
  type ProcessRequest
} from '../src/main/documents/document-preprocessor'
import type { ChatSession, MessageAttachment } from '../src/shared/protocol'

const temporaryDirectories: string[] = []
const ready = { code: 0, stdout: 'MAYI_DOCUMENT_READY\n', stderr: '' }

function createFixture() {
  const workspace = mkdtempSync(join(tmpdir(), 'mayi-document-preprocessor-'))
  temporaryDirectories.push(workspace)
  const session: ChatSession = {
    id: 'document-session', title: '文档测试', status: 'idle', cwd: workspace,
    createdAt: 0, updatedAt: 0
  }
  const source = Buffer.from('%PDF-1.7\nfixture only\n')
  const attachment: MessageAttachment = {
    id: 'attachment-1', name: '原始 报告.pdf', kind: 'document', mimeType: 'application/pdf',
    size: source.length, relativePath: `.mayi/attachments/${session.id}/stored-uuid.pdf`
  }
  const input = join(workspace, attachment.relativePath)
  mkdirSync(dirname(input), { recursive: true })
  writeFileSync(input, source)
  return { workspace, session, attachment, source }
}

function argument(request: ProcessRequest, flag: string): string {
  const index = request.args.indexOf(flag)
  if (index < 0 || request.args[index + 1] === undefined) throw new Error(`缺少参数 ${flag}`)
  return request.args[index + 1]
}

function createReport(request: ProcessRequest) {
  return {
    schemaVersion: 1,
    sourceHash: argument(request, '--sha256'),
    sourceName: argument(request, '--name'),
    status: 'ready', pageCount: 1, ocrPages: 0, cachedPages: 0, warnings: [] as string[],
    pages: [{ page: 1, method: 'text', status: 'ready', textPath: 'page-0001.txt', warnings: [] as string[] }]
  }
}

type Report = ReturnType<typeof createReport>

function createExecutor(mutate?: (report: Report) => void, code = 0) {
  return vi.fn<ProcessExecutor>(async (request) => {
    if (request.args.includes('-c')) return ready
    const report = createReport(request)
    mutate?.(report)
    const output = argument(request, '--output')
    mkdirSync(output, { recursive: true })
    writeFileSync(join(output, 'page-0001.txt'), '本地文档正文', 'utf8')
    writeFileSync(join(output, 'full.txt'), '本地文档正文', 'utf8')
    writeFileSync(join(output, 'report.json'), JSON.stringify(report), 'utf8')
    request.onLine?.(JSON.stringify({ type: 'progress', page: 1, total: 1, method: 'text' }))
    return { code, stdout: '', stderr: '' }
  })
}

function preprocessor(workspace: string, execute: ProcessExecutor, pythonCandidates = ['fixture-python']) {
  return new DocumentPreprocessor({ resourceDirectory: workspace, pythonCandidates, execute })
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('DocumentPreprocessor', () => {
  it('跳过不支持的附件类型，不检查依赖或产生进度', async () => {
    const { workspace, session, attachment } = createFixture()
    const execute = createExecutor()
    const progress = vi.fn()
    await expect(preprocessor(workspace, execute).prepare(session, [
      { ...attachment, mimeType: 'text/plain', kind: 'text' },
      { ...attachment, mimeType: 'image/png', kind: 'image' }
    ], new AbortController().signal, progress)).resolves.toBe('')
    expect(execute).not.toHaveBeenCalled()
    expect(progress).not.toHaveBeenCalled()
  })

  it.each(['依赖导入失败', '解释器不存在'])('%s 时阻止解析并提示安装依赖', async (failure) => {
    const { workspace, session, attachment } = createFixture()
    const execute = vi.fn<ProcessExecutor>(async () => {
      if (failure === '解释器不存在') throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })
      return { code: 1, stdout: '', stderr: 'ModuleNotFoundError: pypdfium2' }
    })
    await expect(preprocessor(workspace, execute, ['python-a', 'python-b']).prepare(
      session, [attachment], new AbortController().signal, vi.fn()
    )).rejects.toThrow(/未找到可用文档 Python 环境.*pypdfium2.*Pillow/)
    expect(execute.mock.calls.map(([request]) => request.executable)).toEqual(['python-a', 'python-b'])
    expect(execute.mock.calls.every(([request]) => request.args.includes('-c'))).toBe(true)
  })

  it('前一个候选不可用时使用通过依赖探测的解释器', async () => {
    const { workspace, session, attachment } = createFixture()
    const execute = createExecutor()
    execute.mockResolvedValueOnce({ code: 0, stdout: 'not ready', stderr: '' })
    await preprocessor(workspace, execute, ['python-a', 'python-b']).prepare(
      session, [attachment], new AbortController().signal, vi.fn()
    )
    expect(execute.mock.calls.map(([request]) => request.executable)).toEqual(['python-a', 'python-b', 'python-b'])
  })

  it.each([
    ['PDF', 'application/pdf', '原始 报告.pdf'],
    ['Word', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '原始 报告.docx']
  ])('成功索引 %s 并保留原名与内容哈希', async (_, mimeType, name) => {
    const { workspace, session, attachment, source } = createFixture()
    const execute = createExecutor()
    const progress = vi.fn()
    const signal = new AbortController().signal
    const summary = await preprocessor(workspace, execute).prepare(
      session, [{ ...attachment, mimeType, name }], signal, progress
    )
    const hash = createHash('sha256').update(source).digest('hex')
    const output = `.mayi/documents/${session.id}/${attachment.id}/${hash}`
    expect(execute).toHaveBeenCalledTimes(2)
    expect(execute.mock.calls[1][0]).toMatchObject({
      executable: 'fixture-python', cwd: workspace, signal, timeoutMs: 30 * 60_000,
      args: ['-I', join(workspace, 'worker.py'), '--input', join(workspace, attachment.relativePath),
        '--output', join(workspace, output), '--sha256', hash, '--name', name]
    })
    expect(JSON.parse(summary.slice(summary.indexOf('\n') + 1))).toEqual({
      attachmentId: attachment.id, sourceName: name, status: 'ready', pages: 1,
      ocrPages: 0, cachedPages: 0, failedPages: [], report: `${output}/report.json`, text: `${output}/full.txt`
    })
    expect(summary).toContain('不是业务审核通过')
    expect(progress).toHaveBeenCalledWith(`${name}：1/1 页/逻辑块（解析/缓存）`)
    expect(progress).toHaveBeenLastCalledWith('文档预处理完成，正在开始分析')
  })

  it.each(['sourceName', 'sourceHash'] as const)('拒绝 %s 与附件不一致的报告', async (field) => {
    const { workspace, session, attachment } = createFixture()
    const execute = createExecutor((report) => {
      report[field] = field === 'sourceName' ? '其他报告.pdf' : '0'.repeat(64)
    })
    await expect(preprocessor(workspace, execute).prepare(
      session, [attachment], new AbortController().signal, vi.fn()
    )).rejects.toThrow('文档报告归属或页码无效')
  })

  it.each(['报告失败', '页面失败', '非零退出码'])('%s 时阻断模型分析', async (failure) => {
    const { workspace, session, attachment } = createFixture()
    const progress = vi.fn()
    const execute = createExecutor((report) => {
      report.warnings = ['测试解析失败']
      if (failure === '报告失败') report.status = 'failed'
      if (failure === '页面失败') {
        report.pages[0].status = 'failed'
        report.pages[0].method = 'failed'
        report.pages[0].warnings = ['页面内容缺失']
      }
    }, failure === '非零退出码' ? 1 : 0)
    const result = preprocessor(workspace, execute).prepare(
      session, [attachment], new AbortController().signal, progress
    )
    await expect(result).rejects.toThrow('已停止模型分析')
    await expect(result).rejects.toThrow('测试解析失败')
    if (failure === '页面失败') await expect(result).rejects.toThrow('页面内容缺失')
    expect(progress).not.toHaveBeenCalledWith('文档预处理完成，正在开始分析')
  })

  it('保留处理前失败报告中的总页数和诊断', async () => {
    const { workspace, session, attachment } = createFixture()
    const execute = createExecutor((report) => {
      report.status = 'failed'
      report.pageCount = 1001
      report.pages = []
      report.warnings = ['PDF must have 1..1000 pages']
    }, 1)
    await expect(preprocessor(workspace, execute).prepare(
      session, [attachment], new AbortController().signal, vi.fn()
    )).rejects.toThrow('PDF must have 1..1000 pages')
  })

  it('拒绝读取同一工作区内其他会话的真实附件', async () => {
    const { workspace, session, attachment } = createFixture()
    const execute = createExecutor()
    await expect(preprocessor(workspace, execute).prepare(
      { ...session, id: 'other-session' }, [attachment], new AbortController().signal, vi.fn()
    )).rejects.toThrow('文档附件不属于当前会话')
    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute.mock.calls[0][0].args).toContain('-c')
  })

  it('等待中的任务取消后立即退出，后续任务仍等待在途任务完成', async () => {
    const { workspace, session, attachment } = createFixture()
    const entered = deferred()
    const release = deferred()
    const writeReport = createExecutor()
    const order: string[] = []
    let active = 0
    let peak = 0
    let workers = 0
    const execute = vi.fn<ProcessExecutor>(async (request) => {
      if (request.args.includes('-c')) return ready
      const worker = ++workers
      active += 1
      peak = Math.max(peak, active)
      order.push(`start-${worker}`)
      try {
        if (worker === 1) {
          entered.resolve()
          await release.promise
        }
        return await writeReport(request)
      } finally {
        active -= 1
        order.push(`end-${worker}`)
      }
    })
    const processor = preprocessor(workspace, execute)
    const controller = new AbortController()
    const cancelledProgress = vi.fn()
    const first = processor.prepare(session, [attachment], new AbortController().signal, vi.fn())
    const pending: Promise<string>[] = [first]
    try {
      await Promise.race([entered.promise, first.then(() => { throw new Error('首个任务未进入执行器') })])
      const cancelled = processor.prepare(session, [attachment], controller.signal, cancelledProgress)
      pending.push(cancelled)
      const rejection = expect(cancelled).rejects.toThrow('取消')
      const third = processor.prepare(session, [attachment], new AbortController().signal, vi.fn())
      pending.push(third)
      controller.abort()
      await rejection
      await new Promise<void>((resolve) => setTimeout(resolve, 50))
      expect(order).toEqual(['start-1'])
      expect(execute).toHaveBeenCalledTimes(2)
      release.resolve()
      await Promise.all([first, third])
      expect(peak).toBe(1)
      expect(order).toEqual(['start-1', 'end-1', 'start-2', 'end-2'])
      expect(cancelledProgress.mock.calls).toEqual([['等待本地文档解析；不占用模型执行轮次']])
    } finally {
      release.resolve()
      controller.abort()
      await Promise.allSettled(pending)
    }
  })
})

describe('executeDocumentProcess 真实 Node 子进程', () => {
  it('返回退出码和标准输出、错误输出，并按行报告进度', async () => {
    const { workspace } = createFixture()
    const onLine = vi.fn()
    const result = await executeDocumentProcess({
      executable: process.execPath,
      args: ['-e', 'process.stdout.write("first\\nsecond\\n"); process.stderr.write("diagnostic");'],
      cwd: workspace, signal: new AbortController().signal, timeoutMs: 5000, onLine
    })
    expect(result).toEqual({ code: 0, stdout: 'first\nsecond\n', stderr: 'diagnostic' })
    expect(onLine.mock.calls).toEqual([['first'], ['second']])
  }, 10_000)

  it('对预先取消的请求在启动前抛出取消原因', () => {
    const { workspace } = createFixture()
    const controller = new AbortController()
    const reason = new Error('测试提前取消')
    controller.abort(reason)
    expect(() => executeDocumentProcess({
      executable: join(workspace, 'missing-node'), args: [], cwd: workspace,
      signal: controller.signal, timeoutMs: 1000
    })).toThrow(reason)
  })

  it('收到子进程就绪行后取消，终止真实运行中的进程', async () => {
    const { workspace } = createFixture()
    const controller = new AbortController()
    const reason = new Error('测试用户取消')
    const lines: string[] = []
    const result = executeDocumentProcess({
      executable: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000); process.stdout.write("ready\\n");'],
      cwd: workspace, signal: controller.signal, timeoutMs: 5000,
      onLine: (line) => {
        lines.push(line)
        if (line === 'ready') controller.abort(reason)
      }
    })
    try {
      await expect(result).rejects.toMatchObject({ message: '文档预处理已取消', cause: reason })
      expect(lines).toEqual(['ready'])
    } finally {
      controller.abort()
      await result.catch(() => undefined)
    }
  }, 10_000)

  it('超时终止未自行退出的真实子进程且不取消外部信号', async () => {
    const { workspace } = createFixture()
    const controller = new AbortController()
    const result = executeDocumentProcess({
      executable: process.execPath, args: ['-e', 'setInterval(() => {}, 1000);'],
      cwd: workspace, signal: controller.signal, timeoutMs: 200
    })
    try {
      await expect(result).rejects.toThrow('文档预处理超时')
      expect(controller.signal.aborted).toBe(false)
    } finally {
      controller.abort()
      await result.catch(() => undefined)
    }
  }, 10_000)
})
