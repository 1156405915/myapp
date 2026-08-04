import {
  BadGatewayException,
  Injectable,
  Logger,
  RequestTimeoutException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import type {
  Options,
  Query,
  SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { AgentChatDto } from './dto/agent-chat.dto';
import { AgentChatResult, AgentStreamEvent } from './claude-agent.types';

type ClaudeAgentSdk = typeof import('@anthropic-ai/claude-agent-sdk');

interface StreamState {
  sessionId?: string;
  hasTextDelta: boolean;
}

@Injectable()
export class ClaudeAgentService {
  private readonly logger = new Logger(ClaudeAgentService.name);
  private readonly activeRequests = new Map<string, AbortController>();
  private sdkPromise?: Promise<ClaudeAgentSdk>;

  constructor(private readonly configService: ConfigService) {}

  getStatus() {
    return {
      configured: Boolean(this.getApiKey()),
      provider: 'deepseek-anthropic-compatible',
      baseUrl: this.getBaseUrl(),
      model: this.getModel(),
      allowedTools: ['WebSearch', 'WebFetch'],
      activeRequests: this.activeRequests.size,
    };
  }

  ensureConfigured(): void {
    if (!this.getApiKey()) {
      throw new ServiceUnavailableException(
        'AI_DEEPSEEK_KEY is not configured on the server',
      );
    }
  }

  async testConnection() {
    this.ensureConfigured();

    const startedAt = Date.now();
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), 45_000);
    let queryInstance: Query | undefined;

    try {
      const sdk = await this.loadSdk();
      queryInstance = sdk.query({
        prompt: 'Reply with exactly: sdk_probe_ok',
        options: this.createOptions(
          {
            message: '',
            enableWebSearch: false,
            maxTurns: 1,
          },
          abortController,
          false,
          false,
        ),
      });

      let resultText = '';
      let sessionId = '';
      for await (const message of queryInstance) {
        sessionId = message.session_id || sessionId;
        if (message.type === 'result') {
          if (message.subtype !== 'success' || message.is_error) {
            throw new Error(
              'errors' in message
                ? message.errors.join('; ')
                : 'Agent connection test failed',
            );
          }
          resultText = message.result;
        }
      }

      return {
        ok: resultText.toLowerCase().includes('sdk_probe_ok'),
        latencyMs: Date.now() - startedAt,
        sessionId,
        model: this.getModel(),
        response: resultText,
      };
    } catch (error) {
      if (abortController.signal.aborted) {
        throw new RequestTimeoutException('Agent connection test timed out');
      }
      const message = this.describeError(error);
      this.logger.error(`Agent connection test failed: ${message}`);
      throw new BadGatewayException(message);
    } finally {
      clearTimeout(timeout);
      queryInstance?.close();
    }
  }

  async chat(dto: AgentChatDto): Promise<AgentChatResult> {
    const requestId = randomUUID();
    let sessionId = dto.sessionId || '';
    let answer = '';
    let durationMs = 0;
    let turns = 0;
    let sdkReportedCostUsd = 0;

    for await (const event of this.stream(dto, requestId)) {
      if (event.type === 'session') {
        sessionId = event.sessionId;
      } else if (event.type === 'text') {
        answer += event.text;
      } else if (event.type === 'complete') {
        sessionId = event.sessionId;
        durationMs = event.durationMs;
        turns = event.turns;
        sdkReportedCostUsd = event.sdkReportedCostUsd;
      } else if (event.type === 'error') {
        throw new BadGatewayException(event.message);
      }
    }

    return {
      requestId,
      sessionId,
      answer,
      durationMs,
      turns,
      sdkReportedCostUsd,
    };
  }

  async *stream(
    dto: AgentChatDto,
    requestId: string,
  ): AsyncGenerator<AgentStreamEvent> {
    this.ensureConfigured();
    if (this.activeRequests.has(requestId)) {
      throw new Error(`Duplicate request id: ${requestId}`);
    }

    const abortController = new AbortController();
    const timeoutMs = this.getTimeoutMs();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      abortController.abort();
    }, timeoutMs);
    let queryInstance: Query | undefined;
    const state: StreamState = {
      sessionId: dto.sessionId,
      hasTextDelta: false,
    };
    this.activeRequests.set(requestId, abortController);

    try {
      const sdk = await this.loadSdk();
      queryInstance = sdk.query({
        prompt: dto.message,
        options: this.createOptions(dto, abortController, true, true),
      });

      for await (const message of queryInstance) {
        for (const event of this.mapMessage(message, state)) {
          yield event;
        }
      }
    } catch (error) {
      const message = timedOut
        ? `Agent request timed out after ${timeoutMs}ms`
        : this.describeError(error);
      this.logger.error(`Agent request ${requestId} failed: ${message}`);
      yield { type: 'error', message };
    } finally {
      clearTimeout(timeout);
      queryInstance?.close();
      this.activeRequests.delete(requestId);
    }
  }

  abortRequest(requestId: string): boolean {
    const controller = this.activeRequests.get(requestId);
    if (!controller) {
      return false;
    }
    controller.abort();
    return true;
  }

  describeError(error: unknown): string {
    const raw = error instanceof Error ? error.message : String(error);
    const key = this.getApiKey();
    return key ? raw.replaceAll(key, '[REDACTED]') : raw;
  }

  private async loadSdk(): Promise<ClaudeAgentSdk> {
    this.sdkPromise ??= import('@anthropic-ai/claude-agent-sdk');
    return this.sdkPromise;
  }

  private createOptions(
    dto: AgentChatDto,
    abortController: AbortController,
    includePartialMessages: boolean,
    persistSession: boolean,
  ): Options {
    const webEnabled = dto.enableWebSearch !== false;
    const tools = webEnabled ? ['WebSearch', 'WebFetch'] : [];
    const currentTime = new Date().toLocaleString('zh-CN', {
      timeZone: 'Asia/Shanghai',
    });

    return {
      abortController,
      model: this.getModel(),
      cwd: this.configService.get<string>('AI_AGENT_CWD') || process.cwd(),
      maxTurns: dto.maxTurns ?? this.getDefaultMaxTurns(),
      tools,
      allowedTools: tools,
      disallowedTools: [
        'Bash',
        'Read',
        'Write',
        'Edit',
        'Glob',
        'Grep',
        'NotebookEdit',
        'Agent',
      ],
      permissionMode: 'dontAsk',
      includePartialMessages,
      persistSession,
      resume: dto.sessionId,
      settingSources: [],
      skills: [],
      systemPrompt: [
        'You are a general-purpose question answering assistant.',
        `The current time in Asia/Shanghai is ${currentTime}.`,
        'Answer in the same language as the user.',
        webEnabled
          ? 'Use WebSearch for current or uncertain facts and WebFetch when a source page must be inspected. Include source URLs for web-derived claims.'
          : 'Web access is disabled for this request. Clearly say when current information cannot be verified.',
        'Do not claim to have used tools that were not actually called.',
      ].join('\n'),
      env: {
        ...process.env,
        ANTHROPIC_BASE_URL: this.getBaseUrl(),
        ANTHROPIC_API_KEY: this.getApiKey(),
        ANTHROPIC_AUTH_TOKEN: this.getApiKey(),
        ANTHROPIC_MODEL: this.getModel(),
        CLAUDE_AGENT_SDK_CLIENT_APP: 'nest-server-test/1.0.0',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
    };
  }

  private mapMessage(
    message: SDKMessage,
    state: StreamState,
  ): AgentStreamEvent[] {
    const events: AgentStreamEvent[] = [];

    if (message.type === 'system' && message.subtype === 'init') {
      state.sessionId = message.session_id;
      events.push({
        type: 'session',
        sessionId: message.session_id,
        model: message.model,
        tools: message.tools,
      });
      return events;
    }

    if (message.type === 'stream_event') {
      const streamEvent = message.event as unknown as Record<string, unknown>;
      if (streamEvent.type === 'content_block_delta') {
        const delta = streamEvent.delta as Record<string, unknown> | undefined;
        if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
          state.hasTextDelta = true;
          events.push({ type: 'text', text: delta.text });
        }
      }
      return events;
    }

    if (message.type === 'assistant') {
      const content = message.message.content as unknown[];
      for (const rawBlock of content) {
        const block = rawBlock as Record<string, unknown>;
        if (
          block.type === 'text' &&
          !state.hasTextDelta &&
          typeof block.text === 'string'
        ) {
          events.push({ type: 'text', text: block.text });
        } else if (
          block.type === 'tool_use' &&
          typeof block.id === 'string' &&
          typeof block.name === 'string'
        ) {
          events.push({
            type: 'tool_use',
            toolUseId: block.id,
            name: block.name,
            input: block.input,
          });
        }
      }
      return events;
    }

    if (message.type === 'user' && message.tool_use_result !== undefined) {
      events.push({ type: 'tool_result', result: message.tool_use_result });
      return events;
    }

    if (message.type === 'tool_progress') {
      events.push({
        type: 'tool_progress',
        toolUseId: message.tool_use_id,
        name: message.tool_name,
        elapsedSeconds: message.elapsed_time_seconds,
      });
      return events;
    }

    if (message.type === 'result') {
      if (message.subtype === 'success' && !message.is_error) {
        state.sessionId = message.session_id;
        events.push({
          type: 'complete',
          sessionId: message.session_id,
          durationMs: message.duration_ms,
          durationApiMs: message.duration_api_ms,
          turns: message.num_turns,
          sdkReportedCostUsd: message.total_cost_usd,
          usage: message.usage,
        });
      } else {
        events.push({
          type: 'error',
          message:
            'errors' in message && message.errors.length
              ? message.errors.join('; ')
              : `Agent stopped with ${message.subtype}`,
        });
      }
    }

    return events;
  }

  private getApiKey(): string {
    return (
      this.configService.get<string>('AI_DEEPSEEK_KEY') ||
      this.configService.get<string>('ANTHROPIC_AUTH_TOKEN') ||
      this.configService.get<string>('ANTHROPIC_API_KEY') ||
      ''
    ).trim();
  }

  private getBaseUrl(): string {
    return (
      this.configService.get<string>('AI_DEEPSEEK_ANTHROPIC_BASE_URL') ||
      'https://api.deepseek.com/anthropic'
    ).replace(/\/$/, '');
  }

  private getModel(): string {
    return (
      this.configService.get<string>('AI_DEEPSEEK_MODEL') || 'deepseek-v4-pro'
    );
  }

  private getDefaultMaxTurns(): number {
    const value = Number(
      this.configService.get<string>('AI_AGENT_MAX_TURNS') || 8,
    );
    return Number.isFinite(value) ? Math.min(Math.max(value, 1), 12) : 8;
  }

  private getTimeoutMs(): number {
    const value = Number(
      this.configService.get<string>('AI_AGENT_TIMEOUT_MS') || 180_000,
    );
    return Number.isFinite(value)
      ? Math.min(Math.max(value, 10_000), 600_000)
      : 180_000;
  }
}
