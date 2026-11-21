package au.com.tplant.sdr.fabric.mixin;

import au.com.tplant.sdr.Forwarder;
import net.minecraft.client.multiplayer.resolver.ServerAddress;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

@Mixin(ServerAddress.class)
public class ServerAddressMixin {
  @Inject(method = "parseString", at = @At("HEAD"), cancellable = true)
  private static void parseSdr(String address, CallbackInfoReturnable<ServerAddress> cir) {
    if (address != null && Forwarder.isSdr(address)) {
      cir.setReturnValue(new ServerAddress(address.trim(), 25565));
    }
  }

  @Inject(method = "isValidAddress", at = @At("HEAD"), cancellable = true)
  private static void validSdr(String address, CallbackInfoReturnable<Boolean> cir) {
    if (address != null && Forwarder.isSdr(address)) {
      cir.setReturnValue(true);
    }
  }
}
