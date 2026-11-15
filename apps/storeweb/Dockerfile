FROM --platform=$BUILDPLATFORM mcr.microsoft.com/dotnet/sdk:11.0.100-alpine3.24@sha256:52556c0fb9d0f609ae9aeab9efeeba96f4acc2f7038f7696f2235ccbdbb8e290 AS build-env
WORKDIR /app
COPY --from=src ./app/ ./
COPY app/ ./
# upstream targets .NET 7, which reached end of support on 2024-05-14
ARG TARGETARCH
RUN --mount=type=cache,id=nuget,target=/root/.nuget/packages,sharing=locked \
    sed -i 's#<TargetFramework>net7.0<#<TargetFramework>net11.0<#' StoreWeb.csproj \
 && dotnet publish -c Release -a $TARGETARCH -o out

FROM mcr.microsoft.com/dotnet/aspnet:11.0.0-alpine3.24@sha256:d39b72ad1534fa0faf52b488bffb0762df7ba269d120f0338713d4dda2a41bf5
WORKDIR /app
COPY --from=build-env /app/out .
ENV ASPNETCORE_URLS=http://*:80
CMD ["dotnet", "StoreWeb.dll"]

EXPOSE 80
