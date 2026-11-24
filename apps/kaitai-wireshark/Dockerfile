# Runs the tests against tshark (Debian trixie: Wireshark 4.4, Lua 5.4) and ships an example dissector in dist/.
FROM --platform=$BUILDPLATFORM node:26.13.1-trixie-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc AS build
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends tshark \
  && rm -rf /var/lib/apt/lists/* \
  && tshark --version | grep -q 'Lua 5\.[34]'
# specs for the cross-checks in test/formats
# renovate: branch=master
ADD https://github.com/pl4nty/kaitai_struct_formats.git#8d8353c5059e6cff0d9500313d6650000aab92c2 /ksf
WORKDIR /src
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY --chown=node:node . .
# tshark won't load Lua plugins as root
USER node
ENV KSF_DIR=/ksf KAITAI_WIRESHARK_REQUIRE=1
RUN npm run typecheck && npm test
RUN mkdir -p /tmp/dist \
  && node --experimental-strip-types --no-warnings bin/ksy2wireshark.ts test/fixtures/do_peer.ksy -o /tmp/dist/do_peer.lua --ksy-uri ''

FROM scratch
COPY --from=build /tmp/dist/ /
