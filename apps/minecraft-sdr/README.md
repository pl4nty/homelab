# minecraft-sdr

Joins a Minecraft server through Valve's [Steam Datagram Relay](https://partner.steamgames.com/doc/features/multiplayer/steamdatagramrelay) (SDR), so the server needs no open ports and players never see its IP.

Both ends log on as anonymous Steam game servers on Spacewar (app 480) and talk P2P over SDR, with ICE disabled so traffic always goes through Valve's relays. Each SDR connection carries one Minecraft TCP connection.

## Players

1. Install Steam. It doesn't need to be running or signed in. The mod loads Steam's `steamclient` library.
2. Install [Fabric Loader](https://fabricmc.net/use/installer/) for Minecraft 26.3 and put `minecraft-sdr-fabric.jar` from `https://minecraft.tplant.com.au/minecraft-sdr-fabric.jar` in `mods/`. It doesn't need Fabric API.
3. Add the server `minecraft.tplant.com.au.sdr`.

Without mods, run `java -jar minecraft-sdr.jar connect minecraft.tplant.com.au` (Java 25) and add `localhost` instead.

Clients need x86_64 Windows or Linux, or macOS.

## Server

`java -jar minecraft-sdr.jar serve <minecraft host:port> <http port> <download dir>` forwards SDR connections to the Minecraft server. Its HTTP port serves the download dir and `/steam-id`, the game server's Steam ID, which changes on every logon. A `<host>.sdr` address reads it from `https://<host>/steam-id`, and `<steam id>.sdr` skips the lookup.

Valve only ships `steamclient.so` for x86_64, so the image is amd64 only.
