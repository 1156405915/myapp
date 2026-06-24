import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { firstValueFrom } from 'rxjs';
import { AxiosResponse } from 'axios';
import { Model } from 'mongoose';
import { News, NewsDocument } from '../schema/news.schema';

@Injectable()
export class NewsService {
  private readonly logger = new Logger(NewsService.name);
  private readonly rssUrl = 'https://rsshub.app/github/trending/daily';

  constructor(
    private readonly httpService: HttpService,
    @InjectModel(News.name) private readonly newsModel: Model<NewsDocument>,
  ) {}

  // @Cron(CronExpression.EVERY_MINUTE)
  async fetchHotNews() {
    try {
      const response = await firstValueFrom(
        this.httpService.get<string, AxiosResponse<string>>(this.rssUrl, {
          responseType: 'text',
          headers: {
            Accept: 'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
          },
          timeout: 5000,
        }),
      );

      const hotItem = this.parseFirstNewsItem(response.data);

      if (!hotItem) {
        this.logger.warn('No hot news found from rss source');
        return;
      }

      await this.newsModel.findOneAndUpdate(
        { sourceId: hotItem.link },
        {
          title: hotItem.title,
          sourceId: hotItem.link,
          url: hotItem.link,
          source: 'github-trending',
          hot: 0,
          fetchedAt: new Date(),
        },
        { upsert: true, new: true, runValidators: true },
      ).exec();

      this.logger.log(`Fetched hot news: ${hotItem.title}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Failed to fetch hot news: ${message}`);
    }
  }

  private parseFirstNewsItem(xml: string) {
    const itemMatch = xml.match(/<item>[\s\S]*?<title><!\[CDATA\[(.*?)\]\]><\/title>[\s\S]*?<link>(.*?)<\/link>[\s\S]*?<\/item>/i);

    if (!itemMatch) {
      return null;
    }

    const [, title, link] = itemMatch;

    return {
      title: title.trim(),
      link: link.trim(),
    };
  }

  findAll() {
    return this.newsModel.find().sort({ fetchedAt: -1 }).exec();
  }
}
