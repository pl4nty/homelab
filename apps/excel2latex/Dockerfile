FROM node:24.12.0 AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM joseluisq/static-web-server:2.40.1

COPY --from=build /app/dist /public
