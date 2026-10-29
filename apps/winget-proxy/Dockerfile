FROM --platform=$BUILDPLATFORM mcr.microsoft.com/dotnet/sdk:11.0@sha256:3a9175b6c54b2f076817af1360f691c9994447b192faa48a1a1f112a516844c7 AS test
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

FROM mcr.microsoft.com/dotnet/aspnet:11.0@sha256:bae0269049d5061ab7f49995cc1acebf54b75471c096c4a1f874e27661d44045
WORKDIR /app
COPY --from=build /app .
EXPOSE 8080
USER $APP_UID
ENTRYPOINT ["dotnet", "WinGet.RestSource.dll"]
