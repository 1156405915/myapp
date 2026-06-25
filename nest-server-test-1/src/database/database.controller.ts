import { Controller, Get } from '@nestjs/common';
import { DatabaseService } from './database.service';

@Controller('db')
export class DatabaseController {
  constructor(private readonly databaseService: DatabaseService) {}

  @Get('ping')
  ping() {
    return this.databaseService.ping();
  }
}
