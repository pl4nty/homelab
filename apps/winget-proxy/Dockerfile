FROM --platform=$BUILDPLATFORM mcr.microsoft.com/dotnet/sdk:10.0@sha256:de4fe90a98845d75910b9769662465c84de1a934665c431279d1382b2bddc02b AS test
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

FROM mcr.microsoft.com/dotnet/aspnet:10.0@sha256:de0ee358cdd672f7017a003bed21e9ac9ed48a27c922a59b18175b6e82fa7fee
WORKDIR /app
COPY --from=build /app .
EXPOSE 8080
USER $APP_UID
ENTRYPOINT ["dotnet", "WinGet.RestSource.dll"]
