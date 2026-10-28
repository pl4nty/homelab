FROM node:22.19.0 AS build
WORKDIR /app

# puppeteer dependency can't install ARM chromium by default
# puppeteer/puppeteer#7740
RUN apt-get update
RUN apt-get install -y chromium && apt-get clean
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

COPY --from=src package*.json ./
RUN npm ci

COPY --from=src . .
RUN npm run build --if-present

FROM joseluisq/static-web-server:2.38.0

COPY --from=build /app/Pages /public/Pages
COPY --from=build /app/Pages/mha.html /public/index.html
