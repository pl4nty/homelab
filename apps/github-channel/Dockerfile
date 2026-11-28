FROM --platform=$BUILDPLATFORM oven/bun:1.4.4-alpine@sha256:4cf82f5686b196504fe119db3fcd9185b191f82ece82c40680e597228ec6070a AS build
WORKDIR /src
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run typecheck && bun test \
 && for target in windows-x64 linux-x64 linux-arm64 darwin-arm64; do \
      bun build index.ts --compile --minify --target=bun-$target --outfile=/out/github-channel-$target; \
    done

FROM scratch
COPY --from=build /out/ /
