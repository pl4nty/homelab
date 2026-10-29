FROM node:24.21.0@sha256:3d27e5c11e5786e309ec3e03f93ae536eb36e6e5eb3714d5eb3300a36157add0
WORKDIR /opt/wrangler
RUN --mount=type=cache,id=npm,target=/root/.npm \
    --mount=type=bind,source=package.json,target=package.json \
    --mount=type=bind,source=package-lock.json,target=package-lock.json \
    npm ci --omit=dev
ENV PATH=/opt/wrangler/node_modules/.bin:$PATH
WORKDIR /
ENTRYPOINT ["wrangler"]
