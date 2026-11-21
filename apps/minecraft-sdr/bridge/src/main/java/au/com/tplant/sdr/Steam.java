package au.com.tplant.sdr;

import static java.lang.foreign.ValueLayout.ADDRESS;
import static java.lang.foreign.ValueLayout.JAVA_BOOLEAN;
import static java.lang.foreign.ValueLayout.JAVA_BYTE;
import static java.lang.foreign.ValueLayout.JAVA_INT;
import static java.lang.foreign.ValueLayout.JAVA_LONG;
import static java.lang.foreign.ValueLayout.JAVA_SHORT;

import java.io.IOException;
import java.io.InputStream;
import java.lang.foreign.Arena;
import java.lang.foreign.FunctionDescriptor;
import java.lang.foreign.Linker;
import java.lang.foreign.MemoryLayout;
import java.lang.foreign.MemorySegment;
import java.lang.foreign.SymbolLookup;
import java.lang.invoke.MethodHandle;
import java.lang.invoke.MethodHandles;
import java.lang.invoke.MethodType;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;

public final class Steam {
  public static final int APP_ID = 480;

  static final int STATE_CONNECTING = 1;
  static final int STATE_CONNECTED = 3;
  static final int STATE_CLOSED_BY_PEER = 4;
  static final int STATE_PROBLEM = 5;

  static final int RESULT_OK = 1;
  static final int RESULT_LIMIT_EXCEEDED = 25;

  static final int SEND_RELIABLE_NO_NAGLE = 9;

  private static final int AVAILABILITY_CURRENT = 100;
  private static final int CONFIG_SEND_BUFFER_SIZE = 9;
  private static final int CONFIG_P2P_ICE_ENABLE = 104;
  private static final int DEBUG_WARNING = 4;
  private static final int SERVER_MODE_NO_AUTHENTICATION = 1;
  private static final short QUERY_PORT_SHARED = (short) 0xffff;
  private static final long IDENTITY_BYTES = 136;
  private static final long INFO_BYTES = 696;
  private static final long INFO_LISTEN = 144;
  private static final long INFO_STATE = 176;
  private static final long INFO_END_DEBUG = 184;
  private static final int MESSAGE_BATCH = 64;

  private static final String INTERFACE_VERSIONS =
      String.join(
              "\0",
              "SteamUtils011",
              "SteamNetworkingUtils004",
              "SteamGameServer015",
              "SteamGameServerStats001",
              "STEAMHTTP_INTERFACE_VERSION003",
              "STEAMINVENTORY_INTERFACE_V003",
              "SteamNetworking006",
              "SteamNetworkingMessages002",
              "SteamNetworkingSockets013",
              "STEAMUGC_INTERFACE_VERSION021")
          + "\0";

  private static final System.Logger LOG = System.getLogger("minecraft-sdr");
  private static Steam instance;

  public interface Listener {
    void onStatus(int connection, int state, String reason);

    void onMessage(byte[] data);
  }

  public interface Acceptor {
    Listener accept(int connection);
  }

  private final Linker linker = Linker.nativeLinker();
  private final Arena arena = Arena.global();
  private final SymbolLookup lib;
  private final MemorySegment server;
  private final MemorySegment sockets;
  private final MemorySegment utils;
  private final int pollGroup;
  private final Map<Integer, Listener> listeners = new ConcurrentHashMap<>();
  private final Map<Integer, Acceptor> acceptors = new ConcurrentHashMap<>();
  private final MemorySegment info = arena.allocate(INFO_BYTES, 8);

  private final MethodHandle runCallbacks;
  private final MethodHandle socketsRunCallbacks;
  private final MethodHandle receiveOnPollGroup;
  private final MethodHandle messageRelease;
  private final MethodHandle sendMessage;
  private final MethodHandle getConnectionInfo;
  private final MethodHandle acceptConnection;
  private final MethodHandle closeConnection;
  private final MethodHandle setPollGroup;
  private final MethodHandle createListenSocket;
  private final MethodHandle connectP2P;
  private final MethodHandle identityClear;
  private final MethodHandle identitySetSteamId;
  private final MethodHandle loggedOn;
  private final MethodHandle getSteamId;
  private final MethodHandle relayStatus;

