FROM --platform=$BUILDPLATFORM mcr.microsoft.com/dotnet/sdk:11.0-alpine@sha256:f2542b156e7c9eda7783e4a5745efa6c133a162a1940fd4175849aa80fccfd23 AS build-env
WORKDIR /app
COPY --from=src ./app/ ./
COPY app/ ./
# upstream targets .NET 7, which reached end of support on 2024-05-14
ARG TARGETARCH
RUN --mount=type=cache,id=nuget,target=/root/.nuget/packages,sharing=locked \
    sed -i 's#<TargetFramework>net7.0<#<TargetFramework>net10.0<#' StoreWeb.csproj \
 && dotnet publish -c Release -a $TARGETARCH -o out

FROM mcr.microsoft.com/dotnet/aspnet:11.0-alpine@sha256:77256017a4f675e1cf66a4e910e115608a73a044b50ee07c3d042c8a71132da5
WORKDIR /app
COPY --from=build-env /app/out .
ENV ASPNETCORE_URLS=http://*:80
CMD ["dotnet", "StoreWeb.dll"]

EXPOSE 80
