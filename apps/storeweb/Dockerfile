FROM --platform=$BUILDPLATFORM mcr.microsoft.com/dotnet/sdk:10.0.403-alpine3.24@sha256:5562fd626eec39f6f53218f9b7d7856ab7195d51d846568304fbe85071a3b6e6 AS build-env
WORKDIR /app
COPY --from=src ./app/ ./
COPY app/ ./
# upstream targets .NET 7, which reached end of support on 2024-05-14
ARG TARGETARCH
RUN --mount=type=cache,id=nuget,target=/root/.nuget/packages,sharing=locked \
    sed -i 's#<TargetFramework>net7.0<#<TargetFramework>net10.0<#' StoreWeb.csproj \
 && dotnet publish -c Release -a $TARGETARCH -o out

FROM mcr.microsoft.com/dotnet/aspnet:10.0.14-alpine3.24@sha256:486297ae006e95ee2ee3112a2c03e3d26e41fbbc64b7a29e28e7a18cc36b12bb
WORKDIR /app
COPY --from=build-env /app/out .
ENV ASPNETCORE_URLS=http://*:80
CMD ["dotnet", "StoreWeb.dll"]

EXPOSE 80
