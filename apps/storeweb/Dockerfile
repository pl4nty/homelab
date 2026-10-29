FROM --platform=$BUILDPLATFORM mcr.microsoft.com/dotnet/sdk:10.0.403-alpine3.24@sha256:cc02b814237a76c4735fb6eeee87181597b5e56f2ce458a435e527674d91f4d7 AS build-env
WORKDIR /app
COPY --from=src ./app/ ./
COPY app/ ./
# upstream targets .NET 7, which reached end of support on 2024-05-14
ARG TARGETARCH
RUN --mount=type=cache,id=nuget,target=/root/.nuget/packages,sharing=locked \
    sed -i 's#<TargetFramework>net7.0<#<TargetFramework>net10.0<#' StoreWeb.csproj \
 && dotnet publish -c Release -a $TARGETARCH -o out

FROM mcr.microsoft.com/dotnet/aspnet:10.0.14-alpine3.24@sha256:254fe017495996d3abcc487ffacdcce2b73affb380d3af87af12c8dff41fe0b0
WORKDIR /app
COPY --from=build-env /app/out .
ENV ASPNETCORE_URLS=http://*:80
CMD ["dotnet", "StoreWeb.dll"]

EXPOSE 80
