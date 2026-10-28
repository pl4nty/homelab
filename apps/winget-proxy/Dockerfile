FROM --platform=$BUILDPLATFORM mcr.microsoft.com/dotnet/sdk:10.0 AS test
WORKDIR /source
COPY --parents src/*/*.csproj tests/*/*.csproj ./
RUN dotnet restore tests/WinGet.RestSource.Tests
COPY . .
RUN dotnet format whitespace --folder --verify-no-changes \
 && dotnet test tests/WinGet.RestSource.Tests -c Release --no-restore

FROM test AS build
ARG TARGETARCH
RUN dotnet publish src/WinGet.RestSource -c Release -a $TARGETARCH -o /app \
 && dotnet publish src/WinGet.Features.Shim -c Release -o /app/shim \
 && dotnet publish src/WinGet.Updates.Shim -c Release -o /app/shim

FROM mcr.microsoft.com/dotnet/aspnet:10.0
WORKDIR /app
COPY --from=build /app .
EXPOSE 8080
USER $APP_UID
ENTRYPOINT ["dotnet", "WinGet.RestSource.dll"]
