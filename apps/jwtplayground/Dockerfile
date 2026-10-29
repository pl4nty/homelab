FROM node:24.22.0@sha256:925de64a85319052d6971ae81ef2417da956e8a3a2c4a0fac732327970f017f5
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
