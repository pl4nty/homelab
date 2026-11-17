FROM --platform=$BUILDPLATFORM mcr.microsoft.com/dotnet/sdk:11.0.100@sha256:65f3c7c6a25a239ab3e6719f2896147e7b68242ff2d8818dd70498bde6ef8bea AS test
WORKDIR /source
COPY . .
RUN --mount=type=cache,id=nuget,target=/root/.nuget/packages,sharing=locked \
    dotnet format whitespace --folder --verify-no-changes \
 && dotnet test tests/WinGet.RestSource.Tests -c Release

FROM test AS build
ARG TARGETARCH
RUN --mount=type=cache,id=nuget,target=/root/.nuget/packages,sharing=locked \
    dotnet publish src/WinGet.RestSource -c Release -a $TARGETARCH -o /app \
 && dotnet publish src/WinGet.Features.Shim -c Release -o /app/shim \
 && dotnet publish src/WinGet.Updates.Shim -c Release -o /app/shim

FROM mcr.microsoft.com/dotnet/aspnet:11.0.0@sha256:bc0d6653979efba491ab3d6f589d691f96c309c3c3ef81325efa6978e7b7f242
WORKDIR /app
COPY --from=build /app .
EXPOSE 8080
USER $APP_UID
ENTRYPOINT ["dotnet", "WinGet.RestSource.dll"]
