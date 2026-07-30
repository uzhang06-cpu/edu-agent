FROM node:20-slim

WORKDIR /app

# 先装依赖（利用 Docker 缓存层）
COPY package*.json ./
RUN npm ci --omit=dev

# 再拷贝源码
COPY . .

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
