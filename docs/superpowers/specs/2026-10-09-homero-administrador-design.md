# Homero: el Administrador (finanzas, precios y entregas)

Fecha: 2026-10-09. Estado: diseño aprobado en charla, falta revisión del spec.
Reemplaza a Patán: Patán deja de existir como personaje y lo hace Homero.

## Por qué

Punchi y Homero ya andan. Gero le pone 70-80 h por semana y todavía no entra
plata. Necesita saber cuánto gasta (cuentas de Claude, publicidad, su tiempo),
cuánto le cuesta cada app, a cuánto venderla para que deje plata, y entregarla
bien armada. Hoy nada de eso existe: Patán solo arma el presupuesto después de una
reunión, con una regla fija.

## Qué entendimos (lo que dijo Gero / lo que se asume)

- Dijo: las tres cosas, ver si la empresa gana o pierde, ponerle precio a cada
  app según lo que cuesta y que diga dónde poner la plata.
- Dijo: hoy paga **3 cuentas Claude Pro de USD 20**. No hay otros fijos todavía.
  Después vienen una prepaga de celular y una VPS. Los dominios ya los tiene y el
  server es local.
- Dijo: su tiempo **no es un sueldo fijo**: lo que busca es que le dé plata.
  Le dedica **~75 h/semana**.
- Dijo: las horas por app **las estima Homero solo** (opción B), sin carga a mano.
- Dijo: **todavía no entra nada**. Todo arranca en cero.
- Dijo: regla de precios = el mayor entre valor para el cliente y costo + margen.
  **Armado mínimo USD 400**, **abono mínimo USD 50**, su hora vale **USD 15**
  (solo para el piso por costo).
- Dijo: el gasto de Claude sale de **cuántas cuentas están vinculadas**, no de un
  número cargado.
- Dijo: la entrega pide a Punchi el análisis funcional completo y un **usuario
  administrador nuevo** para el cliente (opción B), y arma **dos PDFs**: ficha de
  la aplicación y guía de uso. Le llegan **a él** (Telegram + panel) y él se los
  pasa al cliente (opción A).
- Dijo: las recomendaciones van con botones **"Hacelo" / "No"** (opción C).
- Dijo: **sin identidad de Patán**: todo es Homero.
- Se asume: precios al cliente en **USD**. Lo que se paga en pesos (Meta) se pasa
  a dólares con el **dólar tarjeta** del día, de una API gratis de cotizaciones.
  Margen sobre costo por defecto **30%**, editable.
- Éxito:
  - Gero abre el Administrador y ve el mes: gastado, entrado, resultado, sus
    horas y cuánto deja cada hora.
  - Cada cotización nunca queda por debajo de lo que cuesta la app.
  - Una app lista se entrega con dos PDFs revisados sin escribir nada a mano.

## 1. Dónde vive

- **Un cuarto agente de Homero: `administrador`**, al lado de buscador, vendedor
  y atención. Tiene su tarjeta en el tablero, su página `/homero/administrador` y
  pestañas. `/patan` redirige a `/homero/administrador/precios`.
- **Back:** módulos nuevos en `homero/src/` (`finanzas.ts`, `costos.ts`,
  `entrega.ts`, `analista.ts`), en la misma base (esquema `homero`), la misma cola
  y el mismo Telegram.
  - Lo de `patan.ts` (regla y presupuestos) se mueve a `precios.ts`. Los datos
    guardados se conservan: la clave `patan:regla` se migra a `precios:regla`.
- **Datos de Punchi:** se piden al bridge por rutas internas nuevas, con el mismo
  token y la misma red que ya usa Homero para las demos (`enlace_homero`). Ver §7.
- **El agente piensa** como los otros: objetivo + herramientas MCP + libreta, sin
  guiones fijos. Las herramientas devuelven números **ya calculados**; Claude
  razona sobre esos datos y no inventa cifras.

## 2. Pestañas del Administrador

1. **Números:** el mes en curso.
   - Gastado: Claude, Meta y fijos. Entrado: pagos. Resultado.
   - Tus horas estimadas y **USD por hora tuya** = (entrado − gastado) ÷ horas.
   - Mientras no entre nada: cuánto hay que vender para cubrir los gastos del mes
     (en clientes de abono mínimo).
   - Selector de mes.
2. **Apps:** una fila por proyecto.
   - Costo de armarla: horas tuyas, parte de Claude, tiempo de máquina.
   - Costo mensual de mantenerla.
   - Lo cobrado y lo que deja por hora tuya.
3. **Gastos e ingresos:** alta, edición y baja de gastos fijos, del plan de cada
   cuenta de Claude, de clientes y de pagos.
4. **Precios:** la regla (editable) y los presupuestos. Es lo que hoy hace Patán,
   más el piso por costo.
