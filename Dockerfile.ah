# Imagen para Render: compila la API y la corre sobre el runtime de ASP.NET.
# Render no trae .NET, asi que el despliegue va por Docker. Lo escribe el
# sistema al publicar; si lo editas, tu version manda.
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
COPY AH.Api.csproj ./
RUN dotnet restore AH.Api.csproj
COPY . .
RUN dotnet publish AH.Api.csproj -c Release -o /app/publish

FROM mcr.microsoft.com/dotnet/aspnet:10.0
WORKDIR /app
COPY --from=build /app/publish .

# La plataforma inyecta PORT; el 8080 es para correrla a mano.
ENV ASPNETCORE_URLS=http://+:8080
EXPOSE 8080
ENTRYPOINT ["dotnet", "AH.Api.dll"]