  private Steam(Path library) throws IOException {
    lib = SymbolLookup.libraryLookup(library, arena);

    runCallbacks = handle("SteamGameServer_RunCallbacks", FunctionDescriptor.ofVoid());
    socketsRunCallbacks = handle("SteamAPI_ISteamNetworkingSockets_RunCallbacks", FunctionDescriptor.ofVoid(ADDRESS));
    receiveOnPollGroup =
        handle(
            "SteamAPI_ISteamNetworkingSockets_ReceiveMessagesOnPollGroup",
            FunctionDescriptor.of(JAVA_INT, ADDRESS, JAVA_INT, ADDRESS, JAVA_INT));
    messageRelease = handle("SteamAPI_SteamNetworkingMessage_t_Release", FunctionDescriptor.ofVoid(ADDRESS));
    sendMessage =
        handle(
            "SteamAPI_ISteamNetworkingSockets_SendMessageToConnection",
            FunctionDescriptor.of(JAVA_INT, ADDRESS, JAVA_INT, ADDRESS, JAVA_INT, JAVA_INT, ADDRESS));
    getConnectionInfo =
        handle(
            "SteamAPI_ISteamNetworkingSockets_GetConnectionInfo",
            FunctionDescriptor.of(JAVA_BOOLEAN, ADDRESS, JAVA_INT, ADDRESS));
    acceptConnection =
        handle("SteamAPI_ISteamNetworkingSockets_AcceptConnection", FunctionDescriptor.of(JAVA_INT, ADDRESS, JAVA_INT));
    closeConnection =
        handle(
            "SteamAPI_ISteamNetworkingSockets_CloseConnection",
            FunctionDescriptor.of(JAVA_BOOLEAN, ADDRESS, JAVA_INT, JAVA_INT, ADDRESS, JAVA_BOOLEAN));
    setPollGroup =
        handle(
            "SteamAPI_ISteamNetworkingSockets_SetConnectionPollGroup",
            FunctionDescriptor.of(JAVA_BOOLEAN, ADDRESS, JAVA_INT, JAVA_INT));
    createListenSocket =
        handle(
            "SteamAPI_ISteamNetworkingSockets_CreateListenSocketP2P",
            FunctionDescriptor.of(JAVA_INT, ADDRESS, JAVA_INT, JAVA_INT, ADDRESS));
    connectP2P =
        handle(
            "SteamAPI_ISteamNetworkingSockets_ConnectP2P",
            FunctionDescriptor.of(JAVA_INT, ADDRESS, ADDRESS, JAVA_INT, JAVA_INT, ADDRESS));
    identityClear = handle("SteamAPI_SteamNetworkingIdentity_Clear", FunctionDescriptor.ofVoid(ADDRESS));
    identitySetSteamId =
        handle("SteamAPI_SteamNetworkingIdentity_SetSteamID64", FunctionDescriptor.ofVoid(ADDRESS, JAVA_LONG));
    loggedOn = handle("SteamAPI_ISteamGameServer_BLoggedOn", FunctionDescriptor.of(JAVA_BOOLEAN, ADDRESS));
    getSteamId = handle("SteamAPI_ISteamGameServer_GetSteamID", FunctionDescriptor.of(JAVA_LONG, ADDRESS));
    relayStatus =
        handle(
            "SteamAPI_ISteamNetworkingUtils_GetRelayNetworkStatus",
            FunctionDescriptor.of(JAVA_INT, ADDRESS, ADDRESS));

    MemorySegment error = arena.allocate(1024);
    int result;
    try {
      result =
          (int)
              handle(
                      "SteamInternal_GameServer_Init_V2",
                      FunctionDescriptor.of(
                          JAVA_INT, JAVA_INT, JAVA_SHORT, JAVA_SHORT, JAVA_INT, ADDRESS, ADDRESS, ADDRESS))
                  .invokeExact(
                      0,
                      (short) 0,
                      QUERY_PORT_SHARED,
                      SERVER_MODE_NO_AUTHENTICATION,
                      arena.allocateFrom("1.0.0.0"),
                      arena.allocateFrom(INTERFACE_VERSIONS),
                      error);
    } catch (Throwable e) {
      throw new IOException(e);
    }
    if (result != 0) {
      throw new IOException("Steam game server init failed (" + result + "): " + error.getString(0));
    }

    try {
      server =
          (MemorySegment) handle("SteamAPI_SteamGameServer_v015", FunctionDescriptor.of(ADDRESS)).invokeExact();
      sockets =
          (MemorySegment)
              handle("SteamAPI_SteamGameServerNetworkingSockets_SteamAPI_v013", FunctionDescriptor.of(ADDRESS))
                  .invokeExact();
      utils =
          (MemorySegment)
              handle(
                      "SteamInternal_FindOrCreateGameServerInterface",
                      FunctionDescriptor.of(ADDRESS, JAVA_INT, ADDRESS))
                  .invokeExact(0, arena.allocateFrom("SteamNetworkingUtils004"));

      MethodHandle setString = handle("SteamAPI_ISteamGameServer_SetProduct", FunctionDescriptor.ofVoid(ADDRESS, ADDRESS));
      setString.invokeExact(server, arena.allocateFrom("SpaceWar"));
      handle("SteamAPI_ISteamGameServer_SetModDir", FunctionDescriptor.ofVoid(ADDRESS, ADDRESS))
          .invokeExact(server, arena.allocateFrom("spacewar"));
      handle("SteamAPI_ISteamGameServer_SetGameDescription", FunctionDescriptor.ofVoid(ADDRESS, ADDRESS))
          .invokeExact(server, arena.allocateFrom("Minecraft"));
      handle("SteamAPI_ISteamGameServer_SetDedicatedServer", FunctionDescriptor.ofVoid(ADDRESS, JAVA_BOOLEAN))
          .invokeExact(server, true);

      MethodHandle setInt =
          handle(
              "SteamAPI_ISteamNetworkingUtils_SetGlobalConfigValueInt32",
              FunctionDescriptor.of(JAVA_BOOLEAN, ADDRESS, JAVA_INT, JAVA_INT));
      boolean ok = (boolean) setInt.invokeExact(utils, CONFIG_P2P_ICE_ENABLE, 0);
      ok = (boolean) setInt.invokeExact(utils, CONFIG_SEND_BUFFER_SIZE, 4 * 1024 * 1024);

      MemorySegment debug =
          linker.upcallStub(
              MethodHandles.lookup()
                  .findStatic(Steam.class, "onDebug", MethodType.methodType(void.class, int.class, MemorySegment.class)),
              FunctionDescriptor.ofVoid(JAVA_INT, ADDRESS),
              arena);
      handle(
              "SteamAPI_ISteamNetworkingUtils_SetDebugOutputFunction",
              FunctionDescriptor.ofVoid(ADDRESS, JAVA_INT, ADDRESS))
          .invokeExact(utils, DEBUG_WARNING, debug);

      MemorySegment status =
          linker.upcallStub(
              MethodHandles.lookup()
                  .bind(this, "onStatusChanged", MethodType.methodType(void.class, MemorySegment.class)),
              FunctionDescriptor.ofVoid(ADDRESS),
              arena);
      ok =
          (boolean)
              handle(
                      "SteamAPI_ISteamNetworkingUtils_SetGlobalCallback_SteamNetConnectionStatusChanged",
                      FunctionDescriptor.of(JAVA_BOOLEAN, ADDRESS, ADDRESS))
                  .invokeExact(utils, status);

      pollGroup =
          (int)
              handle("SteamAPI_ISteamNetworkingSockets_CreatePollGroup", FunctionDescriptor.of(JAVA_INT, ADDRESS))
                  .invokeExact(sockets);

      handle("SteamAPI_ISteamGameServer_LogOnAnonymous", FunctionDescriptor.ofVoid(ADDRESS)).invokeExact(server);
      handle("SteamAPI_ISteamNetworkingUtils_InitRelayNetworkAccess", FunctionDescriptor.ofVoid(ADDRESS))
          .invokeExact(utils);
    } catch (IOException e) {
      throw e;
    } catch (Throwable e) {
      throw new IOException(e);
    }

    Thread pump = Thread.ofPlatform().daemon().name("steam-sdr").start(this::pump);
    pump.setUncaughtExceptionHandler((t, e) -> LOG.log(System.Logger.Level.ERROR, "Steam pump died", e));
  }

