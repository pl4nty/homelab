FROM mcr.microsoft.com/dotnet/sdk:7.0-alpine AS build-env
WORKDIR /app

# Copy csproj and restore as distinct layers
COPY --from=src app/*.csproj ./
RUN dotnet restore

# Copy everything else and build
COPY --from=src ./app/ ./
COPY app/ ./
RUN dotnet publish -c Release -o out

# Build runtime image
FROM mcr.microsoft.com/dotnet/aspnet:7.0-alpine
WORKDIR /app
COPY --from=build-env /app/out .
# ENTRYPOINT ["dotnet", "StoreWeb.dll"]
# heroku uses the following
ENV ASPNETCORE_URLS=http://*:80
CMD ["dotnet", "StoreWeb.dll"]

EXPOSE 80
