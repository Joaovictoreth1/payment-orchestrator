FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-fund --no-audit
COPY tsconfig.json tsconfig.build.json ./
COPY backend/ backend/
COPY frontend/ frontend/
COPY scripts/ scripts/
RUN npm run build

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
COPY --from=build /app/package.json ./
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + process.env.PORT + '/health', {signal: AbortSignal.timeout(2000)}).then(r => { if (!r.ok) process.exitCode = 1; }).catch(() => { process.exitCode = 1; })"]
CMD ["node", "dist/main.js"]
