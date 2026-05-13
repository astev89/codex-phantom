FROM node:24-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY src ./src
COPY README.md ./
COPY .env.example ./
COPY tsconfig.json ./
COPY tsconfig.build.json ./

RUN npm run build

FROM node:24-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY --from=build /app/dist ./dist
COPY README.md ./
COPY .env.example ./
COPY config ./config

RUN mkdir -p /app/data && chown -R node:node /app

ENV APP_ENV=production
ENV PORT=3210

EXPOSE 3210

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:$PORT/health').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/index.js"]
