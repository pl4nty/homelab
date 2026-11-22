package au.com.tplant.sdr;

import com.sun.net.httpserver.HttpServer;
import com.sun.net.httpserver.SimpleFileServer;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.concurrent.atomic.AtomicBoolean;

public final class Main {
  private Main() {}

  public static void main(String[] args) throws Exception {
    if (args.length == 4 && args[0].equals("serve")) {
      serve(parse(args[1]), Integer.parseInt(args[2]), Path.of(args[3]));
    } else if ((args.length == 2 || args.length == 3) && args[0].equals("connect")) {
      String address = Forwarder.isSdr(args[1]) ? args[1] : args[1] + Forwarder.SUFFIX;
      int port = args.length == 3 ? Integer.parseInt(args[2]) : 25565;
      InetSocketAddress local = Forwarder.localAddress(address, port);
      System.out.println("Add server " + local.getHostString() + ":" + local.getPort() + " in Minecraft");
      Thread.currentThread().join();
    } else {
      System.err.println("usage: serve <minecraft host:port> <http port> <download dir> | connect <host or steam id> [local port]");
      System.exit(2);
    }
  }

  private static InetSocketAddress parse(String hostPort) {
    int colon = hostPort.lastIndexOf(':');
    return InetSocketAddress.createUnresolved(hostPort.substring(0, colon), Integer.parseInt(hostPort.substring(colon + 1)));
  }

  private static void serve(InetSocketAddress target, int httpPort, Path downloads)
      throws IOException, InterruptedException {
    Steam steam = Steam.get();
    AtomicBoolean listening = new AtomicBoolean();

    HttpServer http = HttpServer.create(new InetSocketAddress(httpPort), 0);
    http.createContext(
        Forwarder.STEAM_ID,
        exchange -> {
          byte[] body;
          int status;
          try {
            if (!listening.get()) {
              throw new IOException("not listening");
            }
            body = Long.toUnsignedString(steam.awaitReady(0)).getBytes(StandardCharsets.UTF_8);
            status = 200;
          } catch (IOException | InterruptedException e) {
            body = "Steam not ready".getBytes(StandardCharsets.UTF_8);
            status = 503;
          }
          exchange.getResponseHeaders().set("Content-Type", "text/plain");
          exchange.getResponseHeaders().set("Cache-Control", "no-store");
          exchange.sendResponseHeaders(status, body.length);
          try (OutputStream out = exchange.getResponseBody()) {
            out.write(body);
          }
        });
    http.createContext("/", SimpleFileServer.createFileHandler(downloads.toAbsolutePath()));
    http.start();

    long steamId = steam.awaitReady(120_000);
    steam.listen(connection -> Link.accept(steam, connection, new InetSocketAddress(target.getHostString(), target.getPort())));
    listening.set(true);
    System.out.println("Listening on SDR as " + Long.toUnsignedString(steamId) + ", forwarding to " + target);
  }
}
