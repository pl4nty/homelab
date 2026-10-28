FROM node:24.21.0@sha256:64af3819f9275802414d7cdc38c27e9d82bd564dec4d4da87d008255d36c63b4
WORKDIR /app

ENV NODE_ENV=production
COPY --from=src package*.json ./
RUN npm ci --omit=dev

COPY --from=src . .
COPY views views
# upstream bundles have no extension, so express serves them as application/octet-stream
RUN for f in public/bundles/*[0-9a-f]; do mv "$f" "$f.js"; done \
  && sed -Ei "s#(bundles/[a-z]+[0-9a-f]{4})'#\1.js'#" views/*.pug

CMD [ "node", "./bin/www" ]
EXPOSE 8080