  public static synchronized Steam get() throws IOException {
    if (instance == null) {
      Path library = Natives.prepare();
      instance = new Steam(library);
    }
    return instance;
  }

  private MethodHandle handle(String name, FunctionDescriptor descriptor) throws IOException {
    Optional<MemorySegment> symbol = lib.find(name);
    if (symbol.isEmpty()) {
      throw new IOException("Steam API symbol missing: " + name);
    }
    return linker.downcallHandle(symbol.get(), descriptor);
  }

  private static void onDebug(int type, MemorySegment message) {
    LOG.log(
        type <= 2 ? System.Logger.Level.ERROR : System.Logger.Level.WARNING,
        message.reinterpret(Integer.MAX_VALUE).getString(0));
  }

  private void onStatusChanged(MemorySegment callback) {
    try {
      int connection = callback.reinterpret(4).get(JAVA_INT, 0);
      if (!(boolean) getConnectionInfo.invokeExact(sockets, connection, info)) {
        return;
      }
      int listen = info.get(JAVA_INT, INFO_LISTEN);
      int state = info.get(JAVA_INT, INFO_STATE);
      String reason = info.getString(INFO_END_DEBUG);
      Listener listener = listeners.get(connection);
      if (listener == null && state == STATE_CONNECTING && listen != 0) {
        Acceptor acceptor = acceptors.get(listen);
        if (acceptor != null) {
          listener = acceptor.accept(connection);
          listeners.put(connection, listener);
          boolean grouped = (boolean) setPollGroup.invokeExact(sockets, connection, pollGroup);
          int accepted = (int) acceptConnection.invokeExact(sockets, connection);
          if (accepted != RESULT_OK) {
            LOG.log(System.Logger.Level.WARNING, "accept " + connection + " failed: " + accepted);
          }
        }
      }
      if (listener == null) {
        return;
      }
      listener.onStatus(connection, state, reason);
      if (state == STATE_CLOSED_BY_PEER || state == STATE_PROBLEM) {
        close(connection, reason);
      }
    } catch (Throwable e) {
      LOG.log(System.Logger.Level.ERROR, "status callback failed", e);
    }
  }

