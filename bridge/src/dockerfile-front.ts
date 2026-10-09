/**
 * El Dockerfile del front para el VPS, escrito por el sistema.
 *
 * Coolify construye con Nixpacks si el repo no trae Dockerfile, y Nixpacks trae
 * Node 22.11: Angular pide >= 22.22 y el build muere. Paso al mudar SincroResto
 * y Justadama (2026-10-09); la receta de aca es la que quedo andando en los dos.
 *
 * Misma clase de cosa que `dockerfile-back.ts`: infraestructura que el sistema
 * sabe como tiene que ser. Si el repo ya trae un Dockerfile, manda el repo.
 */
import { leerArchivo, escribirArchivo, type GithubDeps } from './github-contenido.js';

export type ResultadoDockerfileFront =
  | { estado: 'escrito' }
  | { estado: 'ya_estaba' }
  /** Sin package.json no hay build que hacer. */
  | { estado: 'no_aplica' }
  | { estado: 'error'; motivo: string };

/**
 * Node 24 para el build y nginx para servir. El sitio se busca por su
 * `index.html` y no por una ruta fija: Angular lo deja en `dist/` o en
 * `dist/<proyecto>/browser/` segun el builder, y Vite en `dist/`.
 */
export const DOCKERFILE_FRONT = [
  '# Para el VPS (Coolify): construye con Node 24 y sirve con nginx.',
  '# Lo escribe el sistema al publicar; si lo editas, tu version manda.',
  'FROM node:24-alpine AS build',
  'WORKDIR /app',
  'COPY package*.json ./',
  'RUN npm ci',
  'COPY . .',
  'RUN npm run build',
  "RUN mkdir /sitio && cp -r \"$(dirname \"$(find dist -name index.html -not -path '*/server/*' | head -1)\")\"/. /sitio/",
  '',
  'FROM nginx:alpine',
  '# SPA: cualquier ruta que no sea un archivo vuelve a index.html.',
  "RUN printf 'server {\\n  listen 80;\\n  root /usr/share/nginx/html;\\n  index index.html;\\n  location / { try_files $uri $uri/ /index.html; }\\n}\\n' > /etc/nginx/conf.d/default.conf",
  'COPY --from=build /sitio/ /usr/share/nginx/html/',
  'EXPOSE 80',
  '',
].join('\n');

const IGNORE = 'node_modules\ndist\n.angular\n.git\n';

export async function asegurarDockerfileDeFront(
  githubRepo: string,
  deps: GithubDeps,
): Promise<ResultadoDockerfileFront> {
  const pkg = await leerArchivo(githubRepo, 'package.json', deps);
  if (!pkg.ok) return pkg.noExiste ? { estado: 'no_aplica' } : { estado: 'error', motivo: pkg.motivo };

  const ya = await leerArchivo(githubRepo, 'Dockerfile', deps);
  if (ya.ok) return { estado: 'ya_estaba' };
  if (!ya.noExiste) return { estado: 'error', motivo: ya.motivo };

  const d = await escribirArchivo(
    githubRepo,
    'Dockerfile',
    DOCKERFILE_FRONT,
    '',
    'chore(deploy): Dockerfile para el VPS (Node 24 + nginx)\n\n' +
      'Nixpacks trae Node 22.11 y Angular pide >= 22.22. Lo escribe el sistema al publicar.',
    deps,
  );
  if (!d.ok) return { estado: 'error', motivo: d.motivo };

  // Sin .dockerignore, `COPY . .` mete node_modules de nadie: no pasa en un
  // repo limpio, pero es barato y evita builds de minutos de mas.
  const ig = await leerArchivo(githubRepo, '.dockerignore', deps);
  if (!ig.ok && ig.noExiste) {
    await escribirArchivo(githubRepo, '.dockerignore', IGNORE, '', 'chore(deploy): .dockerignore', deps);
  }
  return { estado: 'escrito' };
}
