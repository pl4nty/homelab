# held below gradle 9 (Renovate's #1407 closed unmerged): jpro 2022.1.4 can't resolve its javafx variants there, and 9 drops mainClassName
FROM gradle:8.14.5-jdk17@sha256:38cc14c6936a74fba051090399b592fec24a618174719a6a94b8b7e0e8c2632e AS build
WORKDIR /app

# only the paths the old .dockerignore allowed
COPY --from=src src src
# wildcard, so a repo without tests still builds
COPY --from=src tes[t]s tests
COPY build.gradle .
RUN gradle jproRelease --warning-mode all

# Ubuntu with required packages
# https://www.jpro.one/docs/current/2.7/PREPARING_LINUX_FOR_JPRO
FROM eclipse-temurin:17.0.20.1_1-jre-noble@sha256:b3e1d0486f09293b2455aed02d396d4b6b5ea9b0e8c7c065c297cfef453b0116

# prevent interactive prompt from debconf
RUN echo 'debconf debconf/frontend select Noninteractive' | debconf-set-selections \
&& apt-get update \
&& apt-get -y --no-install-recommends install xorg libasound2t64 libgtk2.0-0t64 unzip \
&& rm -rf /var/lib/apt/lists/*

COPY --from=build /app/build/distributions/app-jpro.zip .
RUN unzip app-jpro.zip -d . && rm app-jpro.zip

CMD ["./app-jpro/bin/start.sh"]
EXPOSE 8080
