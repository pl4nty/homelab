# held on GHC 8.10 (Renovate's #1378 closed unmerged): codeworld-api 0.8.1, the last release, needs template-haskell <2.20 and bytestring <0.12
FROM haskell:8.10.7@sha256:5c365dc081a22550cb4ca62f99a574f8583e8405689aa6a9d89fb21fa13724e9 AS build

COPY cabal.config /etc/cabal/config
ENV CABAL_CONFIG=/etc/cabal/config
# per-arch cache: the store holds compiled code and both platforms build concurrently
ARG TARGETARCH
# each step updates the index itself: a remote layer-cache hit skips the RUN, so the mount can be empty

COPY --from=src *.cabal .
RUN --mount=type=cache,id=cabal-$TARGETARCH,target=/root/.cabal \
    cabal v2-update && cabal v2-build --only-dependencies

COPY --from=src . .
RUN --mount=type=cache,id=cabal-$TARGETARCH,target=/root/.cabal \
    cabal v2-update && cabal v2-build && \
    cp -r /root/.cabal /tmp
RUN mv /tmp/.cabal /root

ENTRYPOINT [ "cabal", "v2-run", "game", "--" ]
