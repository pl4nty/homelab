FROM oven/bun:1.4.4-distroless@sha256:153a951ae40106e125898103e6e990ee0f38e6aee7f561029e26cf9fbed23470
WORKDIR /app
COPY ms-roots.pem ./
COPY public/ public/
COPY src/ src/
# the DO services chain to the Microsoft ECC Product Root 2018, and FE3 to the Microsoft Root 2011
ENV NODE_EXTRA_CA_CERTS=/app/ms-roots.pem
USER 65532
EXPOSE 8080
CMD ["src/server.ts"]
