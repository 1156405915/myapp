export type AgentStreamEvent =
  | {
      type: 'session';
      sessionId: string;
      model?: string;
      tools?: string[];
    }
  | { type: 'text'; text: string }
  | {
      type: 'tool_use';
      toolUseId: string;
      name: string;
      input: unknown;
    }
  | {
      type: 'tool_result';
      result: unknown;
    }
  | {
      type: 'tool_progress';
      toolUseId: string;
      name: string;
      elapsedSeconds: number;
    }
  | {
      type: 'complete';
      sessionId: string;
      durationMs: number;
      durationApiMs: number;
      turns: number;
      sdkReportedCostUsd: number;
      usage: unknown;
    }
  | { type: 'error'; message: string };

export interface AgentChatResult {
  requestId: string;
  sessionId: string;
  answer: string;
  durationMs: number;
  turns: number;
  sdkReportedCostUsd: number;
}
