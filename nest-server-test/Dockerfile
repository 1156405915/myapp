FROM node:22-alpine

# 安装 pnpm
RUN npm install -g pnpm@10.33.0

WORKDIR /app

# 1. 复制 pnpm 的依赖描述文件
COPY package.json pnpm-lock.yaml* ./

# 切换为国内阿里云/淘宝镜像源，确保依赖包极速下载
RUN pnpm config set registry https://registry.npmmirror.com

# 2. 使用 pnpm 安装依赖（--prod 表示只安装生产环境需要的包，不装 devDependencies）
RUN pnpm install

# 3. 复制剩下的所有业务代码
COPY . .

# 4. 核心步骤：执行打包编译（将 TS 编译为 dist 目录下的 JS）
RUN pnpm build

# 5. 清理掉开发依赖，只保留生产环境必需的包，极大地缩减镜像体积
# RUN pnpm prune --prod

EXPOSE 3000

# 4. 启动命令（如果你的 package.json 里配置的是 "start": "node app.js"）
CMD ["pnpm", "start"]
