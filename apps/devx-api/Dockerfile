FROM --platform=$BUILDPLATFORM mcr.microsoft.com/dotnet/sdk:11.0.100@sha256:65f3c7c6a25a239ab3e6719f2896147e7b68242ff2d8818dd70498bde6ef8bea AS source
WORKDIR /src
COPY --from=src . .
COPY devx-api.patch .
# fixes PowerShell snippets (microsoftgraph/microsoft-graph-devx-content#1564) and adds CORS
# Windows checkouts have CRLF (upstream .gitattributes is text=auto), so normalise patched files first
RUN git apply --numstat devx-api.patch | cut -f3 | xargs sed -i 's/\r$//' \
  && git apply devx-api.patch
# upstream targets .NET 8, which reaches end of support on 2026-11-10
RUN find . -name '*.csproj' -exec sed -i 's#<TargetFramework>net8.0<#<TargetFramework>net11.0<#' {} +

# opt-in: docker build --target test
FROM source AS test
RUN --mount=type=cache,id=nuget,target=/root/.nuget/packages,sharing=locked \
    dotnet test MSGraphWebApi.sln --filter "TestCategory!=CodeSnippetsPipeline"

FROM source AS build
ARG TARGETARCH
RUN --mount=type=cache,id=nuget,target=/root/.nuget/packages,sharing=locked \
    dotnet publish GraphWebApi/GraphWebApi.csproj -c Release -a $TARGETARCH -o /app

FROM mcr.microsoft.com/dotnet/aspnet:11.0.0@sha256:bc0d6653979efba491ab3d6f589d691f96c309c3c3ef81325efa6978e7b7f242
# config reload watches files with inotify, which crashes the app when the node's per-user limit is exhausted
ENV DOTNET_hostBuilder__reloadConfigOnChange=false
USER $APP_UID
WORKDIR /app
COPY --from=build /app .
ENTRYPOINT ["dotnet", "GraphWebApi.dll"]
