FROM --platform=$BUILDPLATFORM node:26.12.0@sha256:45a2bf9d9300e9cf47ecb375e38447c140c45ef5fbae869c430475b05b98d86e AS build

WORKDIR /app
COPY --from=src package*.json ./
RUN --mount=type=cache,id=npm,target=/root/.npm npm ci

# conflict between webpack 4 and node >= 17: error:0308010C:digital envelope routines::unsupported
ENV NODE_OPTIONS=--openssl-legacy-provider
COPY --from=src . .
RUN ./node_modules/.bin/grunt build-website
RUN ./node_modules/.bin/grunt pug:website

FROM nginx:1.31.7@sha256:8632b3314d74c61f0e27f59055bab13f7793b988c94c090154d867bc29e0f39b

COPY --from=build /app/dist/website /usr/share/nginx/html
