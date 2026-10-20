# Fly.io, Railway, Google Cloud Run, 개인 서버 등 Docker를 지원하는 곳에 배포할 때 사용
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY shared ./shared
COPY server ./server
COPY client ./client
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
USER node
CMD ["node", "server/index.js"]
