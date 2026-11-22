package au.com.tplant.sdr.fabric.mixin;

import au.com.tplant.sdr.Forwarder;
import java.io.IOException;
import java.util.Optional;
import net.minecraft.client.multiplayer.resolver.ResolvedServerAddress;
import net.minecraft.client.multiplayer.resolver.ServerAddress;
import net.minecraft.client.multiplayer.resolver.ServerNameResolver;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

@Mixin(ServerNameResolver.class)
public class ServerNameResolverMixin {
  private static final Logger LOGGER = LoggerFactory.getLogger("minecraft-sdr");

  @Inject(method = "resolveAddress", at = @At("HEAD"), cancellable = true)
  private void resolveSdr(ServerAddress address, CallbackInfoReturnable<Optional<ResolvedServerAddress>> cir) {
    if (Forwarder.isSdr(address.getHost())) {
      try {
        cir.setReturnValue(Optional.of(ResolvedServerAddress.from(Forwarder.localAddress(address.getHost()))));
      } catch (IOException e) {
        LOGGER.warn("SDR forwarder for {} failed", address.getHost(), e);
        cir.setReturnValue(Optional.empty());
      }
    }
  }
}
