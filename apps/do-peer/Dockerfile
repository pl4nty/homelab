FROM --platform=$BUILDPLATFORM mcr.microsoft.com/dotnet/sdk:11.0.100@sha256:65f3c7c6a25a239ab3e6719f2896147e7b68242ff2d8818dd70498bde6ef8bea AS test
WORKDIR /source
COPY . .
RUN --mount=type=cache,id=nuget,target=/root/.nuget/packages,sharing=locked \
    dotnet format whitespace --folder --verify-no-changes \
 && dotnet test tests/DoPeer.Tests -c Release

FROM test AS build
ARG TARGETARCH
RUN --mount=type=cache,id=nuget,target=/root/.nuget/packages,sharing=locked \
    dotnet publish src/DoPeer -c Release -a $TARGETARCH -o /app

FROM mcr.microsoft.com/dotnet/aspnet:11.0.0@sha256:bc0d6653979efba491ab3d6f589d691f96c309c3c3ef81325efa6978e7b7f242
WORKDIR /app
COPY --from=build /app .
# HTTP (file list, files, pieces hash files) and the DO peer protocol
EXPOSE 8080 7680
USER $APP_UID
ENTRYPOINT ["dotnet", "DoPeer.dll"]
