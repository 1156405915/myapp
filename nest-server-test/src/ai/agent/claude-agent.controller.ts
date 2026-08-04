import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import { ClaudeAgentService } from './claude-agent.service';
import { AgentChatDto } from './dto/agent-chat.dto';

@Controller('ai/agent')
export class ClaudeAgentController {
  constructor(private readonly agentService: ClaudeAgentService) {}

  @Get('status')
  getStatus() {
    return { success: true, data: this.agentService.getStatus() };
  }

  @Post('test')
  @HttpCode(HttpStatus.OK)
  async testConnection() {
    return {
      success: true,
      data: await this.agentService.testConnection(),
    };
  }

  @Post('chat')
  @HttpCode(HttpStatus.OK)
  async chat(@Body() dto: AgentChatDto) {
    return { success: true, data: await this.agentService.chat(dto) };
  }

  @Post('stream')
  async stream(@Body() dto: AgentChatDto, @Res() response: Response) {
    this.agentService.ensureConfigured();
    const requestId = randomUUID();

    response.status(HttpStatus.OK);
    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('Connection', 'keep-alive');
    response.setHeader('X-Accel-Buffering', 'no');
    response.flushHeaders();
    this.writeEvent(response, 'ready', { requestId });

    const onClose = () => {
      if (!response.writableEnded) {
        this.agentService.abortRequest(requestId);
      }
    };
    response.on('close', onClose);

    try {
      for await (const event of this.agentService.stream(dto, requestId)) {
        if (response.destroyed) {
          break;
        }
        this.writeEvent(response, event.type, event);
      }
    } catch (error) {
      if (!response.destroyed) {
        this.writeEvent(response, 'error', {
          type: 'error',
          message: this.agentService.describeError(error),
        });
      }
    } finally {
      response.off('close', onClose);
      if (!response.writableEnded && !response.destroyed) {
        response.end();
      }
    }
  }

  @Delete('requests/:requestId')
  cancel(@Param('requestId') requestId: string) {
    return {
      success: true,
      data: { requestId, aborted: this.agentService.abortRequest(requestId) },
    };
  }

  private writeEvent(response: Response, event: string, data: unknown): void {
    response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
}
