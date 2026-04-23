FROM node:24-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY README.md ./
COPY .env.example ./
COPY tsconfig.json ./

ENV APP_ENV=production
ENV PORT=3210

EXPOSE 3210

CMD ["node", "--experimental-strip-types", "src/index.ts"]
