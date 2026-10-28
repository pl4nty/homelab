FROM --platform=$BUILDPLATFORM mcr.microsoft.com/dotnet/sdk:10.0-alpine AS build-env
WORKDIR /app
COPY --from=src ./app/ ./
COPY app/ ./
# upstream targets .NET 7, which reached end of support on 2024-05-14
ARG TARGETARCH
RUN --mount=type=cache,id=nuget,target=/root/.nuget/packages,sharing=locked \
    sed -i 's#<TargetFramework>net7.0<#<TargetFramework>net10.0<#' StoreWeb.csproj \
 && dotnet publish -c Release -a $TARGETARCH -o out

FROM mcr.microsoft.com/dotnet/aspnet:10.0-alpine
WORKDIR /app
COPY --from=build-env /app/out .
ENV ASPNETCORE_URLS=http://*:80
CMD ["dotnet", "StoreWeb.dll"]

EXPOSE 80
