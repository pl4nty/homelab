# https://github.com/open-telemetry/opentelemetry-operator/blob/99b6c6fc4c472fd6b54080f9e2737fdf38573ae9/autoinstrumentation/dotnet/Dockerfile
# To build one auto-instrumentation image for dotnet, please:
#  - Download your dotnet auto-instrumentation artefacts to `/autoinstrumentation` directory. This is required as when instrumenting the pod,
#    one init container will be created to copy the files to your app's container.
#  - Grant the necessary access to the files in the `/autoinstrumentation` directory.
#  - Following environment variables are injected to the application container to enable the auto-instrumentation.
#    CORECLR_ENABLE_PROFILING=1
#    CORECLR_PROFILER={918728DD-259F-4A6A-AC2B-B85E1B658318}
#    CORECLR_PROFILER_PATH=%InstallationLocation%/linux-x64/OpenTelemetry.AutoInstrumentation.Native.so # for glibc based images
#    CORECLR_PROFILER_PATH=%InstallationLocation%/linux-musl-x64/OpenTelemetry.AutoInstrumentation.Native.so # for musl based images
#    DOTNET_ADDITIONAL_DEPS=%InstallationLocation%/AdditionalDeps
#    DOTNET_SHARED_STORE=%InstallationLocation%/store
#    DOTNET_STARTUP_HOOKS=%InstallationLocation%/net/OpenTelemetry.AutoInstrumentation.StartupHook.dll 
#    OTEL_DOTNET_AUTO_HOME=%InstallationLocation%
#  - For auto-instrumentation by container injection, the Linux command cp is
#    used and must be availabe in the image.
FROM --platform=$BUILDPLATFORM busybox@sha256:dc2d74b28e4cf8984fa52af1f39bc7c3d9c73760b41a74d629f5d11b1ab28616 AS downloader

ARG version=1.9.0

WORKDIR /autoinstrumentation

ADD https://github.com/open-telemetry/opentelemetry-dotnet-instrumentation/releases/download/v$version/opentelemetry-dotnet-instrumentation-linux-glibc-x64.zip .
ADD https://github.com/open-telemetry/opentelemetry-dotnet-instrumentation/releases/download/v$version/opentelemetry-dotnet-instrumentation-linux-musl-x64.zip .
ADD https://github.com/open-telemetry/opentelemetry-dotnet-instrumentation/releases/download/v$version/opentelemetry-dotnet-instrumentation-linux-glibc-arm64.zip .
ADD https://github.com/open-telemetry/opentelemetry-dotnet-instrumentation/releases/download/v$version/opentelemetry-dotnet-instrumentation-linux-musl-arm64.zip .

# AdditionalDeps, net, instrument.sh, LICENSE from x64 glibc
# store from glibcs
# native .so files from each arch/lib
RUN unzip opentelemetry-dotnet-instrumentation-linux-glibc-x64.zip &&\
  unzip opentelemetry-dotnet-instrumentation-linux-musl-x64.zip "linux-musl-x64/*" -d . &&\
  unzip opentelemetry-dotnet-instrumentation-linux-glibc-arm64.zip "linux-arm64/*" -d . &&\
  unzip opentelemetry-dotnet-instrumentation-linux-glibc-arm64.zip "store/*" -d . &&\
  unzip opentelemetry-dotnet-instrumentation-linux-musl-arm64.zip "linux-musl-arm64/*" -d . &&\
  rm opentelemetry-dotnet-instrumentation-linux-glibc-x64.zip opentelemetry-dotnet-instrumentation-linux-musl-x64.zip &&\
  rm opentelemetry-dotnet-instrumentation-linux-glibc-arm64.zip opentelemetry-dotnet-instrumentation-linux-musl-arm64.zip &&\
  chmod -R go+r .

FROM busybox@sha256:dc2d74b28e4cf8984fa52af1f39bc7c3d9c73760b41a74d629f5d11b1ab28616

COPY --from=downloader /autoinstrumentation /autoinstrumentation
