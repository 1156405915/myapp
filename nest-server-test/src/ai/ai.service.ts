import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { SearchToolService } from './tools/search-tool.service';
import { FinanceToolService } from './tools/finance-tool.service';

@Injectable()
export class AiService {
  private openai: OpenAI;
  private readonly logger = new Logger(AiService.name);

  constructor(
    private configService: ConfigService,
    private searchToolService: SearchToolService,
    private financeToolService: FinanceToolService,
  ) {
    const apiKey = this.configService.get<string>('AI_DEEPSEEK_KEY');
    if (!apiKey) {
      this.logger.warn('环境变量 AI_DEEPSEEK_KEY 未配置');
    }

    this.openai = new OpenAI({
      apiKey: apiKey || '',
      baseURL: 'https://api.deepseek.com',
    });
  }

  /**
   * 调用 DeepSeek API 进行智能问答。
   * 支持 function calling，遇到未知信息时可自动调用联网搜索工具。
   */
  async chat(message: string): Promise<string> {
    try {
      // 注入当前时间，帮助模型回答日期相关问题
      const currentTime = new Date().toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
      });
      const messages: any[] = [
        {
          role: 'system',
          content: `你是一个智能助手。当前北京时间是: ${currentTime}。当你需要了解最新的实时信息、新闻、或者任何你不知道的事情时，请使用 search_web 联网搜索工具。`,
        },
        { role: 'user', content: message },
      ];

      const tools: any[] = [
        this.searchToolService.definition,
        this.financeToolService.definition,
      ];

      const response = await this.openai.chat.completions.create({
        model: 'deepseek-chat',
        messages,
        tools,
      });

      const responseMessage = response.choices[0]?.message;

      // 如果模型决定调用工具
      if (responseMessage?.tool_calls) {
        messages.push(responseMessage); // 将助手的 tool_calls 消息加入历史

        for (const toolCall of responseMessage.tool_calls as any[]) {
          if (toolCall.function.name === 'search_web') {
            const args = JSON.parse(toolCall.function.arguments);
            const searchResult = await this.searchToolService.execute(
              args.query,
            );

            messages.push({
              tool_call_id: toolCall.id,
              role: 'tool',
              name: 'search_web',
              content: searchResult,
            });
          } else if (toolCall.function.name === 'query_finance') {
            const args = JSON.parse(toolCall.function.arguments);
            const financeResult = await this.financeToolService.execute(
              args.symbol,
            );

            messages.push({
              tool_call_id: toolCall.id,
              role: 'tool',
              name: 'query_finance',
              content: financeResult,
            });
          }
        }

        // 将工具的返回结果再次发给模型，获取最终回答
        const secondResponse = await this.openai.chat.completions.create({
          model: 'deepseek-chat',
          messages,
        });

        return secondResponse.choices[0]?.message?.content || '';
      }

      return responseMessage?.content || '';
    } catch (error: any) {
      this.logger.error(
        `调用 DeepSeek API 失败: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }
}
