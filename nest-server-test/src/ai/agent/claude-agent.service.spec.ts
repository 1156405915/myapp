import { ConfigService } from '@nestjs/config';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeAgentService } from './claude-agent.service';

describe('ClaudeAgentService', () => {
  const values: Record<string, string> = {
    AI_DEEPSEEK_KEY: 'test-secret-key',
    AI_DEEPSEEK_MODEL: 'deepseek-test',
  };
  const configService = {
    get: jest.fn((key: string) => values[key]),
  } as unknown as ConfigService;
  let service: ClaudeAgentService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new ClaudeAgentService(configService);
  });

  it('reports configuration without exposing the API key', () => {
    const status = service.getStatus();

    expect(status).toMatchObject({
      configured: true,
      model: 'deepseek-test',
      allowedTools: ['WebSearch', 'WebFetch'],
    });
    expect(JSON.stringify(status)).not.toContain('test-secret-key');
  });

  it('maps SDK session, text, tool, and result messages', () => {
    const state = { hasTextDelta: false };
    const mapMessage = (
      message: Record<string, unknown>,
    ): Record<string, unknown>[] =>
      (
        service as unknown as {
          mapMessage: (
            message: SDKMessage,
            state: { sessionId?: string; hasTextDelta: boolean },
          ) => Record<string, unknown>[];
        }
      ).mapMessage(message as SDKMessage, state);

    expect(
      mapMessage({
        type: 'system',
        subtype: 'init',
        session_id: 'session-1',
        model: 'deepseek-test',
        tools: ['WebSearch'],
      }),
    ).toEqual([
      {
        type: 'session',
        sessionId: 'session-1',
        model: 'deepseek-test',
        tools: ['WebSearch'],
      },
    ]);

    expect(
      mapMessage({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'hello' },
        },
      }),
    ).toEqual([{ type: 'text', text: 'hello' }]);

    expect(
      mapMessage({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tool-1',
              name: 'WebSearch',
              input: { query: 'weather' },
            },
          ],
        },
      }),
    ).toEqual([
      {
        type: 'tool_use',
        toolUseId: 'tool-1',
        name: 'WebSearch',
        input: { query: 'weather' },
      },
    ]);

    expect(
      mapMessage({
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: 'session-1',
        duration_ms: 120,
        duration_api_ms: 100,
        num_turns: 2,
        total_cost_usd: 0.01,
        usage: { input_tokens: 10, output_tokens: 20 },
      }),
    ).toEqual([
      {
        type: 'complete',
        sessionId: 'session-1',
        durationMs: 120,
        durationApiMs: 100,
        turns: 2,
        sdkReportedCostUsd: 0.01,
        usage: { input_tokens: 10, output_tokens: 20 },
      },
    ]);
  });

  it('redacts the configured API key from errors', () => {
    expect(
      service.describeError(new Error('request failed: test-secret-key')),
    ).toBe('request failed: [REDACTED]');
  });
});