  private void pump() {
    MemorySegment messages = Arena.ofAuto().allocate(MemoryLayout.sequenceLayout(MESSAGE_BATCH, ADDRESS));
    while (true) {
      try {
        synchronized (this) {
          runCallbacks.invokeExact();
          socketsRunCallbacks.invokeExact(sockets);
        }
        int count = (int) receiveOnPollGroup.invokeExact(sockets, pollGroup, messages, MESSAGE_BATCH);
        for (int i = 0; i < count; i++) {
          MemorySegment message = messages.getAtIndex(ADDRESS, i).reinterpret(16);
          MemorySegment data = message.get(ADDRESS, 0);
          int size = message.get(JAVA_INT, 8);
          int connection = message.get(JAVA_INT, 12);
          byte[] bytes = data.reinterpret(size).toArray(JAVA_BYTE);
          messageRelease.invokeExact(message);
          Listener listener = listeners.get(connection);
          if (listener != null) {
            listener.onMessage(bytes);
          }
        }
        if (count == 0) {
          Thread.sleep(2);
        }
      } catch (InterruptedException e) {
        return;
      } catch (Throwable e) {
        LOG.log(System.Logger.Level.ERROR, "Steam pump error", e);
      }
    }
  }

  public long awaitReady(long timeoutMillis) throws IOException, InterruptedException {
    long deadline = System.nanoTime() + timeoutMillis * 1_000_000;
    while (true) {
      try {
        boolean on = (boolean) loggedOn.invokeExact(server);
        int relay = (int) relayStatus.invokeExact(utils, MemorySegment.NULL);
        if (on && relay == AVAILABILITY_CURRENT) {
          return (long) getSteamId.invokeExact(server);
        }
      } catch (Throwable e) {
        throw new IOException(e);
      }
      if (System.nanoTime() >= deadline) {
        throw new IOException("timed out waiting for Steam logon and relay network");
      }
      Thread.sleep(100);
    }
  }

