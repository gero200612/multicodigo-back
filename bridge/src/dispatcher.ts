import { Agent, setGlobalDispatcher } from 'undici';

/**
 * Sube el techo REAL de un turno, que no era el que decia el codigo.
 *
 * ## El bug
 *
 * `pedirTurno` en `agents-client.ts` pasa `AbortSignal.timeout(20 * 60 * 1000)`
 * al fetch contra el gateway. Pero undici —el cliente HTTP que hay abajo del
 * `fetch` de Node— tiene su PROPIO techo: `headersTimeout`, 300 segundos por
 * defecto, contados hasta que llega la primera cabecera. Y del otro lado nadie
 * contesta nada hasta que el turno del agente termina.
 *
 * O sea que el techo de verdad eran 5 minutos, no 20, y una tarea mas larga
 * moria con un `TypeError: fetch failed` — un error de red, para algo que no
 * tenia nada que ver con la red.
 *
 * Medido en la corrida `despacho2` (2026-09-10): las cuatro tareas del back
 * tardaron 85, 197, 161 y 281 segundos y salieron bien; las tres del front
 * —armar React con su `npm install`— fallaron a los **302 segundos exactos, las
 * tres**. Tres fallas seguidas alcanzan el techo de fallos, asi que la corrida
 * cerro sola con dos tareas sin empezar e informo "demasiados_fallos". Nada
 * estaba roto: el trabajo tardaba mas de cinco minutos.
 *
 * La pared estaba en los DOS lados de la cadena —el bridge llama al gateway y
 * el gateway al agente— asi que arreglar uno solo no cambiaba nada. El gemelo
 * de este archivo vive en `multicodigo-vm/src/gateway/src/dispatcher.ts`.
 *
 * ## Por que global y no en cada fetch
 *
 * `dispatcher` como opcion de `fetch` es de undici y no del estandar, asi que
 * ponerlo en cada llamada ataria cada punto del codigo a un detalle del cliente
 * HTTP. Un dispatcher global se declara una vez, en el arranque, y no cambia
 * nada mas: los `AbortSignal.timeout` de 5, 10 y 30 segundos que usa el resto
 * del bridge siguen siendo mas estrictos que esto y siguen cortando ellos.
 *
 * Se importa por su efecto, arriba de todo en `main.ts`: tiene que correr antes
 * del primer fetch.
 */

/**
 * 22 minutos, arriba de los 20 del turno.
 *
 * A propósito por encima y no igual: el que tiene que cortar es el
 * `AbortSignal` del turno, porque su error se distingue
 * (`isTimeoutError` -> "el agente no respondio a tiempo"). Si cortara undici
 * primero, el mismo caso volveria a aparecer como `fetch failed` y a leerse
 * como un problema de red — que es exactamente lo que hizo perder una noche.
 *
 * Y por encima tambien de los 20 del gateway: en una cadena, el de afuera
 * espera un poco mas que el de adentro, asi que el error que llega es el del
 * eslabon que de verdad se colgo.
 */
const TECHO_MS = 22 * 60 * 1000;

setGlobalDispatcher(
  new Agent({
    headersTimeout: TECHO_MS,
    // El body llega junto con las cabeceras en una respuesta JSON, pero se sube
    // igual: su default son otros 300 segundos, y una respuesta grande cortada
    // a la mitad seria el mismo bug con otro nombre.
    bodyTimeout: TECHO_MS,
  }),
);
