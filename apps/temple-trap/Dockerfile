FROM gradle:9.8.1-jdk17@sha256:47f780b3062115192d991c37276702c515a1349be5c288fd5ee422b408503fa9 AS build
WORKDIR /app

# only the paths the old .dockerignore allowed
COPY --from=src src src
# wildcard, so a repo without tests still builds
COPY --from=src tes[t]s tests
COPY build.gradle .
RUN gradle jproRelease --warning-mode all

# Ubuntu with required packages
# https://www.jpro.one/docs/current/2.7/PREPARING_LINUX_FOR_JPRO
# jpro 2026 bundles JavaFX 27, which needs Java 25
FROM eclipse-temurin:25.0.5_8-jre-noble@sha256:a98128a57de944a72bd31fbc79b898edd5a5864d3652071d5bbd2160ab7d7dce

# prevent interactive prompt from debconf
RUN echo 'debconf debconf/frontend select Noninteractive' | debconf-set-selections \
&& apt-get update \
&& apt-get -y --no-install-recommends install xorg libasound2t64 libgtk-3-0t64 unzip \
&& rm -rf /var/lib/apt/lists/*

COPY --from=build /app/build/distributions/app-jpro.zip .
RUN unzip app-jpro.zip -d . && rm app-jpro.zip

CMD ["./app-jpro/bin/start.sh"]
EXPOSE 8080
