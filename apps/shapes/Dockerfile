FROM haskell:9.12.2@sha256:0dabe39ff7116832afd8219ce4ef9e7b35f5ba7bb779c83da83fa0195ee9c73f AS build

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
