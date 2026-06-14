import {
  Injectable,
  Logger,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Connection,
  Pool,
  ResultSetHeader,
  RowDataPacket,
  createPool,
} from 'mysql2/promise';
import { SshTunnelService } from './ssh-tunnel.service';

type QueryResult = RowDataPacket[] | RowDataPacket[][] | ResultSetHeader;

type PingRow = RowDataPacket & {
  databaseName: string | null;
  now: Date | string;
  version: string;
};

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  private pool: Pool | null = null;

  // 注入配置服务和 SSH 隧道服务，统一管理数据库连接入口。
  constructor(
    private readonly configService: ConfigService,
    private readonly sshTunnelService: SshTunnelService,
  ) {}

  // 执行轻量查询，返回当前数据库连接状态和目标信息。
  async ping() {
    try {
      const rows = await this.query<PingRow[]>(
        'SELECT NOW() AS now, VERSION() AS version, DATABASE() AS databaseName',
      );
      const row = rows[0];

      return {
        ok: true,
        connectionMode: this.getConnectionMode(),
        host: this.getEffectiveHost(),
        port: this.getEffectivePort(),
        targetHost: this.getTargetHost(),
        targetPort: this.getTargetPort(),
        database:
          row?.databaseName ?? this.configService.get<string>('MYSQL_DATABASE'),
        serverTime: row?.now ?? null,
        version: row?.version ?? null,
      };
    } catch (error) {
      if (error instanceof ServiceUnavailableException) {
        throw error;
      }

      this.logger.error(
        `Failed to reach MySQL (${this.getConnectionMode()}) at ` +
          `${this.getTargetHost()}:${this.getTargetPort()}`,
        error instanceof Error ? error.stack : undefined,
      );

      const hint = this.sshTunnelService.isEnabled()
        ? 'Check MYSQL_SSH_* settings, the Docker service name, and database account permissions.'
        : 'Check Docker port mapping, cloud security group, and MySQL account permissions.';

      throw new ServiceUnavailableException(
        `Failed to reach MySQL (${this.getConnectionMode()}) at ` +
          `${this.getTargetHost()}:${this.getTargetPort()}. ${hint}`,
      );
    }
  }

  // 执行通用 SQL 查询，并复用同一个连接池。
  async query<T extends QueryResult>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T> {
    const pool = await this.getPool();
    const [result] = await pool.query<T>(sql, params);
    return result;
  }

  // 在模块销毁时主动关闭连接池，避免残留数据库连接。
  async onModuleDestroy() {
    if (!this.pool) {
      return;
    }

    await this.pool.end();
    this.pool = null;
  }

  // 按需初始化连接池，并在启用时先建立 SSH 隧道。
  private async getPool() {
    if (this.pool) {
      return this.pool;
    }

    const missingKeys: string[] = [];
    const user = this.configService.get<string>('MYSQL_USER');
    const password = this.configService.get<string>('MYSQL_PASSWORD');
    const database = this.configService.get<string>('MYSQL_DATABASE');

    if (!user) {
      missingKeys.push('MYSQL_USER');
    }

    if (password === undefined) {
      missingKeys.push('MYSQL_PASSWORD');
    }

    if (!database) {
      missingKeys.push('MYSQL_DATABASE');
    }

    if (missingKeys.length > 0) {
      throw new ServiceUnavailableException(
        `MySQL is not configured. Set ${missingKeys.join(', ')} in your .env file.`,
      );
    }

    // 1. 确保 SSH 隧道已经完全打通
    if (this.sshTunnelService.isEnabled()) {
      await this.sshTunnelService.ensureTunnel();
    }

    // 2. 🔥 【核心新增】在创建连接池之前，先用无库模式连接，自动创建数据库
    await this.ensureDatabaseExists(user!, password!, database!);

    // 3. 数据库有了之后，再放心地初始化真正的业务连接池
    this.pool = createPool({
      host: this.getEffectiveHost(),
      port: this.getEffectivePort(),
      user,
      password,
      database,
      waitForConnections: true,
      connectionLimit: this.getNumberEnv('MYSQL_CONNECTION_LIMIT', 10),
      connectTimeout: this.getNumberEnv('MYSQL_CONNECT_TIMEOUT', 10000),
      enableKeepAlive: true,
    });

    return this.pool;
  }

  // 🔥 【辅助方法】自动检查并创建数据库
  private async ensureDatabaseExists(
    user: string,
    password: string,
    databaseName: string,
  ) {
    const { createConnection } = await import('mysql2/promise');
    let tempConnection: Connection | undefined;
    try {
      // 先建立一个不带 database 参数的临时连接（只连到 MySQL 实例本身）
      tempConnection = await createConnection({
        host: this.getEffectiveHost(),
        port: this.getEffectivePort(),
        user,
        password,
        connectTimeout: 5000,
      });

      // 执行 SQL：如果数据库不存在，则用 utf8mb4 编码创建它
      await tempConnection.query(
        `CREATE DATABASE IF NOT EXISTS \`${databaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`,
      );

      this.logger.log(`✅ Database check passed: "${databaseName}" is ready.`);
    } catch (error) {
      this.logger.error(
        `❌ Failed to automatically create database "${databaseName}"`,
        error instanceof Error ? error.stack : undefined,
      );
      // 这里不强行阻断，把错误交给后面真正的连接池去暴露
    } finally {
      if (tempConnection) {
        await tempConnection.end(); // 务必关闭临时连接
      }
    }
  }

  // 返回当前数据库连接模式，便于日志和诊断接口复用。
  private getConnectionMode() {
    return this.sshTunnelService.isEnabled() ? 'ssh-tunnel' : 'direct';
  }

  // 读取数据库真实目标地址，不区分是否经过隧道。
  private getTargetHost() {
    return this.configService.get<string>('MYSQL_HOST', '47.101.53.36');
  }

  // 读取数据库真实目标端口，不区分是否经过隧道。
  private getTargetPort() {
    return this.getNumberEnv('MYSQL_PORT', 3306);
  }

  // 计算应用实际要连接的主机地址，隧道模式下改为本地监听地址。
  private getEffectiveHost() {
    if (this.sshTunnelService.isEnabled()) {
      return this.sshTunnelService.getLocalHost();
    }

    return this.getTargetHost();
  }

  // 计算应用实际要连接的端口，隧道模式下改为本地转发端口。
  private getEffectivePort() {
    if (this.sshTunnelService.isEnabled()) {
      return this.sshTunnelService.getLocalPort();
    }

    return this.getTargetPort();
  }

  // 读取并校验数值型环境变量，不合法时直接抛出配置异常。
  private getNumberEnv(key: string, fallback: number) {
    const rawValue = this.configService.get<string>(key);

    if (!rawValue) {
      return fallback;
    }

    const parsedValue = Number(rawValue);

    if (!Number.isInteger(parsedValue) || parsedValue <= 0) {
      throw new ServiceUnavailableException(
        `${key} must be a valid positive integer.`,
      );
    }

    return parsedValue;
  }
}
