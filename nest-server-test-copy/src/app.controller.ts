/**
 * 控制器负责处理传入的请求并将响应发送回客户端。
 */
import { Controller, Get, Req } from '@nestjs/common';
import { AppService } from './app.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getHello(@Req() request: Request): string {
    console.log(request);
    return this.appService.getHello();
  }
}

@Controller('test')
export class TestController {
  @Get()
  getHello(): string {
    return 'Hello World!';
  }
}
