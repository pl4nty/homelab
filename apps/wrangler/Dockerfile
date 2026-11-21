FROM node:26.13.1@sha256:e18c3ccdf7d71619990b0e85639f506e2028a95410999cab24cc373cbd10e0ac
WORKDIR /opt/wrangler
RUN --mount=type=cache,id=npm,target=/root/.npm \
    --mount=type=bind,source=package.json,target=package.json \
    --mount=type=bind,source=package-lock.json,target=package-lock.json \
    npm ci --omit=dev
ENV PATH=/opt/wrangler/node_modules/.bin:$PATH
WORKDIR /
ENTRYPOINT ["wrangler"]
