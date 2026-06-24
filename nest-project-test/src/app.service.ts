/**
 * 一个具有单个方法的基本服务。
 */
import { Injectable, Inject, Optional } from '@nestjs/common';
@Injectable()
export class AppService {
  constructor(@Optional() @Inject('HTTP_OPTIONS') options) {}
  getHello(): string {
    return 'Hello World!';
  }
}
