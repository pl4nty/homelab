package au.com.tplant.sdr;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.lang.foreign.Arena;
import java.lang.foreign.MemorySegment;
import java.lang.foreign.ValueLayout;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

final class Link implements Steam.Listener {
  private static final System.Logger LOG = System.getLogger("minecraft-sdr");
  private static final byte[] EOF = new byte[0];
  private static final int CHUNK = 64 * 1024;

  private final Steam steam;
  private final LinkedBlockingQueue<byte[]> inbound = new LinkedBlockingQueue<>();
  private final CompletableFuture<Void> connected = new CompletableFuture<>();
  private final CompletableFuture<Socket> socket = new CompletableFuture<>();
  private volatile int connection;

  private Link(Steam steam) {
    this.steam = steam;
  }

  static Link accept(Steam steam, int connection, InetSocketAddress target) {
    Link link = new Link(steam);
    link.connection = connection;
    Thread.ofVirtual()
        .start(
            () -> {
              try {
                Socket tcp = new Socket();
                tcp.setTcpNoDelay(true);
                tcp.connect(target, 10_000);
                link.start(tcp);
              } catch (IOException e) {
                LOG.log(System.Logger.Level.WARNING, "connect " + target + " failed", e);
                link.socket.completeExceptionally(e);
                steam.close(connection, "upstream unreachable");
              }
            });
    return link;
  }

  static void forward(Steam steam, long steamId, Socket tcp) throws IOException {
    tcp.setTcpNoDelay(true);
    Link link = new Link(steam);
    link.connection = steam.connect(steamId, link);
    link.start(tcp);
  }

  private void start(Socket tcp) {
    socket.complete(tcp);
    Thread.ofVirtual().start(this::write);
    Thread.ofVirtual().start(this::read);
  }

  @Override
  public void onStatus(int connection, int state, String reason) {
    if (state == Steam.STATE_CONNECTED) {
      connected.complete(null);
    } else if (state == Steam.STATE_CLOSED_BY_PEER || state == Steam.STATE_PROBLEM) {
      LOG.log(System.Logger.Level.INFO, "connection " + connection + " closed: " + reason);
      connected.completeExceptionally(new IOException(reason));
      inbound.add(EOF);
    }
  }

  @Override
  public void onMessage(byte[] data) {
    inbound.add(data);
  }

  private void write() {
    try {
      Socket tcp = socket.join();
      OutputStream out = tcp.getOutputStream();
      while (true) {
        byte[] data = inbound.take();
        if (data == EOF) {
          break;
        }
        out.write(data);
      }
      tcp.close();
    } catch (IOException | InterruptedException e) {
      LOG.log(System.Logger.Level.DEBUG, "write ended", e);
      steam.close(connection, "downstream closed");
    }
  }

  private void read() {
    try (Arena arena = Arena.ofConfined()) {
      Socket tcp = socket.join();
      connected.get(30, TimeUnit.SECONDS);
      MemorySegment buffer = arena.allocate(CHUNK);
      byte[] chunk = new byte[CHUNK];
      InputStream in = tcp.getInputStream();
      int length;
      while ((length = in.read(chunk)) > 0) {
        MemorySegment.copy(chunk, 0, buffer, ValueLayout.JAVA_BYTE, 0, length);
        int result;
        while ((result = steam.send(connection, buffer, length)) == Steam.RESULT_LIMIT_EXCEEDED) {
          Thread.sleep(5);
        }
        if (result != Steam.RESULT_OK) {
          throw new IOException("send failed: " + result);
        }
      }
    } catch (Exception e) {
      LOG.log(System.Logger.Level.DEBUG, "read ended", e);
    }
    steam.close(connection, "tcp closed");
    inbound.add(EOF);
  }
}
