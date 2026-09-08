# -------------------------------------------------------------
# 构建阶段：极速安装生产依赖 (仅保留原生 ws 协议库，彻底移除重型依赖)
# -------------------------------------------------------------
FROM node:22-bookworm-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm config set registry https://registry.npmmirror.com && \
    npm install --omit=dev --no-audit && \
    rm -rf /root/.npm \
           node_modules/**/README.md \
           node_modules/**/CHANGELOG.md \
           node_modules/**/.github \
           node_modules/**/test \
           node_modules/**/tests \
           node_modules/**/examples

# -------------------------------------------------------------
# 运行环境：替换 Debian 国内镜像源 (阿里云)，精简至极致
# -------------------------------------------------------------
FROM node:22-bookworm-slim

WORKDIR /app

ENV TZ=Asia/Shanghai \
    PORT=8080 \
    CTYUN_DATA_DIR=/app/data

# 换用国内 Debian 镜像源 (优先阿里云，安全更新指向 debian-security) 并配置时区及必要根证书
RUN (sed -i 's/deb.debian.org/mirrors.aliyun.com/g' /etc/apt/sources.list.d/debian.sources 2>/dev/null || \
     sed -i 's/deb.debian.org/mirrors.aliyun.com/g' /etc/apt/sources.list 2>/dev/null || true) && \
    (sed -i 's/security.debian.org/mirrors.aliyun.com\/debian-security/g' /etc/apt/sources.list.d/debian.sources 2>/dev/null || \
     sed -i 's/security.debian.org/mirrors.aliyun.com\/debian-security/g' /etc/apt/sources.list 2>/dev/null || true) && \
    ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone && \
    apt-get update && apt-get install -y --no-install-recommends ca-certificates && \
    rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

# 从构建阶段仅拷贝瘦身后的 node_modules
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
COPY app ./app
COPY server.js ./

EXPOSE 8080

VOLUME ["/app/data"]

CMD ["node", "server.js"]
