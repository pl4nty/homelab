FROM --platform=$BUILDPLATFORM node:24.21.0@sha256:64af3819f9275802414d7cdc38c27e9d82bd564dec4d4da87d008255d36c63b4 AS build

WORKDIR /app
COPY --from=src package*.json ./
RUN --mount=type=cache,id=npm,target=/root/.npm npm ci

# conflict between webpack 4 and node >= 17: error:0308010C:digital envelope routines::unsupported
ENV NODE_OPTIONS=--openssl-legacy-provider
COPY --from=src . .
RUN ./node_modules/.bin/grunt build-website
RUN ./node_modules/.bin/grunt pug:website

FROM nginx:1.31.6@sha256:908dc23e643a1447dbfb2e189ed268bfde6a51a5bf9a34d3dd3440a24f58ccf7

COPY --from=build /app/dist/website /usr/share/nginx/html
