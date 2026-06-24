/**
 * 一个具有单个路由的基本控制器。
 * 负责处理传入的 请求 ，并向客户端返回 响应。
 */

import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }
}
