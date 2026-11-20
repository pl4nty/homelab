FROM --platform=$BUILDPLATFORM node:26.13.1-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc AS build
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
# node 25+ no longer bundles corepack
RUN npm install -g corepack && corepack enable
COPY --from=src . /app
WORKDIR /app
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
RUN pnpm run build

FROM joseluisq/static-web-server:2.44.2@sha256:23be6c04d474979d6e738081918f5874f88502a150d1123fd000719101a0f05c
COPY --from=build /app/dist /public
