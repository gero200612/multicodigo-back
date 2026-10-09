import { randomBytes } from 'node:crypto';
import { cifrar, descifrar } from './cifrado.js';
import * as coolify from './coolify-api.js';
import type { CoolifyDeps } from './coolify-api.js';
import { tipoDeRepo } from './render-api.js';
import { frontYBackDe, type ResultadoDeConfig } from './conectar.js';
import type { Publicado } from './publicar.js';
import type { EstadoVps, ParteVps, RecursoVps, RepoDelProyecto, Store } from './store.js';

/**
 * Publicar un proyecto de Punchi en el VPS: base, back y front, conectados.
 *
 * Ver `docs/superpowers/specs/2026-10-09-punchi-hosting-vps-design.md`.
 *
 * Politica pura, como `publicar.ts`: Coolify entra por `coolify-api.ts` y el
 * GitHub por las funciones de `deps`. Lo que decide este archivo:
 *
 * - Que se crea y que solo se despliega (idempotencia por `vps_recursos`).
 * - Que nunca se actua sobre algo que no este en `vps_recursos` del proyecto:
 *   apagar y borrar no buscan por nombre. SincroResto y Justadama estan en
 *   Coolify pero no aca, y por eso Punchi no los puede tocar.
 * - El freno de memoria: con menos de 1 GB libre no se crea ni se prende nada.
 */

export const DOMINIO_VPS = 'apps.punchi.dev';

/** Nombres que no puede tomar un proyecto: ya tienen dueño en `*.apps.punchi.dev`. */
export const RESERVADOS = new Set(['www', 'api', 'coolify', 'sincroresto', 'justadama', 'app', 'apps', 'panel', 'punchi']);

/** Con menos que esto libre, no se suma nada al VPS. */
export const MEMORIA_MINIMA_MB = 1024;

export interface UsoDelVps {
  memTotalMb: number;
  memDisponibleMb: number;
  discoTotalGb: number;
  discoLibreGb: number;
}

export interface VpsConfig {
  coolify: CoolifyDeps;
  /** Owner de GitHub (en minusculas) -> uuid de la GitHub App de Coolify que lo ve. */
  githubApps: Record<string, string>;
  /** Con que se cifra la conexion a la base. */
  clave: Buffer;
}

export interface VpsDeps {
  config: VpsConfig;
  store: Pick<
    Store,
    | 'recursosVps'
    | 'guardarRecursoVps'
    | 'estadoRecursoVps'
    | 'borrarRecursosVps'
    | 'guardarVinculoDeDestino'
    | 'guardarDestino'
  >;
  /** Memoria y disco del VPS. Sin esto no hay freno (se publica igual). */
  uso?: () => Promise<UsoDelVps | undefined>;
  /** Dockerfile del back .NET. `no_aplica` = no es .NET: va por Nixpacks. */
  asegurarDockerfileBack?: (githubRepo: string) => Promise<{ estado: string; motivo?: string }>;
  asegurarDockerfileFront?: (githubRepo: string) => Promise<{ estado: string; motivo?: string }>;
  asegurarOutputPath?: (githubRepo: string) => Promise<{ estado: string; motivo?: string }>;
  reescribirConfig?: (githubRepo: string, url: string) => Promise<ResultadoDeConfig>;
  /**
   * Cuanto esperar a que terminen los armados. 0 = no esperar (el panel mira
   * el estado despues). El cierre de una corrida espera, asi el informe dice
   * si el link anda.
   */
  esperarMs?: number;
  dormir?: (ms: number) => Promise<void>;
}

export interface ResultadoVps {
  publicados: Publicado[];
  pendientes: string[];
}

/** El nombre del proyecto como sale en el dominio: minusculas, numeros y guiones. */
export function nombreDeVps(nombre: string): string {
  return nombre
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
}

function parteDe(repo: string): ParteVps {
  const t = tipoDeRepo(repo);
  return t === 'node' ? 'app' : t;
}

function dominioDe(slug: string, repo: string): string {
  const t = tipoDeRepo(repo);
  if (t === 'front') return `${slug}.${DOMINIO_VPS}`;
  if (t === 'back') return `${slug}-api.${DOMINIO_VPS}`;
  return `${nombreDeVps(repo)}.${DOMINIO_VPS}`;
}

