FROM --platform=$BUILDPLATFORM mcr.microsoft.com/dotnet/sdk:10.0.403@sha256:212fe4cb74627d5adf9817a4088906ae3edff1bd853bb27565d4b46731efe61e AS test
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

FROM mcr.microsoft.com/dotnet/aspnet:10.0.14@sha256:1a48394b6f29d3a32c79d9edecd4abda0ecbe8776d567dbfc4590ed6979c740c
WORKDIR /app
COPY --from=build /app .
EXPOSE 8080
USER $APP_UID
ENTRYPOINT ["dotnet", "WinGet.RestSource.dll"]
