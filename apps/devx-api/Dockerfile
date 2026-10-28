FROM --platform=$BUILDPLATFORM mcr.microsoft.com/dotnet/sdk:8.0 AS source
WORKDIR /src
COPY --from=src . .
COPY devx-api.patch .
# fixes PowerShell snippets (microsoftgraph/microsoft-graph-devx-content#1564) and adds CORS
# Windows checkouts have CRLF (upstream .gitattributes is text=auto), so normalise patched files first
RUN git apply --numstat devx-api.patch | cut -f3 | xargs sed -i 's/\r$//' \
  && git apply devx-api.patch

# opt-in: docker build --target test
FROM source AS test
RUN dotnet test MSGraphWebApi.sln --filter "TestCategory!=CodeSnippetsPipeline"

FROM source AS build
ARG TARGETARCH
RUN dotnet publish GraphWebApi/GraphWebApi.csproj -c Release -a $TARGETARCH -o /app

FROM mcr.microsoft.com/dotnet/aspnet:8.0
# config reload watches files with inotify, which crashes the app when the node's per-user limit is exhausted
ENV DOTNET_hostBuilder__reloadConfigOnChange=false
USER $APP_UID
WORKDIR /app
COPY --from=build /app .
ENTRYPOINT ["dotnet", "GraphWebApi.dll"]
