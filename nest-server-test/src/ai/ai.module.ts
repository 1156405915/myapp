import { Module } from '@nestjs/common';
import { AiService } from './ai.service';
import { AiController } from './ai.controller';
import { SearchToolService } from './tools/search-tool.service';
import { FinanceToolService } from './tools/finance-tool.service';

@Module({
  providers: [AiService, SearchToolService, FinanceToolService],
  controllers: [AiController],
})
export class AiModule {}
