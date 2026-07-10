import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import * as cheerio from 'cheerio';

@Injectable()
export class SearchToolService {
  private readonly logger = new Logger(SearchToolService.name);

  constructor(private configService: ConfigService) {}

  /**
   * 提供给 OpenAI / DeepSeek API 的工具定义结构
   */
  public readonly definition = {
    type: 'function',
    function: {
      name: 'search_web',
      description:
        '当需要查询实时信息、最新新闻或未知的知识时，使用此工具进行联网搜索。',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '搜索的关键词，尽量精炼，适合搜索引擎使用',
          },
        },
        required: ['query'],
      },
    },
  };

  /**
   * 联网查询工具，优先使用 Tavily Search API，如果没有配置 Key，则回退到 DuckDuckGo。
   * 返回格式化的搜索结果字符串。
   */
  async execute(query: string): Promise<string> {
    const tavilyKey = this.configService.get<string>('TAVILY_API_KEY');

    if (tavilyKey) {
      try {
        this.logger.log(`正在执行 Tavily API 联网搜索: ${query}`);
        const response = await axios.post(
          `https://api.tavily.com/search`,
          {
            api_key: tavilyKey,
            query: query,
            search_depth: 'basic',
            max_results: 5,
          },
          {
            headers: { 'Content-Type': 'application/json' },
            timeout: 10000,
          },
        );

        const results: string[] = [];
        const webPages = response.data?.results || [];
        webPages.forEach((page: any) => {
          results.push(`标题: ${page.title}\n摘要: ${page.content}`);
        });
        return results.length > 0 ? results.join('\n\n') : '未找到相关搜索结果';
      } catch (e: any) {
        this.logger.error(`Tavily 联网搜索失败: ${e.message}`);
        return '搜索失败，无法获取网络内容';
      }
    }

    // 如果没有配置 Tavily API Key，则回退使用 DuckDuckGo 免费抓取
    try {
      this.logger.log(
        `未配置 Tavily Key，正在执行 DuckDuckGo 联网搜索: ${query}`,
      );
      const response = await axios.post(
        `https://html.duckduckgo.com/html/`,
        `q=${encodeURIComponent(query)}`,
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          },
          timeout: 10000,
        },
      );
      const $ = cheerio.load(response.data);
      const results: string[] = [];
      $('.result').each((i, el) => {
        if (i >= 10) return; // 限制返回前10条结果
        const title = $(el).find('.result__title').text().trim();
        const desc = $(el).find('.result__snippet').text().trim();
        if (title && desc) {
          results.push(`标题: ${title}\n摘要: ${desc}`);
        }
      });
      return results.length > 0 ? results.join('\n\n') : '未找到相关搜索结果';
    } catch (e: any) {
      this.logger.error(`DuckDuckGo 联网搜索失败: ${e.message}`);
      return '搜索失败，无法获取网络内容';
    }
  }
}
