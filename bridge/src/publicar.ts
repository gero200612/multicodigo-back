import { crearServicio, type RenderDeps } from './render-api.js';
import { CONFIG_DEL_FRONT, frontYBackDe, type ResultadoDeConfig } from './conectar.js';
import type { Store } from './store.js';

/**
 * Que se publica al cerrar una corrida, y que queda como cable suelto.
 *
 * Ver `multicodigo-vm/docs/superpowers/specs/2026-09-08-deploy-render-design.md`.
 *
 * Es politica pura: no habla HTTP con nadie. El merge y la creacion del
 * servicio entran por `deps`, asi que probar las decisiones de aca no necesita
 * ni un doble de fetch ni un worktree. `render-api.ts` es el que habla con
 * Render y no sabe nada de corridas; este sabe de corridas y no sabe de HTTP.
 */

export interface Publicado {
  repo: string;
  url: string;
}

export interface PublicarDeps {
  store: Pick<Store, 'reposDeProyecto' | 'guardarRenderServiceId'>;
  render: RenderDeps;
  mergear: (req: {
    agent: string;
    project: string;
    repo: string;
    creadoPorElBot: boolean;
  }) => Promise<{ ok: boolean; output: string }>;
  /**
   * Si el worktree del repo tiene `package.json`, y si usa SQLite.
   *
   * Entran como funciones porque miran el disco del GATEWAY, no el del bridge.
   * De paso, los tests de politica no necesitan un worktree de verdad.
   *
   * `agent` va PRIMERO y no cerrado en el adaptador porque el worktree es de un
   * slot: `worktreeFor(agent, project, repo)`. Con varios agentes hay que poder
   * preguntar por cada uno, y preguntarle al slot equivocado es exactamente el
   * bug que esto arregla — el repo se salteaba en silencio.
   */
  tienePackageJson: (agent: string, project: string, repo: string) => Promise<boolean>;
  usaSqlite?: (agent: string, project: string, repo: string) => Promise<boolean>;
  /**
   * Si el repo se puede ARRANCAR: si su `package.json` tiene script `start`.
   *
   * Render arranca con `npm start` —es el `startCommand` que manda
   * `render-api.ts`— asi que sin ese script el servicio nace roto. En la
   * corrida `publico2` del 2026-09-09 el deploy murio en 27 segundos con el
   * codigo entero y correcto en main.
   *
   * OPCIONAL: un gateway que todavia no devuelve el dato no puede dejar de
   * publicar todo. Sin esto se comporta como antes.
   */
  puedeArrancar?: (agent: string, project: string, repo: string) => Promise<boolean>;
  /**
   * Le pide a Render que despliegue un servicio que YA existe.
   *
   * Hace falta porque los servicios se crean con `autoDeploy: 'no'`: con un
   * repo publico Render no se entera de los push, asi que el deploy lo dispara
   * el sistema cuando mergea. Ver `dispararDeploy` en `render-api.ts`.
   *
   * OPCIONAL: sin esto, un repo que ya tiene servicio se saltea igual que
   * antes. Es el piso de siempre — nunca peor que hoy.
   */
  desplegar?: (serviceId: string) => Promise<{ ok: boolean; motivo?: string }>;
  /**
   * Setea una variable de entorno de un servicio, sin borrar las demas.
   *
   * Con esto el front se entera de donde quedo el back: una corrida que
   * construye dos servicios los publicaba SIN conocerse, y quedaba un paso
   * manual —editar una URL y desplegar— que se repite en cada proyecto.
   *
   * OPCIONAL: sin esto se publica igual que antes y el pendiente de siempre
   * pide hacerlo a mano.
   */
  setearEnvVar?: (
    serviceId: string,
    clave: string,
    valor: string,
  ) => Promise<{ ok: boolean; motivo?: string }>;
  /**
   * Reescribe el `config.js` del front para que apunte al back.
   *
   * El respaldo de `setearEnvVar`: la variable sola no alcanza si el front no
   * la lee, y en `mesas` no la leia. Ver `reescribirConfig` en `conectar.ts`.
   *
   * OPCIONAL por lo mismo que las demas: sin esto se conecta solo por entorno,
   * que es lo de antes.
   */
  reescribirConfig?: (githubRepo: string, url: string) => Promise<ResultadoDeConfig>;
}

