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
FROM eclipse-temurin:17.0.20.1_1-jre-noble@sha256:d1b6f76d8112c41f1068597741f0c0bda36d323365078e685381f72e5ec51ca0

# prevent interactive prompt from debconf
RUN echo 'debconf debconf/frontend select Noninteractive' | debconf-set-selections \
&& apt-get update \
&& apt-get -y --no-install-recommends install xorg libasound2t64 libgtk2.0-0t64 unzip \
&& rm -rf /var/lib/apt/lists/*

COPY --from=build /app/build/distributions/app-jpro.zip .
RUN unzip app-jpro.zip -d . && rm app-jpro.zip

CMD ["./app-jpro/bin/start.sh"]
EXPOSE 8080
