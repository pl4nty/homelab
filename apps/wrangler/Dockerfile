FROM node:24.22.0@sha256:925de64a85319052d6971ae81ef2417da956e8a3a2c4a0fac732327970f017f5
WORKDIR /opt/wrangler
RUN --mount=type=cache,id=npm,target=/root/.npm \
    --mount=type=bind,source=package.json,target=package.json \
    --mount=type=bind,source=package-lock.json,target=package-lock.json \
    npm ci --omit=dev
ENV PATH=/opt/wrangler/node_modules/.bin:$PATH
WORKDIR /
ENTRYPOINT ["wrangler"]
