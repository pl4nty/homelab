FROM steamcmd/steamcmd:ubuntu-24@sha256:013d2e46939d8b5e9d116839dca0ab3f126c58ccf2ebee66b298804a5e7337ce AS steamclient
# app 1007 is the Steamworks SDK redistributable, which has the steamclient.so game servers load
RUN steamcmd +force_install_dir /redist +login anonymous +app_update 1007 validate +quit

FROM gradle:9.8.2-jdk25@sha256:e46e15353757ef9c9be0197a243653e88d25ebcd4c3c841057cf839c11fcf898 AS build
WORKDIR /app
COPY . .
COPY --from=sdk redistributable_bin/linux64/libsteam_api.so redistributable_bin/win64/steam_api64.dll redistributable_bin/osx/libsteam_api.dylib bridge/src/main/resources/natives/
RUN --mount=type=cache,target=/home/gradle/.gradle/caches gradle build --no-daemon --warning-mode all

FROM eclipse-temurin:25.0.5_8-jre-noble@sha256:a98128a57de944a72bd31fbc79b898edd5a5864d3652071d5bbd2160ab7d7dce
WORKDIR /app
COPY --from=steamclient /redist/linux64/steamclient.so steam/
COPY --from=build /app/bridge/build/libs/bridge-*.jar minecraft-sdr.jar
COPY --from=build /app/fabric/build/libs/minecraft-sdr-fabric-*[0-9].jar public/minecraft-sdr-fabric.jar
COPY --from=build /app/bridge/build/libs/bridge-*.jar public/minecraft-sdr.jar
ENV LD_LIBRARY_PATH=/app/steam
USER 1000
ENTRYPOINT ["java", "-jar", "/app/minecraft-sdr.jar"]
CMD ["serve", "minecraft:25565", "8080", "/app/public"]
EXPOSE 8080
