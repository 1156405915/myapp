import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: queryMock }))
vi.mock('../src/main/logging/logger', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn()
}))

import { ClaudeAgentRunner } from '../src/main/agent/claude-agent-runner'

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
        model: 'deepseek-v4-flash',
        cwd: process.cwd(),
        enabledSkillIds: ['pdf', 'document-summary'],
        skillsPluginPath: resolve('resources/skills-plugin')
      },
      {
        onDelta: vi.fn(),
        onActivity: vi.fn(),
        onPermission: vi.fn()
      }
    )

    expect(queryMock).toHaveBeenCalledOnce()
    expect(queryMock.mock.calls[0][0].options.skills).toEqual(['pdf', 'document-summary'])
    expect(queryMock.mock.calls[0][0].options.systemPrompt.append).toContain('pdf、document-summary')
  })
})
