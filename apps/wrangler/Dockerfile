FROM node:24.21.0@sha256:64af3819f9275802414d7cdc38c27e9d82bd564dec4d4da87d008255d36c63b4
WORKDIR /opt/wrangler
RUN --mount=type=cache,id=npm,target=/root/.npm \
    --mount=type=bind,source=package.json,target=package.json \
    --mount=type=bind,source=package-lock.json,target=package-lock.json \
    npm ci --omit=dev
ENV PATH=/opt/wrangler/node_modules/.bin:$PATH
WORKDIR /
ENTRYPOINT ["wrangler"]
