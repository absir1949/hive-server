FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy && npm ci --omit=dev

COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
