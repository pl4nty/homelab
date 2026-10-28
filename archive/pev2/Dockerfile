FROM node:21.4.0 AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM joseluisq/static-web-server:2.24.1
COPY --from=build /app/dist-app /public
