FROM node:26.12.1@sha256:97fa0f1b59035c6072721a88d55be1371c7cb1cc942b521e1cc5c72ec87655f4
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