  public void listen(Acceptor acceptor) throws IOException {
    try {
      int socket = (int) createListenSocket.invokeExact(sockets, 0, 0, MemorySegment.NULL);
      if (socket == 0) {
        throw new IOException("CreateListenSocketP2P failed");
      }
      acceptors.put(socket, acceptor);
    } catch (IOException e) {
      throw e;
    } catch (Throwable e) {
      throw new IOException(e);
    }
  }

  public int connect(long steamId, Listener listener) throws IOException {
    try (Arena call = Arena.ofConfined()) {
      MemorySegment identity = call.allocate(IDENTITY_BYTES, 8);
      identityClear.invokeExact(identity);
      identitySetSteamId.invokeExact(identity, steamId);
      synchronized (this) {
        int connection = (int) connectP2P.invokeExact(sockets, identity, 0, 0, MemorySegment.NULL);
        if (connection == 0) {
          throw new IOException("ConnectP2P failed");
        }
        listeners.put(connection, listener);
        boolean grouped = (boolean) setPollGroup.invokeExact(sockets, connection, pollGroup);
        return connection;
      }
    } catch (IOException e) {
      throw e;
    } catch (Throwable e) {
      throw new IOException(e);
    }
  }

  int send(int connection, MemorySegment data, int length) {
    try {
      return (int) sendMessage.invokeExact(sockets, connection, data, length, SEND_RELIABLE_NO_NAGLE, MemorySegment.NULL);
    } catch (Throwable e) {
      throw new IllegalStateException(e);
    }
  }

  public void close(int connection, String reason) {
    listeners.remove(connection);
    try (Arena call = Arena.ofConfined()) {
      boolean ok = (boolean) closeConnection.invokeExact(sockets, connection, 0, call.allocateFrom(reason), true);
    } catch (Throwable e) {
      LOG.log(System.Logger.Level.WARNING, "close " + connection + " failed", e);
    }
  }

  static final class Natives {
    private Natives() {}

