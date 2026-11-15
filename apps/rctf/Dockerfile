# rebuilds the two outputs rctf.patch changes, the API bundle and the web build, with upstream's steps
# from deploy/rctf/Dockerfile. the patch adds no dependencies, so the base image's node_modules still match
FROM --platform=$BUILDPLATFORM oven/bun:1.4.4-alpine@sha256:4cf82f5686b196504fe119db3fcd9185b191f82ece82c40680e597228ec6070a AS build
RUN apk add --no-cache git
WORKDIR /app
COPY --from=src . .
COPY rctf.patch /tmp/
# records which browser sent each submission
RUN git apply /tmp/rctf.patch
RUN bun install \
    --frozen-lockfile \
    --linker=hoisted \
    --backend=copyfile \
    --no-cache \
    --filter '!@rctf/admin-bot' \
    --filter '!@rctf/docs' \
    --filter '!server-tests' \
    --filter '!admin-bot-tests' \
    --filter '!admin-bot-e2e-tests'
ENV NODE_ENV=production
RUN bun run --filter '@rctf/api' build && bun run --filter '@rctf/web' build

# the published image of the src commit, so nginx, supervisord, the entrypoint and the CLI stay upstream's
FROM ghcr.io/otter-sec/rctf:v2.1.6@sha256:a3583ab9ded9fd81933a0eadc7f043c0166ab55bbf98ee2d8099ed1def3e2ed3
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/web/build ./static
