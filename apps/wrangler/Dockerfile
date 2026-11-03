FROM node:26.12.0@sha256:45a2bf9d9300e9cf47ecb375e38447c140c45ef5fbae869c430475b05b98d86e
WORKDIR /opt/wrangler
RUN --mount=type=cache,id=npm,target=/root/.npm \
    --mount=type=bind,source=package.json,target=package.json \
    --mount=type=bind,source=package-lock.json,target=package-lock.json \
    npm ci --omit=dev
ENV PATH=/opt/wrangler/node_modules/.bin:$PATH
WORKDIR /
ENTRYPOINT ["wrangler"]
