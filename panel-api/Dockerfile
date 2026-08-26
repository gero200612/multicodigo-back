# --- 1. el front -----------------------------------------------------------
#
# Angular se buildea en su propia etapa y NO en la VM de produccion: un build de
# Angular pide varios GB y competiria con los hijos por la RAM del host, que es
# exactamente el OOM que el dimensionamiento busca evitar. Si el host es chico,
# esta etapa se corre afuera (CI o tu maquina) con `--target front` y se copia el
# dist; la imagen final solo necesita el resultado.
FROM node:22-slim AS front
WORKDIR /app
RUN corepack enable
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY src/panel-web ./src/panel-web
RUN pnpm install --frozen-lockfile --filter @multicodigo/panel-web...
RUN pnpm --filter @multicodigo/panel-web exec ng build

# --- 2. el backend ---------------------------------------------------------
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
COPY src/panel-api/*.csproj ./
RUN dotnet restore
COPY src/panel-api/ ./
RUN dotnet publish -c Release -o /app/publish --no-restore

# --- 3. la imagen final ----------------------------------------------------
#
# `aspnet` y no `sdk`: la imagen de runtime no lleva compilador. Es mas chica y
# no tiene con que compilar nada que llegue de afuera.
FROM mcr.microsoft.com/dotnet/aspnet:10.0
WORKDIR /app
COPY --from=build /app/publish ./
# El bundle va a wwwroot, que es de donde UseStaticFiles sirve por defecto.
COPY --from=front /app/src/panel-web/dist/browser ./wwwroot

# Sin root: este servicio es el unico expuesto a internet. No monta /srv/creds,
# no habla con el socket de docker y no tiene el CLI de Claude — todo lo que NO
# tiene es a proposito.
RUN useradd -m -u 1001 panel
USER panel

ENV ASPNETCORE_URLS=http://0.0.0.0:8091
EXPOSE 8091
ENTRYPOINT ["dotnet", "MultiCodigo.Panel.dll"]