5. **Entregas:** el proyecto, el botón "Preparar entrega", el paso en que está
   cada una y sus dos PDFs.
6. **Recomendaciones:** lo que propuso, con números, y lo que elegiste; los
   "Anotado" pendientes.

## 3. Costos

- **Claude:**
  - Cantidad de cuentas = las vinculadas en Punchi (slots con credencial, del
    panorama del bridge).
  - Cada una × el precio de su plan. Por defecto Pro USD 20; editable por cuenta
    si alguna pasa a Max.
  - Se cuenta por día. Una cuenta vinculada a mitad de mes paga la parte
    proporcional del mes.
- **Reparto de Claude y de la VPS entre apps:** según tokens usados por cada
  proyecto en el mes (de los turnos y las corridas que ya registran consumo). Un
  mes sin tokens no reparte nada: el gasto queda como "sin asignar".
- **Publicidad:** de `homero.gastos` (Meta, en ARS), pasada a USD con la
  cotización del día.
  - No es costo de una app: es **costo de conseguir clientes**.
  - Se muestra con costo por consulta, por reunión y por cliente cerrado.
- **Tiempo de máquina:** suma de duraciones de turnos y corridas por proyecto. Se
  muestra; cuesta plata solo vía el reparto de la VPS.
- **Horas de Gero (estimadas):**
  - Eventos de Gero por proyecto en Punchi: turnos/tickets/preguntas que mandó,
    aprobaciones que decidió, publicaciones, mensajes del chat del proyecto.
  - Se agrupan en sesiones: eventos con menos de 30 min entre sí son una sesión,
    que cuenta su duración + 10 min.
  - Se muestran como **mínimo estimado**.
- **Costo de una app:**
  - Armarla = horas de Gero × USD 15 + su parte de Claude mientras se hizo.
  - Mantenerla por mes = su parte de Claude y VPS + horas de soporte del abono ×
    USD 15.
- **Cotizaciones:** armado = máx(valor, costo × 1,30, USD 400); abono = máx(valor,
  costo mensual × 1,30, USD 50).
  - Para una app que todavía no existe, el costo se estima con el promedio de las
    apps ya hechas. Sin ninguna, se usa el mínimo.
  - La justificación (valor vs. costo) la ve solo Gero, como hoy.

## 4. Datos (tablas nuevas en el esquema `homero`)

- `fijos`: nombre, monto, moneda (ARS/USD), periodo (mensual/anual), desde, hasta.
- `cuentas_claude`: slot, plan, precio USD. La cantidad viene de Punchi; esta tabla
  solo guarda el plan de cada una.
- `clientes`: nombre, proyecto, armado y abono acordados (USD), desde, estado.
- `pagos`: cliente, fecha, monto, moneda, concepto (armado/abono/otro).
- `cotizaciones`: día, dólar tarjeta. Se guarda: un mes cerrado no cambia si se
  mueve el dólar.
- `entregas`: proyecto, paso, usuario del cliente (contraseña cifrada con la clave
  de Homero), análisis (id de corrida), PDFs, revisión, error.
- `recomendaciones`: tipo, texto, números, acción propuesta (JSON), estado
  (propuesta/hecha/rechazada/anotada), mensaje de Telegram.

Las horas y los costos por app **no se guardan**: se calculan con lo que trae
Punchi. Corregir el cálculo corrige también el pasado.

## 5. El analista (`agente_administrar`)

**Cuándo corre:**
- Todos los días a las 20 h, con un aviso solo si hay algo para decir.
- Los lunes, el resumen semanal.
- El día 1, el cierre del mes anterior con la comparación contra el previo.
- Lo encola el planificador, con la misma clave por día que el resto.

**Herramientas (MCP de Homero):**
- `numeros_del_mes`, `costos_por_app`, `horas_por_app`, `publicidad`,
  `cuentas_claude` (incluye cuántas veces llegaron al límite y cuántos turnos
  frenó), `regla_de_precios`.
- `recomendar(tipo, texto, numeros, accion?)` y `libreta`.

**Recomendaciones:** van por Telegram con "Hacelo" / "No".
- "Hacelo" ejecuta **solo**:
  - mover presupuesto entre anuncios ya aprobados (`repartirPresupuesto`);
  - pausar un anuncio;
  - cambiar un número de la regla de precios.
- Lo que Homero no puede hacer (contratar o dar de baja una cuenta, la VPS) viene
  con "Anotado" y queda pendiente en la pestaña.
- Antes de proponer, mira las rechazadas de los últimos 30 días. No repite la
  misma propuesta con los mismos números.

**Nunca, ni con "Hacelo":** crear anuncios, gastar plata nueva, subir el
presupuesto del mes. Esas siguen yendo por su aprobación de siempre.

## 6. La entrega (`entrega`)

