FROM node:26.13.1@sha256:e18c3ccdf7d71619990b0e85639f506e2028a95410999cab24cc373cbd10e0ac
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
