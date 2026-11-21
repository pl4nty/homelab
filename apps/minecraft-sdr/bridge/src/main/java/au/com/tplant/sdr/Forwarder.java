package au.com.tplant.sdr;

import java.io.IOException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

public final class Forwarder {
  public static final String SUFFIX = ".sdr";
  public static final String STEAM_ID = "/steam-id";

  private static final System.Logger LOG = System.getLogger("minecraft-sdr");
  private static final Map<String, Forwarder> FORWARDERS = new ConcurrentHashMap<>();
  private static final HttpClient HTTP =
      HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).followRedirects(HttpClient.Redirect.NORMAL).build();

  private final String target;
  private final ServerSocket local;

  private Forwarder(String target, int port) throws IOException {
    this.target = target;
    local = new ServerSocket();
    local.bind(new InetSocketAddress(InetAddress.getLoopbackAddress(), port));
    Thread.ofPlatform().daemon().name("sdr-forward-" + port).start(this::accept);
  }

  public static boolean isSdr(String address) {
    return address.regionMatches(true, address.length() - SUFFIX.length(), SUFFIX, 0, SUFFIX.length());
  }

  public static InetSocketAddress localAddress(String address) throws IOException {
    return localAddress(address, 0);
  }

  public static InetSocketAddress localAddress(String address, int port) throws IOException {
    String target = address.substring(0, address.length() - SUFFIX.length()).toLowerCase();
    Forwarder forwarder = FORWARDERS.get(target);
    if (forwarder == null) {
      synchronized (FORWARDERS) {
        forwarder = FORWARDERS.get(target);
        if (forwarder == null) {
          forwarder = new Forwarder(target, port);
          FORWARDERS.put(target, forwarder);
        }
      }
    }
    return (InetSocketAddress) forwarder.local.getLocalSocketAddress();
  }

  static long resolve(String target) throws IOException, InterruptedException {
    if (target.chars().allMatch(Character::isDigit)) {
      return Long.parseUnsignedLong(target);
    }
    HttpRequest request =
        HttpRequest.newBuilder(URI.create("https://" + target + STEAM_ID)).timeout(Duration.ofSeconds(10)).build();
    HttpResponse<String> response = HTTP.send(request, HttpResponse.BodyHandlers.ofString());
    if (response.statusCode() != 200) {
      throw new IOException(request.uri() + " returned " + response.statusCode());
    }
    return Long.parseUnsignedLong(response.body().trim());
  }

  private void accept() {
    while (true) {
      try {
        Socket tcp = local.accept();
        Thread.ofVirtual()
            .start(
                () -> {
                  try {
                    Steam steam = Steam.get();
                    steam.awaitReady(30_000);
                    Link.forward(steam, resolve(target), tcp);
                  } catch (Exception e) {
                    LOG.log(System.Logger.Level.WARNING, "SDR connection to " + target + " failed", e);
                    try {
                      tcp.close();
                    } catch (IOException ignored) {
                    }
                  }
                });
      } catch (IOException e) {
        LOG.log(System.Logger.Level.ERROR, "local listener for " + target + " failed", e);
        return;
      }
    }
  }
}
