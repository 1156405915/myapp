import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { queryMock, createSdkMcpServerMock, toolMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  createSdkMcpServerMock: vi.fn((options) => ({ ...options, type: 'sdk', instance: {} })),
  toolMock: vi.fn((name, description, inputSchema, handler) => ({
    name,
    description,
    inputSchema,
    handler
  }))
}))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: queryMock,
  createSdkMcpServer: createSdkMcpServerMock,
  tool: toolMock
}))
vi.mock('../src/main/logging/logger', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn()
}))

import { ClaudeAgentRunner } from '../src/main/agent/claude-agent-runner'
import type { DocumentPreparation } from '../src/main/documents/document-preprocessor'

const temporaryDirectories: string[] = []

describe('ClaudeAgentRunner 文档预处理', () => {
  const session = { id: 'document-session', title: '文档', status: 'idle' as const,
    cwd: process.cwd(), createdAt: 0, updatedAt: 0 }
  const config = { apiKey: 'test-key', baseUrl: 'https://api.example.com/anthropic',
    model: 'deepseek-v4-flash', cwd: process.cwd(), enabledSkillIds: ['pdf'],
    skillsPluginPath: resolve('resources/skills-plugin') }

  it('等待预处理完成后才调用模型并注入索引和进度', async () => {
    let complete!: (value: string) => void
    const prepare = vi.fn<DocumentPreparation['prepare']>((_session, _attachments, _signal, progress) => {
      progress('正在 OCR 第 1 页')
      return new Promise((done) => { complete = done })
    })
    queryMock.mockImplementation(() => (async function* () {
      yield { type: 'result', subtype: 'success', session_id: 'runtime', result: '完成',
        modelUsage: {}, usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0, duration_ms: 1 }
    })())
    const onActivity = vi.fn()
    const run = new ClaudeAgentRunner(undefined, { prepare }).run(session, '分析', config,
      { onActivity, onDelta: vi.fn(), onPermission: vi.fn() })
    expect(prepare).toHaveBeenCalledOnce()
    expect(queryMock).not.toHaveBeenCalled()
    complete('.mayi/documents/document-session/report.json')
    await run
    expect(queryMock).toHaveBeenCalledOnce()
    expect(queryMock.mock.calls[0][0].prompt).toContain('.mayi/documents/document-session/report.json')
    expect(onActivity).toHaveBeenCalledWith({ kind: 'thinking', label: '正在 OCR 第 1 页' })
  })

  it('即使附带图片，预处理失败也保留原始诊断且不调用模型', async () => {
    const prepare = vi.fn().mockRejectedValue(new Error('缺少 OCR 依赖'))
    const runner = new ClaudeAgentRunner(undefined, { prepare })
    await expect(runner.run(session, '分析', config,
      { onActivity: vi.fn(), onDelta: vi.fn(), onPermission: vi.fn() },
      [{ id: 'image', name: '图片.png', kind: 'image', mimeType: 'image/png', size: 1,
        relativePath: '.mayi/attachments/document-session/image.png' }])).rejects.toThrow('缺少 OCR 依赖')
    expect(queryMock).not.toHaveBeenCalled()
  })

  it('取消预处理后不启动模型', async () => {
    let complete!: (value: string) => void
    let signal!: AbortSignal
    const prepare: DocumentPreparation['prepare'] = (_session, _attachments, currentSignal) => {
      signal = currentSignal
      return new Promise((done) => { complete = done })
    }
    const runner = new ClaudeAgentRunner(undefined, { prepare })
    const run = runner.run(session, '分析', config,
      { onActivity: vi.fn(), onDelta: vi.fn(), onPermission: vi.fn() })
    const rejected = expect(run).rejects.toThrow()
    runner.cancel(session.id)
    expect(signal.aborted).toBe(true)
    complete('不应发送给模型')
    await rejected
    expect(queryMock).not.toHaveBeenCalled()
  })
})

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('ClaudeAgentRunner 技能白名单', () => {
  it('把当前任务的技能快照传给 SDK', async () => {
    queryMock.mockImplementation(() =>
      (async function* () {
        yield {
          type: 'result',
          subtype: 'success',
          session_id: 'runtime-session',
          result: '完成',
          modelUsage: { 'test-model': {} },
          usage: { input_tokens: 10, output_tokens: 5 },
          total_cost_usd: 0,
          duration_ms: 20
        }
      })()
    )
    const runner = new ClaudeAgentRunner()

    await runner.run(
      {
        id: 'session-id',
        title: '测试',
        status: 'idle',
        cwd: process.cwd(),
        createdAt: Date.now(),
        updatedAt: Date.now()
      },
      '总结文档',
      {
        apiKey: 'test-key',
        baseUrl: 'https://api.example.com/anthropic',
        model: 'deepseek-v4-flash',
        cwd: process.cwd(),
        enabledSkillIds: ['pdf', 'document-summary'],
        skillsPluginPath: resolve('resources/skills-plugin'),
        rolePrompt: '执行施组编制工作流。'
      },
      {
        onDelta: vi.fn(),
        onActivity: vi.fn(),
        onPermission: vi.fn()
      }
    )

    expect(queryMock).toHaveBeenCalledOnce()
    expect(queryMock.mock.calls[0][0].options.model).toBe('deepseek-v4-flash')
    expect(queryMock.mock.calls[0][0].options.tools).toEqual(
      expect.arrayContaining(['Bash', 'TaskOutput', 'TaskStop'])
    )
    expect(queryMock.mock.calls[0][0].options.skills).toEqual(['pdf', 'document-summary'])
    expect(queryMock.mock.calls[0][0].options.systemPrompt.append).toContain('pdf、document-summary')
    expect(queryMock.mock.calls[0][0].options.systemPrompt.append).toContain('执行施组编制工作流。')
    expect(queryMock.mock.calls[0][0].options.systemPrompt.append).toContain('run_in_background')
    expect(queryMock.mock.calls[0][0].options.env.MAYI_SESSION_ID).toBe('session-id')
    expect(queryMock.mock.calls[0][0].options.env.ANTHROPIC_BASE_URL).toBe(
      'https://api.example.com/anthropic'
    )
  })

  it('图片使用结构化多模态块，文档只进入工作区路径提示', async () => {
    const workspace = join(tmpdir(), `mayi-runner-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    temporaryDirectories.push(workspace)
    const attachmentDirectory = join(workspace, '.mayi', 'attachments', 'session-id')
    mkdirSync(attachmentDirectory, { recursive: true })
    const imageBytes = Buffer.from('normalized-image')
    writeFileSync(join(attachmentDirectory, 'image.png'), imageBytes)
    let userMessage: unknown
    queryMock.mockImplementation(({ prompt }) =>
      (async function* () {
        if (typeof prompt !== 'string') {
          for await (const message of prompt) userMessage = message
        }
        yield {
          type: 'result',
          subtype: 'success',
          session_id: 'runtime-session',
          result: '完成',
          modelUsage: { 'test-model': {} },
          usage: { input_tokens: 10, output_tokens: 5 },
          total_cost_usd: 0,
          duration_ms: 20
        }
      })()
    )
    const runner = new ClaudeAgentRunner()

    await runner.run(
      {
        id: 'session-id',
        title: '测试',
        status: 'idle',
        cwd: workspace,
        createdAt: Date.now(),
        updatedAt: Date.now()
      },
      '分析附件',
      {
        apiKey: 'test-key',
        baseUrl: 'https://api.example.com/anthropic',
        model: 'deepseek-v4-flash',
        cwd: workspace,
        enabledSkillIds: ['pdf', 'image-analysis'],
        skillsPluginPath: resolve('resources/skills-plugin')
      },
      { onDelta: vi.fn(), onActivity: vi.fn(), onPermission: vi.fn() },
      [
        {
          id: 'image-id',
          name: '截图.png',
          kind: 'image',
          mimeType: 'image/png',
          size: imageBytes.length,
          relativePath: '.mayi/attachments/session-id/image.png'
        },
        {
          id: 'pdf-id',
          name: '合同.pdf',
          kind: 'document',
          mimeType: 'application/pdf',
          size: 123,
          relativePath: '.mayi/attachments/session-id/contract.pdf'
        }
      ]
    )

    expect(userMessage).toMatchObject({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: expect.stringContaining('.mayi/attachments/session-id/contract.pdf') },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: imageBytes.toString('base64')
            }
          }
        ]
      }
    })
    expect(queryMock.mock.calls[0][0].options.model).toBe('glm-5.3-flash')
    expect(queryMock.mock.calls[0][0].options.env.ANTHROPIC_MODEL).toBe('glm-5.3-flash')
  })

  it('仅在标准登记技能启用时注入会话绑定的知识工具', async () => {
    queryMock.mockImplementation(() =>
      (async function* () {
        yield {
          type: 'result',
          subtype: 'success',
          session_id: 'runtime-session',
          result: '完成',
          modelUsage: { 'test-model': {} },
          usage: { input_tokens: 1, output_tokens: 1 },
          total_cost_usd: 0,
          duration_ms: 1
        }
      })()
    )
    const knowledge = {
      queryStandard: vi.fn(),
      createProjectSnapshot: vi.fn(),
      getLatestProjectSnapshot: vi.fn()
    }
    const runner = new ClaudeAgentRunner(knowledge as never)

    await runner.run(
      {
        id: 'knowledge-session',
        title: '标准查询',
        status: 'idle',
        cwd: process.cwd(),
        createdAt: Date.now(),
        updatedAt: Date.now()
      },
      '查询标准',
      {
        apiKey: 'test-key',
        baseUrl: 'https://api.example.com/anthropic',
        model: 'deepseek-v4-flash',
        cwd: process.cwd(),
        enabledSkillIds: [
          'construction-standard-registry',
          'municipal-construction-methods',
          'construction-standard-validation'
        ],
        skillsPluginPath: resolve('resources/skills-plugin')
      },
      { onDelta: vi.fn(), onActivity: vi.fn(), onPermission: vi.fn() }
    )

    const options = queryMock.mock.calls.at(-1)[0].options
    expect(options.mcpServers).toHaveProperty('mayi-construction-knowledge')
    expect(options.allowedTools).toEqual(
      expect.arrayContaining([
        'mcp__mayi-construction-knowledge__query_standard',
        'mcp__mayi-construction-knowledge__create_project_standard_snapshot',
        'mcp__mayi-construction-knowledge__latest_project_standard_snapshot',
        'mcp__mayi-construction-knowledge__query_method_cards',
        'mcp__mayi-construction-knowledge__create_project_method_snapshot',
        'mcp__mayi-construction-knowledge__latest_project_method_snapshot',
        'mcp__mayi-construction-knowledge__validate_standard_references',
        'mcp__mayi-construction-knowledge__list_project_knowledge_impacts'
      ])
    )
    expect(toolMock.mock.calls.map((call) => call[0])).toEqual([
      'query_standard',
      'create_project_standard_snapshot',
      'latest_project_standard_snapshot',
      'query_method_cards',
      'create_project_method_snapshot',
      'latest_project_method_snapshot',
      'validate_standard_references',
      'list_project_knowledge_impacts'
    ])
  })
})
