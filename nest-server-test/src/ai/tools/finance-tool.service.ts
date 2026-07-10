import { Injectable, Logger } from '@nestjs/common';
import YahooFinance from 'yahoo-finance2';

const yahooFinance = new (YahooFinance as any)();

@Injectable()
export class FinanceToolService {
  private readonly logger = new Logger(FinanceToolService.name);

  /**
   * 提供给 OpenAI / DeepSeek API 的工具定义结构
   */
  public readonly definition = {
    type: 'function',
    function: {
      name: 'query_finance',
      description: '查询股票或加密货币的实时行情、历史价格或基础财务数据',
      parameters: {
        type: 'object',
        properties: {
          symbol: {
            type: 'string',
            description: '股票代码或加密货币代码（如 AAPL, TSLA, BTC-USD）',
          },
        },
        required: ['symbol'],
      },
    },
  };

  /**
   * 实际执行行情查询的逻辑
   */
  async execute(symbol: string): Promise<string> {
    try {
      this.logger.log(`正在执行行情查询: ${symbol}`);

      // 使用 yahooFinance 获取实时报价数据
      const quote = (await yahooFinance.quote(symbol)) as any;

      if (!quote) {
        return `未能找到关于代码 ${symbol} 的行情数据，请检查代码是否正确。`;
      }

      // 提取核心数据结构化返回
      const result = [
        `股票/加密货币名称: ${quote.longName || quote.shortName || symbol}`,
        `当前价格: ${quote.regularMarketPrice} ${quote.currency}`,
        `今日开盘价: ${quote.regularMarketOpen}`,
        `今日最高价: ${quote.regularMarketDayHigh}`,
        `今日最低价: ${quote.regularMarketDayLow}`,
        `交易量: ${quote.regularMarketVolume}`,
        `市盈率 (PE): ${quote.trailingPE || 'N/A'}`,
        `52周最高价: ${quote.fiftyTwoWeekHigh}`,
        `52周最低价: ${quote.fiftyTwoWeekLow}`,
      ].join('\n');

      return `以下是查询到的行情数据:\n${result}`;
    } catch (e: any) {
      this.logger.error(`行情查询失败: ${e.message}`);
      return `查询行情失败，可能代码不存在或网络异常。`;
    }
  }
}
