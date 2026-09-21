FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY public ./public
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    CMCC_DATABASE_PATH=/app/data/cmcc-webhook.sqlite \
    ACCESS_LOG_PATH=/app/logs/access.log
RUN apk add --no-cache su-exec
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh && mkdir -p /app/data /app/logs
EXPOSE 3000
VOLUME ["/app/data", "/app/logs"]
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/server.js"]
