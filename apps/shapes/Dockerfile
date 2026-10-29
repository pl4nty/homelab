FROM haskell:8.10.7@sha256:5c365dc081a22550cb4ca62f99a574f8583e8405689aa6a9d89fb21fa13724e9 AS build

COPY cabal.config /etc/cabal/config
ENV CABAL_CONFIG=/etc/cabal/config
# per-arch cache: the store holds compiled code and both platforms build concurrently
ARG TARGETARCH

RUN --mount=type=cache,id=cabal-$TARGETARCH,target=/root/.cabal \
    cabal v2-update

COPY *.cabal .
RUN --mount=type=cache,id=cabal-$TARGETARCH,target=/root/.cabal \
    cabal v2-build --only-dependencies

COPY --from=src . .
COPY *.cabal .
RUN --mount=type=cache,id=cabal-$TARGETARCH,target=/root/.cabal \
    cabal v2-build && \
    cp -r /root/.cabal /tmp
RUN mv /tmp/.cabal /root

ENTRYPOINT [ "cabal", "v2-run" ]
