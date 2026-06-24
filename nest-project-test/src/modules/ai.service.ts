import { HttpService } from '@nestjs/axios';
import {
  BadGatewayException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { AxiosError } from 'axios';
import { Response } from 'express';
import { Model, Types } from 'mongoose';
import { firstValueFrom } from 'rxjs';
import { AiChat, AiChatDocument } from '../schema/ai-chat.schema';
import { CreateAiChatDto, MoonshotChatDto } from './ai.dto';
import { AiMessage } from './ai.types';

@Injectable()
export class AiService {
  private readonly baseUrl = 'https://api.moonshot.cn/v1';

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
    @InjectModel(AiChat.name) private readonly aiChatModel: Model<AiChatDocument>,
  ) {}

  createSession(createAiChatDto: CreateAiChatDto) {
    return this.aiChatModel.create({
      title: createAiChatDto.title?.trim() || '新建会话',
      modelName: createAiChatDto.model ?? 'moonshot-v1-8k',
      system: createAiChatDto.system,
      messages: [],
    });
  }

  async getSession(id: string) {
    const session = await this.findChatOrFail(id);

    return session;
  }

  async chat(chatDto: MoonshotChatDto) {
    const apiKey = this.configService.get<string>('MOONSHOT_API_KEY');

    if (!apiKey) {
      throw new InternalServerErrorException('MOONSHOT_API_KEY is not configured');
    }

    const session = chatDto.chatId ? await this.findChatOrFail(chatDto.chatId) : null;
    const model = chatDto.model ?? session?.modelName ?? 'moonshot-v1-8k';
    const system = chatDto.system ?? session?.system;
    const messages = this.buildMessages(chatDto, this.toAiMessages(session?.messages), system);

    try {
      const response = await firstValueFrom(
        this.httpService.post(
          `${this.baseUrl}/chat/completions`,
          {
            model,
            messages,
          },
          {
            headers: {
              Authorization: apiKey,
              'Content-Type': 'application/json',
            },
            timeout: 15000,
          },
        ),
      );

      const data = response.data as {
        id?: string;
        model?: string;
        usage?: unknown;
        choices?: Array<{
          message?: {
            role?: string;
            content?: string;
          };
        }>;
      };

      const content = data.choices?.[0]?.message?.content ?? '';

      await this.persistMessages(session, chatDto.prompt, content, model, system);

      return {
        id: data.id,
        model: data.model,
        usage: data.usage,
        content,
        chatId: session?._id,
      };
    } catch (error) {
      if (error instanceof AxiosError) {
        const message =
          typeof error.response?.data === 'object' && error.response?.data
            ? JSON.stringify(error.response.data)
            : error.message;

        throw new BadGatewayException(`Moonshot request failed: ${message}`);
      }

      throw error;
    }
  }

  async streamChat(chatDto: MoonshotChatDto, res: Response) {
    const apiKey = this.configService.get<string>('MOONSHOT_API_KEY');

    if (!apiKey) {
      throw new InternalServerErrorException('MOONSHOT_API_KEY is not configured');
    }

    const session = chatDto.chatId ? await this.findChatOrFail(chatDto.chatId) : null;
    const model = chatDto.model ?? session?.modelName ?? 'moonshot-v1-8k';
    const system = chatDto.system ?? session?.system;
    const messages = this.buildMessages(chatDto, this.toAiMessages(session?.messages), system);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    let fullContent = '';

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages,
          stream: true,
        }),
      });

      if (!response.ok || !response.body) {
        const errorText = await response.text();
        throw new BadGatewayException(`Moonshot stream failed: ${errorText || response.statusText}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();

          if (!trimmed.startsWith('data:')) {
            continue;
          }

          const payload = trimmed.slice(5).trim();

          if (payload === '[DONE]') {
            res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
            continue;
          }

          const parsed = JSON.parse(payload) as {
            choices?: Array<{
              delta?: { content?: string };
            }>;
          };
          const delta = parsed.choices?.[0]?.delta?.content ?? '';

          if (!delta) {
            continue;
          }

          fullContent += delta;
          res.write(`data: ${JSON.stringify({ content: delta })}\n\n`);
        }
      }

      await this.persistMessages(session, chatDto.prompt, fullContent, model, system);
      res.end();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.write(`data: ${JSON.stringify({ error: message })}\n\n`);
      res.end();
    }
  }

  private async persistMessages(
    session: AiChatDocument | null,
    prompt: string,
    answer: string,
    model: string,
    system?: string,
  ) {
    if (!session) {
      return;
    }

    session.modelName = model;
    session.system = system;
    session.messages.push(
      { role: 'user', content: prompt, createdAt: new Date() },
      { role: 'assistant', content: answer, createdAt: new Date() },
    );
    await session.save();
  }

  private async findChatOrFail(id: string) {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException(`Chat session ${id} not found`);
    }

    const session = await this.aiChatModel.findById(id).exec();

    if (!session) {
      throw new NotFoundException(`Chat session ${id} not found`);
    }

    return session;
  }

  private buildMessages(chatDto: MoonshotChatDto, storedMessages: AiMessage[], system?: string) {
    const messages: AiMessage[] = [];

    if (system) {
      messages.push({ role: 'system', content: system });
    }

    if (storedMessages.length) {
      messages.push(...storedMessages.map((item) => ({ role: item.role, content: item.content })));
    }

    if (chatDto.history?.length) {
      messages.push(
        ...chatDto.history.map((item) => ({
          role: item.role as AiMessage['role'],
          content: item.content,
        })),
      );
    }

    messages.push({ role: 'user', content: chatDto.prompt });

    return messages;
  }

  private toAiMessages(messages?: Array<{ role: string; content: string }>): AiMessage[] {
    if (!messages?.length) {
      return [];
    }

    return messages
      .filter(
        (item): item is AiMessage =>
          ['system', 'user', 'assistant'].includes(item.role) && typeof item.content === 'string',
      )
      .map((item) => ({ role: item.role, content: item.content }));
  }
}
