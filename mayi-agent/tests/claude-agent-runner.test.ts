import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: queryMock }))
vi.mock('../src/main/logging/logger', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn()
}))

import { ClaudeAgentRunner } from '../src/main/agent/claude-agent-runner'

const temporaryDirectories: string[] = []

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
})