Arranca con "Preparar entrega" en la pestaña. Pasos, cada uno retomable:

1. **Usuario del cliente:** le pide al bridge que Punchi cree un usuario
   administrador en la app publicada. La contraseña la genera Homero y se guarda
   cifrada.
2. **Análisis funcional:** le pide al bridge una corrida de análisis funcional
   completo con capturas, entrando con ese usuario.
3. **PDF 1, Ficha de la aplicación** (marca Sincro):
   - qué es y qué resuelve, links;
   - usuario y contraseña;
   - abono mensual y qué incluye (horas de soporte, hosting), cómo pedir soporte;
   - datos importantes: dónde está alojada, de quién son los datos, backups.
4. **PDF 2, Guía de uso:** el análisis pasado a manual para el cliente: pantalla
   por pantalla con capturas, cómo hacer cada tarea, preguntas frecuentes. Sin
   nada técnico.
5. **Revisión:** un agente revisor lee los dos PDFs (8+ en cada criterio, máx. 3
   vueltas). Si no pasa, la entrega queda en "no pasó la revisión" con lo que
   falló, y Gero puede reintentar.
6. **A Gero:** los dos PDFs por Telegram y en la pestaña. Él se los pasa al
   cliente.

**El abono de la ficha:** sale del cliente con ese proyecto. Si no hay, Homero lo
calcula con la regla y le pide a Gero que lo confirme antes de armar el PDF.

Los PDFs se arman como hoy los presupuestos (`pdf.ts`), del lado del servidor, para
que salgan iguales en Telegram y en el panel.

## 7. Rutas internas nuevas en el bridge (para Homero)

Con el token interno de Homero y solo por `enlace_homero`:

- `GET /interno/finanzas/cuentas`: los slots con credencial (cantidad y cuáles).
- `GET /interno/finanzas/consumo?desde&hasta`: tokens y duración por proyecto y
  por día (turnos + corridas).
- `GET /interno/finanzas/actividad?desde&hasta`: eventos de Gero por proyecto
  (tipo, instante). Solo los de `HOMERO_USUARIO_ID`.
- `GET /interno/finanzas/limites?desde&hasta`: veces que cada cuenta llegó al
  límite y turnos que se frenaron.
- `POST /interno/entrega/usuario` y `POST /interno/entrega/analisis`: abren la
  tarea en Punchi (como `/interno/corrida/desde-homero`).
- `GET /interno/entrega/:id/estado`: Homero lo consulta cada 5 min, como las
  demos.

## 8. Fallas

- **Bridge o Punchi caídos:** las pestañas muestran lo que hay y avisan "sin datos
  de Punchi ahora". El analista posterga esa vuelta y no estima.
- **API del dólar caída:** se usa la última cotización guardada, y se marca.
- **Herramienta del analista que falla:** ese análisis no se manda. Nada de cifras
  inventadas.
- **Entrega:** queda en el paso que falló, con el motivo y "Reintentar" desde ahí.

## 9. Pruebas

- **Cuentas:**
  - reparto de Claude por tokens, con "sin asignar";
  - cuenta vinculada a mitad de mes;
  - sesiones de horas (corte a 30 min, +10 min);
  - piso por costo y mínimos (400 / 50);
  - conversión con la cotización guardada.
- **Analista:**
  - "Hacelo" solo ejecuta las tres acciones permitidas;
  - una rechazada no se vuelve a proponer igual;
  - sin datos no recomienda.
- **Entrega:**
  - pasos con Punchi falso;
  - retomar desde el que falló;
  - la contraseña nunca va a la IA ni al log;
  - el revisor descarta a las 3 vueltas.
- **Rutas del bridge:** token, red y filtro por `HOMERO_USUARIO_ID`.

## 10. Orden de implementación

Cuatro entregas, cada una anda sola:

1. **Números + Gastos e ingresos:**
   - tablas `fijos`, `cuentas_claude`, `clientes`, `pagos` y `cotizaciones`;
   - ruta `cuentas`;
   - publicidad en USD y la pestaña Números;
   - Patán pasa a la pestaña Precios con la regla nueva (400 / 50 / USD 15 /
     30%), y `/patan` redirige.
2. **Apps:** rutas `consumo` y `actividad`, costos por app, horas estimadas y el
   piso por costo en las cotizaciones.
3. **Analista:** `agente_administrar`, herramientas, recomendaciones con botones y
   ruta `limites`.
4. **Entregas:** usuario del cliente, análisis funcional, los dos PDFs y el revisor.

## Fuera de alcance

- Facturación o cobro automático (AFIP, Mercado Pago): los pagos se cargan a mano.
- Que Homero contrate o dé de baja cuentas o la VPS.
- Mandarle los PDFs al cliente por mail (Gero los pasa él).