    static Path prepare() throws IOException {
      String os = System.getProperty("os.name").toLowerCase();
      String arch = System.getProperty("os.arch");
      if (!arch.equals("amd64") && !arch.equals("x86_64") && !os.contains("mac")) {
        throw new IOException("Steam networking needs x86_64, not " + arch);
      }
      String name;
      if (os.contains("win")) {
        name = "steam_api64.dll";
      } else if (os.contains("mac")) {
        name = "libsteam_api.dylib";
      } else {
        name = "libsteam_api.so";
      }
      setenv("SteamAppId", Integer.toString(APP_ID));
      setenv("SteamGameId", Integer.toString(APP_ID));
      if (os.contains("win")) {
        Optional<Path> steam = windowsSteamPath();
        if (steam.isEmpty() || !Files.exists(steam.get().resolve("steamclient64.dll"))) {
          throw new IOException("Steam is not installed: steamclient64.dll not found");
        }
        windowsDllDirectory(steam.get());
      }
      Path override = Optional.ofNullable(System.getenv("STEAM_API_LIBRARY")).map(Path::of).orElse(null);
      if (override != null) {
        return override;
      }
      Path dir = Files.createTempDirectory("minecraft-sdr");
      Path target = dir.resolve(name);
      try (InputStream in = Steam.class.getResourceAsStream("/natives/" + name)) {
        if (in == null) {
          throw new IOException("bundled " + name + " missing");
        }
        Files.copy(in, target, StandardCopyOption.REPLACE_EXISTING);
      }
      target.toFile().deleteOnExit();
      dir.toFile().deleteOnExit();
      return target;
    }

    private static void setenv(String key, String value) throws IOException {
      Linker linker = Linker.nativeLinker();
      try (Arena call = Arena.ofConfined()) {
        if (System.getProperty("os.name").toLowerCase().contains("win")) {
          SymbolLookup kernel32 = SymbolLookup.libraryLookup("kernel32", Arena.global());
          MethodHandle set =
              linker.downcallHandle(
                  kernel32.find("SetEnvironmentVariableW").orElseThrow(),
                  FunctionDescriptor.of(JAVA_INT, ADDRESS, ADDRESS));
          int ok = (int) set.invokeExact(wide(call, key), wide(call, value));
          MethodHandle putenv =
              linker.downcallHandle(
                  SymbolLookup.libraryLookup("ucrtbase", Arena.global()).find("_putenv_s").orElseThrow(),
                  FunctionDescriptor.of(JAVA_INT, ADDRESS, ADDRESS));
          int crt = (int) putenv.invokeExact(call.allocateFrom(key), call.allocateFrom(value));
        } else {
          MethodHandle set =
              linker.downcallHandle(
                  linker.defaultLookup().find("setenv").orElseThrow(),
                  FunctionDescriptor.of(JAVA_INT, ADDRESS, ADDRESS, JAVA_INT));
          int ok = (int) set.invokeExact(call.allocateFrom(key), call.allocateFrom(value), 1);
        }
      } catch (Throwable e) {
        throw new IOException("setenv " + key, e);
      }
    }

    private static void windowsDllDirectory(Path dir) throws IOException {
      Linker linker = Linker.nativeLinker();
      try (Arena call = Arena.ofConfined()) {
        SymbolLookup kernel32 = SymbolLookup.libraryLookup("kernel32", Arena.global());
        MethodHandle set =
            linker.downcallHandle(
                kernel32.find("SetDllDirectoryW").orElseThrow(), FunctionDescriptor.of(JAVA_INT, ADDRESS));
        int ok = (int) set.invokeExact(wide(call, dir.toString()));
      } catch (Throwable e) {
        throw new IOException("SetDllDirectoryW", e);
      }
    }

    private static Optional<Path> windowsSteamPath() {
      try {
        Process process =
            new ProcessBuilder("reg", "query", "HKCU\\Software\\Valve\\Steam", "/v", "SteamPath")
                .redirectErrorStream(true)
                .start();
        String output = new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        for (String line : output.split("\\R")) {
          int index = line.indexOf("REG_SZ");
          if (index >= 0) {
            return Optional.of(Path.of(line.substring(index + "REG_SZ".length()).trim()));
          }
        }
      } catch (IOException e) {
        LOG.log(System.Logger.Level.WARNING, "reg query failed", e);
      }
      Path fallback = Path.of("C:\\Program Files (x86)\\Steam");
      return Files.isDirectory(fallback) ? Optional.of(fallback) : Optional.empty();
    }

    private static MemorySegment wide(Arena arena, String value) {
      return arena.allocateFrom(value, StandardCharsets.UTF_16LE);
    }
  }
}