/** `Running:healthy` -> andando, `exited:...` -> apagado, el resto -> construyendo. */
export function estadoDeCoolify(crudo: string): EstadoVps {
  const c = crudo.toLowerCase();
  if (c.startsWith('running')) return 'andando';
  if (c.startsWith('exited') || c.startsWith('stopped')) return 'apagado';
  return 'construyendo';
}

function githubAppDe(githubRepo: string, config: VpsConfig): string | undefined {
  const owner = githubRepo.split('/')[0]?.toLowerCase() ?? '';
  return config.githubApps[owner];
}

const dormirDeVerdad = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Publica (o vuelve a desplegar) los repos de un proyecto en el VPS.
 *
 * @param repos Los repos que van al VPS, ya en `main`.
 */
export async function publicarEnVps(
  proyectoId: string,
  proyecto: string,
  repos: readonly RepoDelProyecto[],
  deps: VpsDeps,
): Promise<ResultadoVps> {
  const publicados: Publicado[] = [];
  const pendientes: string[] = [];
  const c = deps.config.coolify;
  const slug = nombreDeVps(proyecto);

  if (!slug || RESERVADOS.has(slug)) {
    return { publicados, pendientes: [`el nombre "${proyecto}" no se puede usar en el VPS: cambiale el nombre al proyecto`] };
  }
  const propios = repos.filter((r) => !r.solo_lectura);
  if (propios.length === 0) return { publicados, pendientes };

  const recursos = await deps.store.recursosVps(proyectoId);
  const de = (parte: ParteVps, repo = '') => recursos.find((r) => r.parte === parte && r.repo === repo);

  // ¿Esto suma memoria? Crear algo nuevo o prender algo apagado, si. Volver a
  // desplegar lo que ya anda, no: por eso no pasa por el freno.
  const hayBack = propios.some((r) => tipoDeRepo(r.nombre) === 'back');
  const suma =
    (hayBack && !de('base')) ||
    propios.some((r) => !de(parteDe(r.nombre), r.nombre)) ||
    recursos.some((r) => r.parte !== 'proyecto' && r.estado === 'apagado');
  if (suma && deps.uso) {
    const uso = await deps.uso().catch(() => undefined);
    if (uso && uso.memDisponibleMb < MEMORIA_MINIMA_MB) {
      return {
        publicados,
        pendientes: [
          `el VPS está lleno (quedan ${uso.memDisponibleMb} MB libres de ${uso.memTotalMb}): ` +
            'apagá algo desde Repositorios y volvé a publicar',
        ],
      };
    }
  }

  // Los dominios que ya usa OTRA cosa en el VPS: pisar uno es robarle el
  // trafico a otra app. Si no se puede listar, se sigue: Coolify igual rechaza.
  const ocupados = new Map<string, string>();
  const listado = await coolify.listarApps(c);
  if (listado.ok) {
    for (const a of listado.apps) for (const d of a.dominios) ocupados.set(d.replace(/^https?:\/\//, ''), a.uuid);
  }

  // 1. El proyecto de Coolify.
  let proyectoUuid = de('proyecto')?.coolify_uuid;
  if (!proyectoUuid) {
    const p = await coolify.crearProyecto(`punchi-${slug}`, c);
    if (!p.ok) return { publicados, pendientes: [`no pude crear el proyecto en el VPS (${p.motivo})`] };
    proyectoUuid = p.uuid;
    await deps.store.guardarRecursoVps({ proyecto_id: proyectoId, parte: 'proyecto', repo: '', coolify_uuid: p.uuid, url: null, secreto: null });
  }

  // 2. La base, si hay back.
  let conexion: string | undefined;
  let urlDeBase: string | undefined;
  if (hayBack) {
    const base = de('base');
    if (!base) {
      const password = randomBytes(24).toString('hex');
      const b = await coolify.crearBase(
        { proyecto: proyectoUuid, nombre: `${slug}-base`, usuario: 'app', password, base: 'app' },
        c,
      );
      if (!b.ok) {
        pendientes.push(`no pude crear la base en el VPS (${b.motivo}): el back queda sin base`);
      } else {
        conexion = `Host=${b.uuid};Port=5432;Database=app;Username=app;Password=${password}`;
        urlDeBase = `postgres://app:${password}@${b.uuid}:5432/app`;
        await deps.store.guardarRecursoVps({
          proyecto_id: proyectoId,
          parte: 'base',
          repo: '',
          coolify_uuid: b.uuid,
          url: null,
          secreto: cifrar(JSON.stringify({ conexion, url: urlDeBase }), deps.config.clave),
        });
        await deps.store.estadoRecursoVps(b.uuid, 'andando', null);
      }
    } else {
      try {
        const s = JSON.parse(descifrar(base.secreto ?? '', deps.config.clave)) as { conexion: string; url: string };
        conexion = s.conexion;
        urlDeBase = s.url;
      } catch {
        pendientes.push('no pude leer la conexión guardada de la base del VPS');
      }
      if (base.estado === 'apagado') {
        const p = await coolify.prender('databases', base.coolify_uuid, c);
        if (p.ok) await deps.store.estadoRecursoVps(base.coolify_uuid, 'andando', null);
        else pendientes.push(`no pude prender la base (${p.motivo})`);
      }
    }
  }

  // 3. Las apps: back primero (el front necesita su URL), despues el resto.
  const orden = [...propios].sort((a, b) => peso(a.nombre) - peso(b.nombre));
  const urls = new Map<string, string>();
  const enArmado: { uuid: string; repo: string; despliegue?: string }[] = [];
  const nuevosFront: { repo: RepoDelProyecto; uuid: string }[] = [];

  for (const repo of orden) {
    const tipo = tipoDeRepo(repo.nombre);
    const parte = parteDe(repo.nombre);
    const dominio = dominioDe(slug, repo.nombre);
    const url = `https://${dominio}`;
    let fila = de(parte, repo.nombre);

    const otro = ocupados.get(dominio);
    if (otro && otro !== fila?.coolify_uuid) {
      pendientes.push(`${dominio} ya lo usa otra app del VPS: no publiqué ${repo.nombre}`);
      continue;
    }

    // La infraestructura que el sistema sabe escribir, antes del deploy:
    // Coolify clona el repo en ese momento.
    let buildPack: 'dockerfile' | 'nixpacks' = 'dockerfile';
    let puerto = 80;
    if (tipo === 'back') {
      const d = await deps.asegurarDockerfileBack?.(repo.github_repo).catch((e) => ({ estado: 'error', motivo: String(e) }));
      if (d?.estado === 'error') pendientes.push(`no pude escribirle el Dockerfile a ${repo.nombre} (${d.motivo})`);
      if (d?.estado === 'no_aplica') {
        buildPack = 'nixpacks';
        puerto = 3000;
      } else puerto = 8080;
    } else if (tipo === 'front') {
      await deps.asegurarOutputPath?.(repo.github_repo).catch(() => undefined);
      const d = await deps.asegurarDockerfileFront?.(repo.github_repo).catch((e) => ({ estado: 'error', motivo: String(e) }));
      if (d?.estado === 'no_aplica') continue; // repo vacio: nada que publicar
      if (d?.estado === 'error') pendientes.push(`no pude escribirle el Dockerfile a ${repo.nombre} (${d.motivo})`);
    } else {
      buildPack = 'nixpacks';
      puerto = 3000;
    }

    if (!fila) {
      const app = githubAppDe(repo.github_repo, deps.config);
      if (!app) {
        pendientes.push(`el VPS no tiene acceso a la cuenta de GitHub de ${repo.github_repo}: falta su app de GitHub en Coolify`);
        continue;
      }
      const a = await coolify.crearApp(
        { proyecto: proyectoUuid, nombre: nombreDeVps(repo.nombre), githubApp: app, repo: repo.github_repo, buildPack, puerto, dominio: url },
        c,
      );
      if (!a.ok) {
        pendientes.push(`no pude crear ${repo.nombre} en el VPS (${a.motivo})`);
        continue;
      }
      await deps.store.guardarRecursoVps({ proyecto_id: proyectoId, parte, repo: repo.nombre, coolify_uuid: a.uuid, url, secreto: null });
      await deps.store.guardarVinculoDeDestino(proyectoId, repo.nombre, a.uuid, url);
      fila = { proyecto_id: proyectoId, parte, repo: repo.nombre, coolify_uuid: a.uuid, url, estado: 'creando', motivo: null, secreto: null, produccion: false, actualizado_el: '' };
      if (tipo === 'front') nuevosFront.push({ repo, uuid: a.uuid });
    }
    if (fila.produccion) continue;
    urls.set(repo.nombre, url);

    // Variables, antes del deploy.
    const frontUrl = `https://${slug}.${DOMINIO_VPS}`;
    if (tipo === 'back') {
      const vars: Record<string, string> = {
        ASPNETCORE_ENVIRONMENT: 'Production',
        Jwt__Key: randomBytes(48).toString('base64'),
        Cors__AllowedOrigins__0: frontUrl,
        FRONT_URL: frontUrl,
      };
      if (conexion) vars['ConnectionStrings__DefaultConnection'] = conexion;
      if (urlDeBase) vars['DATABASE_URL'] = urlDeBase;
      if (buildPack === 'nixpacks') vars['PORT'] = String(puerto);
      const v = await coolify.setearVariables(fila.coolify_uuid, vars, c, ['Jwt__Key']);
      if (!v.ok) pendientes.push(`no pude cargarle las variables a ${repo.nombre} (${v.motivo})`);
    } else if (buildPack === 'nixpacks') {
      await coolify.setearVariables(fila.coolify_uuid, { PORT: String(puerto) }, c);
    }

    // El front apunta al back ANTES de construirse: el build lo hornea.
    if (tipo === 'front' && deps.reescribirConfig) {
      const par = frontYBackDe(propios.map((r) => ({ repo: r.nombre, url: '' })));
      const backRepo = par?.back.repo;
      const backUrl = backRepo ? urls.get(backRepo) : undefined;
      if (backUrl) {
        const r = await deps.reescribirConfig(repo.github_repo, backUrl).catch((e) => ({ estado: 'error' as const, motivo: String(e) }));
        if (r.estado === 'error') pendientes.push(`no pude apuntar ${repo.nombre} al back (${r.motivo}): cambiale la URL a ${backUrl} a mano`);
      }
    }

    if (fila.estado === 'apagado') await coolify.prender('applications', fila.coolify_uuid, c);
    const d = await coolify.desplegar(fila.coolify_uuid, c);
    if (!d.ok) {
      pendientes.push(`no pude desplegar ${repo.nombre} en el VPS (${d.motivo})`);
      await deps.store.estadoRecursoVps(fila.coolify_uuid, 'fallo', d.motivo.slice(0, 300));
      continue;
    }
    await deps.store.estadoRecursoVps(fila.coolify_uuid, 'construyendo', null);
    enArmado.push({ uuid: fila.coolify_uuid, repo: repo.nombre, ...(d.despliegue ? { despliegue: d.despliegue } : {}) });
    if (tipo === 'front' || tipo === 'back') publicados.push({ repo: repo.nombre, url });
  }

  if ((deps.esperarMs ?? 0) > 0 && enArmado.length > 0) {
    const fallados = await esperarArmados(enArmado, deps);
    for (const f of fallados) {
      pendientes.push(`el armado de ${f.repo} falló en el VPS${f.log ? ` (${f.log})` : ''}: miralo en Repositorios`);
    }
  }
  return { publicados, pendientes };
}

function peso(repo: string): number {
  const t = tipoDeRepo(repo);
  return t === 'back' ? 0 : t === 'node' ? 1 : 2;
}

/** Sigue los deploys hasta que terminen o se acabe el tiempo. Devuelve los que fallaron. */
async function esperarArmados(
  enArmado: { uuid: string; repo: string; despliegue?: string }[],
  deps: VpsDeps,
): Promise<{ repo: string; log?: string }[]> {
  const dormir = deps.dormir ?? dormirDeVerdad;
  const limite = Date.now() + (deps.esperarMs ?? 0);
  const pendientes = new Map(enArmado.filter((a) => a.despliegue).map((a) => [a.uuid, a]));
  const fallados: { repo: string; log?: string }[] = [];
  while (pendientes.size > 0 && Date.now() < limite) {
    await dormir(10_000);
    for (const [uuid, a] of [...pendientes]) {
      const e = await coolify.estadoDeDespliegue(a.despliegue!, deps.config.coolify);
      if (!e.ok) continue;
      if (e.estado === 'finished') {
        pendientes.delete(uuid);
        await deps.store.estadoRecursoVps(uuid, 'andando', null);
      } else if (e.estado === 'failed' || e.estado.startsWith('cancelled')) {
        pendientes.delete(uuid);
        await deps.store.estadoRecursoVps(uuid, 'fallo', e.log ?? 'el armado falló');
        fallados.push({ repo: a.repo, ...(e.log ? { log: e.log } : {}) });
      }
    }
  }
  return fallados;
}

/** Lo que se muestra en Repositorios, sin secretos. */
export interface ParteVisible {
  parte: ParteVps;
  repo: string;
  url: string | null;
  estado: EstadoVps;
  motivo: string | null;
  produccion: boolean;
}

export interface EstadoDelProyectoEnVps {
  configurado: boolean;
  partes: ParteVisible[];
  uso?: UsoDelVps;
  /** Lo demas que corre en el VPS: se ve, no se toca desde aca. */
  otros: { nombre: string; url: string | null; estado: EstadoVps }[];
  /** Si es una demo de Homero: cuando se apaga sola (ISO). */
  demoApagarEl?: string;
}

/** El estado, refrescado contra Coolify. */
export async function estadoEnVps(proyectoId: string, deps: VpsDeps): Promise<EstadoDelProyectoEnVps> {
  const c = deps.config.coolify;
  const recursos = await deps.store.recursosVps(proyectoId);
  const partes: ParteVisible[] = [];
  for (const r of recursos) {
    if (r.parte === 'proyecto') continue;
    let estado = r.estado;
    const e = await coolify.estadoDe(r.parte === 'base' ? 'databases' : 'applications', r.coolify_uuid, c);
    if (e.ok) {
      const real = estadoDeCoolify(e.crudo);
      // Mientras construye por primera vez Coolify dice `exited`: no es
      // "apagado". Y un fallo se queda hasta que vuelva a andar.
      const armandoHace = Date.now() - Date.parse(r.actualizado_el);
      const sigueArmando = r.estado === 'construyendo' && real !== 'andando' && armandoHace < 25 * 60_000;
      if (!sigueArmando && !(r.estado === 'fallo' && real !== 'andando')) estado = real;
      if (estado !== r.estado) await deps.store.estadoRecursoVps(r.coolify_uuid, estado, estado === 'fallo' ? r.motivo : null);
    }
    partes.push({ parte: r.parte, repo: r.repo, url: r.url, estado, motivo: estado === 'fallo' ? r.motivo : null, produccion: r.produccion });
  }
  const propios = new Set(recursos.map((r) => r.coolify_uuid));
  const otros: EstadoDelProyectoEnVps['otros'] = [];
  const l = await coolify.listarApps(c);
  if (l.ok) {
    for (const a of l.apps) {
      if (propios.has(a.uuid)) continue;
      otros.push({ nombre: a.nombre, url: a.dominios[0] ?? null, estado: estadoDeCoolify(a.estado) });
    }
  }
  const uso = await deps.uso?.().catch(() => undefined);
  return { configurado: true, partes, otros, ...(uso ? { uso } : {}) };
}

const ORDEN_APAGADO: ParteVps[] = ['front', 'app', 'back', 'base'];

function tipoDe(parte: ParteVps): coolify.TipoDeRecurso {
  return parte === 'base' ? 'databases' : 'applications';
}

/** Frena todo lo del proyecto. Datos y configuracion quedan. */
export async function apagarEnVps(proyectoId: string, deps: VpsDeps): Promise<{ ok: boolean; pendientes: string[] }> {
  const pendientes: string[] = [];
  const recursos = await deps.store.recursosVps(proyectoId);
  if (recursos.some((r) => r.produccion)) return { ok: false, pendientes: ['es producción: no se apaga desde Punchi'] };
  for (const parte of ORDEN_APAGADO) {
    for (const r of recursos.filter((x) => x.parte === parte)) {
      const a = await coolify.apagar(tipoDe(parte), r.coolify_uuid, deps.config.coolify);
      if (a.ok) await deps.store.estadoRecursoVps(r.coolify_uuid, 'apagado', null);
      else pendientes.push(`no pude apagar ${r.repo || 'la base'} (${a.motivo})`);
    }
  }
  return { ok: pendientes.length === 0, pendientes };
}

/**
 * Borra todo lo del proyecto del VPS, base y datos incluidos. Pide el nombre
 * del proyecto escrito: la confirmacion se chequea aca y no solo en la pantalla.
 */
export async function borrarDelVps(
  proyectoId: string,
  proyecto: string,
  confirmacion: string,
  deps: VpsDeps,
): Promise<{ ok: boolean; pendientes: string[] }> {
  if (confirmacion.trim() !== proyecto) {
    return { ok: false, pendientes: ['para borrar, escribí el nombre del proyecto tal cual'] };
  }
  const recursos = await deps.store.recursosVps(proyectoId);
  if (recursos.some((r) => r.produccion)) return { ok: false, pendientes: ['es producción: no se borra desde Punchi'] };
  const pendientes: string[] = [];
  for (const parte of ORDEN_APAGADO) {
    for (const r of recursos.filter((x) => x.parte === parte)) {
      const b = await coolify.borrar(tipoDe(parte), r.coolify_uuid, deps.config.coolify);
      if (!b.ok) pendientes.push(`no pude borrar ${r.repo || 'la base'} (${b.motivo})`);
    }
  }
  if (pendientes.length > 0) return { ok: false, pendientes };
  const p = recursos.find((r) => r.parte === 'proyecto');
  if (p) {
    // Coolify borra las apps en segundo plano: el proyecto puede tardar en
    // quedar vacio. Si todavia no se deja, queda vacio y no molesta.
    await coolify.borrarProyecto(p.coolify_uuid, deps.config.coolify);
  }
  await deps.store.borrarRecursosVps(proyectoId);
  // El repo sigue yendo al VPS, pero sin vinculo: el proximo Publicar arranca de cero.
  for (const r of recursos.filter((x) => x.repo)) {
    await deps.store.guardarDestino(proyectoId, r.repo, null);
    await deps.store.guardarDestino(proyectoId, r.repo, 'vps');
  }
  return { ok: true, pendientes: [] };
}

/** Lo que dice el aviso del dia antes, y el de apagado. */
export interface AvisoDeDemo {
  proyectoId: string;
  texto: string;
}

/**
 * Las demos de Homero: aviso el dia antes, y apagado al vencer. Nunca borra.
 */
export async function revisarDemos(
  deps: VpsDeps & {
    demos: Pick<Store, 'demosPorVencer' | 'marcarDemoAvisada' | 'guardarDemoApagarEl'>;
    avisar: (aviso: AvisoDeDemo) => Promise<void>;
    ahora?: () => number;
  },
): Promise<void> {
  const ahora = deps.ahora?.() ?? Date.now();
  for (const d of await deps.demos.demosPorVencer(24)) {
    const recursos = await deps.store.recursosVps(d.proyectoId);
    const prendido = recursos.some((r) => r.parte !== 'proyecto' && r.estado !== 'apagado');
    if (Date.parse(d.apagarEl) <= ahora) {
      if (prendido) {
        const a = await apagarEnVps(d.proyectoId, deps);
        await deps.avisar({
          proyectoId: d.proyectoId,
          texto: a.ok
            ? `Apagué la demo ${d.nombre} del VPS (pasaron 14 días de la reunión). Vuelve con "Publicar" en Repositorios.`
            : `Quise apagar la demo ${d.nombre} y no pude: ${a.pendientes.join('; ')}`,
        });
      }
      await deps.demos.guardarDemoApagarEl(d.proyectoId, null);
    } else if (!d.avisada && prendido) {
      await deps.avisar({
        proyectoId: d.proyectoId,
        texto: `Mañana apago la demo ${d.nombre} del VPS. Si la querés prendida, tocá "Mantener prendida" en Repositorios.`,
      });
      await deps.demos.marcarDemoAvisada(d.proyectoId);
    }
  }
}

export type { RecursoVps };
