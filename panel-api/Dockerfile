# El panel, solo la API.
#
# Antes esta imagen buildeaba tambien el front de Angular y le copiaba el bundle
# a wwwroot. Al separar los repos, el front pasa a tener su propia URL: lo sirve
# Vercel, que hace de proxy de /api y /config.json hacia aca para que el
# navegador siga viendo un solo origen. Aca no queda nada de Angular.
#
# El contexto de build es ESTE directorio y no la raiz del repo, igual que el
# bridge. Asi los dos servicios de Render se configuran igual: Root Directory
# con el nombre del servicio, y nada mas.

# --- 1. el build -----------------------------------------------------------
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src

# El .csproj antes que el codigo: si no cambiaron los paquetes, docker reusa la
# capa del restore.
COPY *.csproj ./
RUN dotnet restore

COPY . ./
RUN dotnet publish -c Release -o /app/publish --no-restore

# --- 2. la imagen final ----------------------------------------------------
#
# `aspnet` y no `sdk`: la imagen de runtime no lleva compilador. Es mas chica y
# no tiene con que compilar nada que llegue de afuera.
FROM mcr.microsoft.com/dotnet/aspnet:10.0
WORKDIR /app
COPY --from=build /app/publish ./

# Sin root. Este servicio no monta /srv/creds, no habla con el socket de docker
# y no tiene el CLI de Claude — todo lo que NO tiene es a proposito.
RUN useradd -m -u 1001 panel
USER panel

ENV ASPNETCORE_URLS=http://0.0.0.0:8091
EXPOSE 8091
ENTRYPOINT ["dotnet", "MultiCodigo.Panel.dll"]
