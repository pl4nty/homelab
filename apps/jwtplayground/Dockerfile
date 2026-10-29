FROM node:24.21.0@sha256:3d27e5c11e5786e309ec3e03f93ae536eb36e6e5eb3714d5eb3300a36157add0
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
