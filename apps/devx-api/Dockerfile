FROM --platform=$BUILDPLATFORM mcr.microsoft.com/dotnet/sdk:10.0@sha256:de4fe90a98845d75910b9769662465c84de1a934665c431279d1382b2bddc02b AS source
WORKDIR /src
COPY --from=src . .
COPY devx-api.patch .
# fixes PowerShell snippets (microsoftgraph/microsoft-graph-devx-content#1564) and adds CORS
# Windows checkouts have CRLF (upstream .gitattributes is text=auto), so normalise patched files first
RUN git apply --numstat devx-api.patch | cut -f3 | xargs sed -i 's/\r$//' \
  && git apply devx-api.patch
# upstream targets .NET 8, which reaches end of support on 2026-11-10, so target the SDK's major to match the runtime image
RUN find . -name '*.csproj' -exec sed -i "s#<TargetFramework>net8.0<#<TargetFramework>net$(dotnet --version | cut -d. -f1).0<#" {} +

# opt-in: docker build --target test
FROM source AS test
RUN --mount=type=cache,id=nuget,target=/root/.nuget/packages,sharing=locked \
    dotnet test MSGraphWebApi.sln --filter "TestCategory!=CodeSnippetsPipeline"

FROM source AS build
ARG TARGETARCH
RUN --mount=type=cache,id=nuget,target=/root/.nuget/packages,sharing=locked \
    dotnet publish GraphWebApi/GraphWebApi.csproj -c Release -a $TARGETARCH -o /app

FROM mcr.microsoft.com/dotnet/aspnet:10.0@sha256:de0ee358cdd672f7017a003bed21e9ac9ed48a27c922a59b18175b6e82fa7fee
# config reload watches files with inotify, which crashes the app when the node's per-user limit is exhausted
ENV DOTNET_hostBuilder__reloadConfigOnChange=false
USER $APP_UID
WORKDIR /app
COPY --from=build /app .
ENTRYPOINT ["dotnet", "GraphWebApi.dll"]
