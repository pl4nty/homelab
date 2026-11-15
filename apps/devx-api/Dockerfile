FROM --platform=$BUILDPLATFORM mcr.microsoft.com/dotnet/sdk:10.0.404@sha256:fe0fd4e93bd2fbb47c883b7a6369e5c8d3db8bf01cdc5981f6ee35fbdf3ff4fb AS source
WORKDIR /src
COPY --from=src . .
COPY devx-api.patch .
# fixes PowerShell snippets (microsoftgraph/microsoft-graph-devx-content#1564) and adds CORS
# Windows checkouts have CRLF (upstream .gitattributes is text=auto), so normalise patched files first
RUN git apply --numstat devx-api.patch | cut -f3 | xargs sed -i 's/\r$//' \
  && git apply devx-api.patch
# upstream targets .NET 8, which reaches end of support on 2026-11-10
RUN find . -name '*.csproj' -exec sed -i 's#<TargetFramework>net8.0<#<TargetFramework>net10.0<#' {} +

# opt-in: docker build --target test
FROM source AS test
RUN --mount=type=cache,id=nuget,target=/root/.nuget/packages,sharing=locked \
    dotnet test MSGraphWebApi.sln --filter "TestCategory!=CodeSnippetsPipeline"

FROM source AS build
ARG TARGETARCH
RUN --mount=type=cache,id=nuget,target=/root/.nuget/packages,sharing=locked \
    dotnet publish GraphWebApi/GraphWebApi.csproj -c Release -a $TARGETARCH -o /app

FROM mcr.microsoft.com/dotnet/aspnet:10.0.15@sha256:bfd912c83295ce66d4b706ebb8541b9f14259b0e76fbb88b2751f58ce2399d2e
# config reload watches files with inotify, which crashes the app when the node's per-user limit is exhausted
ENV DOTNET_hostBuilder__reloadConfigOnChange=false
USER $APP_UID
WORKDIR /app
COPY --from=build /app .
ENTRYPOINT ["dotnet", "GraphWebApi.dll"]
