# upstream's toolchain: preact-cli 3's esm loader fails on newer Node. the output is plain JS, so build once on the host platform
FROM --platform=$BUILDPLATFORM node:12.16.3-buster@sha256:80e0a4a1ad7c9303a7cb9ac0cd97c123182cfafe13b82d767a9acbdc8b5ca51b AS build
WORKDIR /app
COPY --from=src package.json yarn.lock ./
RUN --mount=type=cache,id=yarn-rctf-build,target=/usr/local/share/.cache/yarn,sharing=locked \
    yarn install --frozen-lockfile
COPY --from=src . .
COPY rctf.patch .
# team members log in as themselves, and flag submissions and logins are recorded per member
RUN git apply rctf.patch
RUN yarn build

# Node 12 reached end of life in 2022; the compiled server runs on 22
FROM node:22.23.4-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/yarn.lock /app/package.json ./
# the lockfile's engines fields predate Node 22
RUN --mount=type=cache,id=yarn-rctf,target=/usr/local/share/.cache/yarn,sharing=locked \
    yarn install --prod --frozen-lockfile --ignore-engines
COPY --from=build /app/dist dist
CMD ["node", "--enable-source-maps", "--unhandled-rejections=strict", "dist/server/index.js"]
