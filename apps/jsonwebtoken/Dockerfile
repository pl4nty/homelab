# upstream is now a Next.js app with a request proxy for language redirects, so it needs a server instead of nginx
FROM --platform=$BUILDPLATFORM node:26.13.0@sha256:438603bbb5cda404b9416f0b5c8026f61501ab911760d861ec28c36b5d675725 AS build

WORKDIR /app
COPY --from=src package*.json ./
RUN --mount=type=cache,id=npm,target=/root/.npm npm ci

COPY --from=src . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# native deps (sharp, swc) must match the target platform, so install them again without the build platform
FROM node:26.13.0@sha256:438603bbb5cda404b9416f0b5c8026f61501ab911760d861ec28c36b5d675725

WORKDIR /app
COPY --from=src package*.json ./
RUN --mount=type=cache,id=npm,target=/root/.npm npm ci --omit=dev

COPY --from=src . .
COPY --from=build --chown=node:node /app/.next .next
ENV NEXT_TELEMETRY_DISABLED=1 NODE_ENV=production
USER node
EXPOSE 8080
CMD [ "npx", "next", "start", "-p", "8080" ]