/**
 * El texto que el sistema ya emite hoy, literal.
 *
 * El piso de esta feature es "nunca peor que hoy": un servidor sin Render
 * configurado tiene que dejar el mismo informe que dejaba antes.
 */
const PENDIENTE_A_MANO = (github: string) =>
  `conectar ${github} a Vercel o a Render (la primera vez es a mano; despues cada push hace un preview solo)`;

/**
 * @param agentes Los slots que TIENEN trabajo de esta corrida, en el orden en
 * que trabajaron. Salen de `agentesQueTrabajaron` y son un registro, no una
 * adivinanza. Van TODOS a main: con un relevo o con cowork el trabajo queda
 * repartido en ramas distintas, y elegir una seria tirar la otra.
 */
export async function publicar(
  proyectoId: string,
  proyecto: string,
  agentes: readonly string[],
  deps: PublicarDeps,
): Promise<{ publicados: Publicado[]; pendientes: string[] }> {
  const publicados: Publicado[] = [];
  const pendientes: string[] = [];
  /** El id del servicio de Render de cada repo publicado, por nombre. */
  const servicios = new Map<string, string>();
  /** El `owner/nombre` de GitHub de cada repo publicado, para reescribirle archivos. */
  const githubDe = new Map<string, string>();

  // EN SERIE y no en paralelo, por la misma razon que el bucle que crea los
  // repos en `pipeline.ts`: si el tercero falla, los dos primeros ya estan y el
  // mensaje puede decir exactamente cuales. En paralelo el estado queda mas
  // dificil de contar que de arreglar.
  for (const repo of await deps.store.reposDeProyecto(proyectoId)) {
    // Un repo que conecto una persona no se toca, y NO genera pendiente: no es
    // un cable suelto, es algo que no le corresponde a este sistema. La
    // diferencia importa — un pendiente le pide algo a alguien, y aca no hay
    // nada que pedir.
    if (!repo.creado_por_el_bot) continue;

    // Idempotencia: dos corridas sobre el mismo proyecto no pueden dejar dos
    // servicios facturando. Se mira lo guardado y no se le pregunta a Render:
    // preguntar significa buscar por nombre, y un nombre repetido no dice si el
    // servicio es de este proyecto o de otro que se llamo igual.
    //
    // Se mira ANTES de inspeccionar los worktrees: es el chequeo mas barato de
    // los dos y ahorra una llamada al gateway por agente.
    if (repo.render_service_id) {
      // Pero NO se saltea sin mas: hay que desplegar lo que la corrida acaba de
      // mergear. Los servicios se crean con `autoDeploy: 'no'` —con un repo
      // publico Render no se entera de los push— asi que saltear dejaria el
      // servicio corriendo la version vieja, sin que nada lo diga.
      //
      // El merge ya paso: cada tarea mergea a main durante la corrida.
      if (deps.desplegar) {
        const d = await deps.desplegar(repo.render_service_id);
        if (!d.ok) {
          // El codigo esta en main y el servicio existe: lo peor que pasa es
          // que la version nueva tarde hasta el proximo deploy. Se nombra y se
          // sigue con el repo que viene.
          pendientes.push(
            `no pude desplegar ${repo.nombre} en Render (${d.motivo ?? 'sin detalle'}): ` +
              'dale Deploy a mano desde el dashboard',
          );
        }
      }
      continue;
    }

    // Cual de los slots tiene ESTE repo. Un repo vacio —como quedo
    // `propinas-front`, que el pliego dejo sin contenido— no tiene nada que
    // arrancar, y despues de un relevo el slot original queda igual de vacio.
    // Ninguno de los dos casos es un pendiente: no falta nada.
    //
    // En serie por la misma razon que el bucle de afuera, y porque son a lo
    // sumo tres slots: el paralelismo no compra nada y hace el orden del
    // registro dificil de leer.
    const conTrabajo: string[] = [];
    for (const agente of agentes) {
      if (await deps.tienePackageJson(agente, proyecto, repo.nombre)) conTrabajo.push(agente);
    }
    if (conTrabajo.length === 0) continue;

    // TODAS las ramas van a main, en el orden en que se trabajo: el primero
    // entra limpio y el ultimo, si tocaron los mismos archivos, es el que
    // puede conflictuar.
    //
    // Y con cowork de verdad es PROBABLE que el segundo no entre: el gateway
    // mergea con `--ff-only` para no inventar un merge commit a las cuatro de
    // la mañana sobre trabajo que no es del agente, asi que dos ramas que
    // divergieron piden una decision que este proceso no puede tomar. Cuando
    // pasa, la rama queda pusheada y nombrada en el pendiente. Eso es el
    // resultado correcto, no una limitacion a tapar: lo que NO puede pasar
    // —y era el bug— es que el trabajo se pierda en silencio.
    const mergeados: string[] = [];
    for (const agente of conTrabajo) {
      const m = await deps.mergear({
        agent: agente,
        project: proyecto,
        repo: repo.nombre,
        creadoPorElBot: true,
      });
      if (m.ok) {
        mergeados.push(agente);
        continue;
      }
      // El fallo se NOMBRA con el slot y con lo que dijo git —un
      // `CONFLICT (content)` es una cosa y un `Not possible to fast-forward`
      // es otra— porque lo que queda es que una persona resuelva esa rama a
      // mano, y para eso tiene que saber cual es.
      pendientes.push(
        `no pude mergear ${repo.nombre} de ${agente} a main (${m.output}): mergealo a mano`,
      );
    }

    // Con ninguna rama adentro, main quedo como estaba: una URL que responde
    // contra eso es peor que ninguna URL, porque promete algo que no esta. Se
    // sigue con el repo que viene.
    //
    // Pero con UNA de dos alcanza para crear el servicio: hay codigo real
    // corriendo, y el pendiente de arriba ya dice que rama falta. Perder la URL
    // por un conflicto en la segunda rama seria castigar el trabajo que si
    // entro.
    if (mergeados.length === 0) continue;

    // Y ANTES de crear nada: que el proyecto se pueda arrancar.
    //
    // Render corre `npm start`, asi que un `package.json` sin ese script deja
    // un servicio que muere al primer deploy. Paso en la corrida `publico2` del
    // 2026-09-09: el trabajo estaba completo en main —endpoints, tests, el
    // server— y el deploy fallo en 27 segundos.
    //
    // Nadie hizo nada mal ahi: el plan pidio "script test", el agente lo hizo, y
    // el analista comparo contra un pliego que habla de endpoints y del puerto.
    // Lo que faltaba era que el sistema verificara el contrato que EL mismo
    // impone al desplegar.
    //
    // Un servicio que nace roto es peor que ninguno: ocupa el nombre, aparece
    // en el dashboard como si algo hubiera salido bien, y hay que ir a
    // borrarlo. Y el pendiente que queda en cambio es de los buenos: el trabajo
    // esta hecho y le falta una linea.
    //
    // Se pregunta por el slot que mergeo primero, igual que `usaSqlite`: lo que
    // se despliega es lo que quedo en main.
    if (deps.puedeArrancar && !(await deps.puedeArrancar(mergeados[0]!, proyecto, repo.nombre))) {
      pendientes.push(
        `${repo.nombre} no tiene script "start" en su package.json, asi que Render no lo puede ` +
          'arrancar: agregalo (por ejemplo "start": "node src/server.js") y volve a publicar',
      );
      continue;
    }

    const r = await crearServicio(repo.nombre, repo.github_repo, deps.render);
    if (r.estado === 'sin_render') {
      pendientes.push(PENDIENTE_A_MANO(repo.github_repo));
      continue;
    }
    if (r.estado === 'error') {
      pendientes.push(
        `no pude crear el servicio de ${repo.nombre} en Render (${r.motivo}): conectalo a mano`,
      );
      continue;
    }

    await deps.store.guardarRenderServiceId(proyectoId, repo.nombre, r.serviceId);
    publicados.push({ repo: repo.nombre, url: r.url });
    // El id del servicio se guarda aparte para poder conectarlos al final: el
    // informe muestra la URL, pero para tocar el servicio hace falta el id.
    servicios.set(repo.nombre, r.serviceId);
    githubDe.set(repo.nombre, repo.github_repo);

    // El cable que queda. Nombra el servicio Y la URL: a la mañana, con dos
    // proyectos nuevos, "carga las env vars" sin decir de cual no alcanza.
    pendientes.push(`cargar las env vars de ${repo.nombre} en Render (${r.url})`);

    // El disco efimero, que es el que muerde sin avisar: en el plan free se
    // borra en cada deploy y en cada spin-down. Un proyecto que guarda en
    // SQLite va a andar y va a perder los datos solo. Sin este aviso, la
    // primera perdida manda a buscar un bug que no existe.
    // Se le pregunta al primero que mergeo: el aviso es del REPO, no del slot,
    // y lo que quedo en main sale de esa rama. Preguntarles a todos daria el
    // mismo aviso repetido.
    if (await deps.usaSqlite?.(mergeados[0]!, proyecto, repo.nombre)) {
      pendientes.push(
        `${repo.nombre} guarda en SQLite y el plan free borra el disco en cada deploy: ` +
          'los datos no van a sobrevivir. Para que persistan hay que pasarlo a Postgres o pagar un disco',
      );
    }
  }

  // Ya publicados los dos, se conectan: el front no puede saber la URL del back
  // hasta que el back existe, y eso recien pasa aca.
  //
  // Va DESPUES del bucle a proposito. Adentro no se puede: cuando se publica el
  // front, el back todavia no tiene URL.
  const par = frontYBackDe(publicados);
  const idFront = par ? servicios.get(par.front.repo) : undefined;
  if (par && idFront && (deps.setearEnvVar || deps.reescribirConfig)) {
    // Dos caminos, y hacen falta los dos.
    //
    // La variable de entorno es el principal, pero SOLO sirve si el front la
    // lee: en `mesas` quedo seteada en Render y el front siguio apuntando a
    // `localhost`, porque su config.js tenia la URL escrita a mano. El informe
    // dio la conexion por hecha y no lo estaba.
    let porEntorno = false;
    let motivoEntorno: string | undefined;
    if (deps.setearEnvVar) {
      const r = await deps
        .setearEnvVar(idFront, 'API_URL', par.back.url)
        .catch((err) => ({ ok: false, motivo: err instanceof Error ? err.message : 'error' }));
      if (r.ok) porEntorno = true;
      else motivoEntorno = r.motivo ?? 'sin detalle';
    }

    let porConfig = false;
    let configCambiado = false;
    const githubFront = githubDe.get(par.front.repo);
    if (deps.reescribirConfig && githubFront) {
      const c: ResultadoDeConfig = await deps
        .reescribirConfig(githubFront, par.back.url)
        .catch((err) => ({
          estado: 'error' as const,
          motivo: err instanceof Error ? err.message : 'error',
        }));
      if (c.estado === 'cambiado') {
        porConfig = true;
        configCambiado = true;
      } else if (c.estado === 'igual') {
        porConfig = true;
      } else if (c.estado === 'error') {
        // Un error de verdad —GitHub contesto mal, el archivo cambio en el
        // medio— se nombra aunque la variable haya salido bien: si el front no
        // lee el entorno, esto es lo unico que lo conectaba.
        pendientes.push(
          `no pude apuntar el ${CONFIG_DEL_FRONT} de ${par.front.repo} al back ` +
            `(${c.motivo}): cambiale la URL a ${par.back.url} a mano`,
        );
      }
      // `sin_config` no dice nada, y a proposito: el front no tiene ese
      // archivo, asi que la URL la recibe por otro lado —el entorno, si esta—.
    }

    // Render NO aplica los cambios de variables solo —"Changes will not be
    // deployed automatically"— y el commit del config tampoco se despliega
    // solo con `autoDeploy: 'no'`. Un deploy alcanza para los dos.
    if (porEntorno || configCambiado) await deps.desplegar?.(idFront).catch(() => undefined);

    if (porEntorno || porConfig) {
      // El cable de las variables del FRONT ya esta conectado: pedirlo igual en
      // el informe mandaria a alguien a cargar algo que ya esta. El del back se
      // queda: ahi puede haber variables que solo la persona conoce.
      const i = pendientes.indexOf(
        `cargar las env vars de ${par.front.repo} en Render (${par.front.url})`,
      );
      if (i !== -1) pendientes.splice(i, 1);
    } else {
      pendientes.push(
        `no pude conectar ${par.front.repo} con ${par.back.repo} ` +
          `(${motivoEntorno ?? `no tiene ${CONFIG_DEL_FRONT} ni se le pudo setear la variable`}): ` +
          `seteale API_URL=${par.back.url} a mano`,
      );
    }
  }

  return { publicados, pendientes };
}
