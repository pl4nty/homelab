FROM oven/bun:1.4.4-alpine@sha256:4cf82f5686b196504fe119db3fcd9185b191f82ece82c40680e597228ec6070a AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run typecheck && bun test && bun install --frozen-lockfile --production

FROM oven/bun:1.4.4-distroless@sha256:153a951ae40106e125898103e6e990ee0f38e6aee7f561029e26cf9fbed23470
WORKDIR /app
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/package.json /app/index.ts /app/events.ts ./
USER 65532
EXPOSE 8080
CMD ["index.ts"]
