import type {
  Alerta,
  Cambio,
  CambiosDeEvento,
  CambiosDeMensaje,
  CambiosDeNegocio,
  CambiosDeNumero,
  CambiosDePlantilla,
  CambiosDeTrabajo,
  Contacto,
  Evento,
  Media,
  Mensaje,
  Negocio,
  NuevaPlantilla,
  NuevoMensaje,
  NuevoNegocio,
  NuevoTrabajo,
  Numero,
  Plantilla,
  Precio,
  Saliente,
  Store,
  TipoDeEventoGuardado,
  TipoDeTrabajo,
  TrabajoIa,
  UsoIa,
} from '../src/store.js';

/**
 * La base en memoria para los tests. Imita lo que hace `PgStore` (db.ts),
 * incluidos los unicos (wamid, phone_number_id, plantilla por negocio) y los
 * filtros, que es de donde salen las reglas.
 */
export class MemoriaStore implements Store {
  negociosT: Negocio[] = [];
  numerosT: Numero[] = [];
  contactosT: Contacto[] = [];
  mensajesT: Mensaje[] = [];
  mediaT: Media[] = [];
  plantillasT: Plantilla[] = [];
  preciosT: Precio[] = [
    { categoria: 'marketing', precioArs: 89.562, desde: new Date(0) },
    { categoria: 'utility', precioArs: 37.6798, desde: new Date(0) },
    { categoria: 'authentication', precioArs: 37.6798, desde: new Date(0) },
    { categoria: 'service', precioArs: 0, desde: new Date(0) },
  ];
  dolarT: { arsPorUsd: number; desde: Date }[] = [];
  usoIaT: UsoIa[] = [];
  cambiosT: Cambio[] = [];
  eventosT: Evento[] = [];
  trabajosT: TrabajoIa[] = [];
  alertasT: Alerta[] = [];
  intentosNegados: { negocioId: number; metodo: string; ruta: string; fecha: Date }[] = [];
  webhooksT: { numeroId: number; fecha: Date }[] = [];
  private ids = new Map<string, number>();

  private id(tabla: string): number {
    const n = (this.ids.get(tabla) ?? 0) + 1;
    this.ids.set(tabla, n);
    return n;
  }

  async crearNegocio(n: NuevoNegocio, fecha: Date) {
    const nuevo: Negocio = {
      ...n,
      id: this.id('negocios'),
      activo: true,
      claveHash: null,
      claveUltimoUso: null,
      contextoAtender: '',
      creado: fecha,
    };
    this.negociosT.push(nuevo);
    return { ...nuevo };
  }
  async negocio(id: number) {
    const n = this.negociosT.find((x) => x.id === id);
    return n ? { ...n, capacidades: [...n.capacidades] } : undefined;
  }
  async negocios() {
    return this.negociosT.map((n) => ({ ...n }));
  }
  async cambiarNegocio(id: number, c: CambiosDeNegocio) {
    const n = this.negociosT.find((x) => x.id === id);
    if (n) Object.assign(n, sinIndefinidos(c));
    return this.negocio(id);
  }
  async usoDeClave(id: number, fecha: Date) {
    const n = this.negociosT.find((x) => x.id === id);
    if (n) n.claveUltimoUso = fecha;
  }
  async registrarCambios(c: Cambio[]) {
    for (const x of c) this.cambiosT.push({ ...x, id: this.id('cambios') });
  }
  async cambios(negocioId?: number) {
    return this.cambiosT.filter((c) => negocioId === undefined || c.negocioId === negocioId).reverse();
  }

  async crearNumero(n: Pick<Numero, 'negocioId' | 'phoneNumberId' | 'wabaId' | 'tokenCifrado'>) {
    if (this.numerosT.some((x) => x.phoneNumberId === n.phoneNumberId)) return undefined;
    const nuevo: Numero = {
      ...n,
      id: this.id('numeros'),
      calidad: null,
      topeMeta: null,
      estado: null,
      nombreVerificado: null,
      sinMensajesAlertado: false,
    };
    this.numerosT.push(nuevo);
    return { ...nuevo };
  }
  async numero(id: number) {
    const n = this.numerosT.find((x) => x.id === id);
    return n ? { ...n } : undefined;
  }
  async numeroPorPhoneId(p: string) {
    const n = this.numerosT.find((x) => x.phoneNumberId === p);
    return n ? { ...n } : undefined;
  }
  async numerosDe(negocioId: number) {
    return this.numerosT.filter((n) => n.negocioId === negocioId).map((n) => ({ ...n }));
  }
  async numerosDeWaba(wabaId: string) {
    return this.numerosT.filter((n) => n.wabaId === wabaId).map((n) => ({ ...n }));
  }
  async todosLosNumeros() {
    return this.numerosT.map((n) => ({ ...n }));
  }
  async cambiarNumero(id: number, c: CambiosDeNumero) {
    const n = this.numerosT.find((x) => x.id === id);
    if (n) Object.assign(n, sinIndefinidos(c));
  }

  async contacto(numeroId: number, c: string) {
    const x = this.contactosT.find((k) => k.numeroId === numeroId && k.contacto === c);
    return x ? { ...x } : undefined;
  }
  async contactosDe(negocioId: number, c: string) {
    return this.contactosT.filter((k) => k.negocioId === negocioId && k.contacto === c).map((k) => ({ ...k }));
  }
  async registrarEntrada(numeroId: number, negocioId: number, c: string, nombre: string | null, fecha: Date) {
    let x = this.contactosT.find((k) => k.numeroId === numeroId && k.contacto === c);
    if (!x) {
      x = { numeroId, negocioId, contacto: c, nombre, ultimaEntrada: fecha, baja: false, bajaDesde: null, derivada: false };
      this.contactosT.push(x);
    } else {
      if (!x.ultimaEntrada || x.ultimaEntrada < fecha) x.ultimaEntrada = fecha;
      x.nombre = nombre ?? x.nombre;
    }
    return { ...x };
  }
  async cambiarContacto(numeroId: number, c: string, cambios: Partial<Pick<Contacto, 'baja' | 'bajaDesde' | 'derivada'>>) {
    const x = this.contactosT.find((k) => k.numeroId === numeroId && k.contacto === c);
    if (x) Object.assign(x, sinIndefinidos(cambios));
  }
  async bajas(negocioId?: number) {
    return this.contactosT.filter((k) => k.baja && (negocioId === undefined || k.negocioId === negocioId)).map((k) => ({ ...k }));
  }
  async ventanasAbiertas(desde: Date, negocioId?: number) {
    return this.contactosT.filter(
      (k) => k.ultimaEntrada && k.ultimaEntrada > desde && (negocioId === undefined || k.negocioId === negocioId),
    ).length;
  }

  async guardarMensaje(m: NuevoMensaje) {
    if (m.wamid && this.mensajesT.some((x) => x.wamid === m.wamid)) return undefined;
    const nuevo: Mensaje = { ...m, id: this.id('mensajes') };
    this.mensajesT.push(nuevo);
    return { ...nuevo };
  }
  async mensajePorWamid(wamid: string) {
    const m = this.mensajesT.find((x) => x.wamid === wamid);
    return m ? { ...m } : undefined;
  }
  async cambiarMensaje(id: number, c: CambiosDeMensaje) {
    const m = this.mensajesT.find((x) => x.id === id);
    if (m) Object.assign(m, sinIndefinidos(c));
  }
  async charla(negocioId: number, c: string, limite: number) {
    return this.mensajesT
      .filter((m) => m.negocioId === negocioId && m.contacto === c)
      .sort((a, b) => a.fecha.getTime() - b.fecha.getTime() || a.id - b.id)
      .slice(-limite)
      .map((m) => ({ ...m }));
  }
  async contactosConPlantilla(numeroId: number, desde: Date) {
    return [
      ...new Set(
        this.mensajesT
          .filter((m) => m.numeroId === numeroId && m.direccion === 'sale' && m.plantilla && m.wamid && m.fecha > desde)
          .map((m) => m.contacto),
      ),
    ];
  }
  async costosDelPeriodo(negocioId: number, desde: Date, hasta: Date) {
    const enRango = (f: Date) => f >= desde && f < hasta;
    return {
      metaArs: this.mensajesT
        .filter((m) => m.negocioId === negocioId && enRango(m.fecha))
        .reduce((s, m) => s + (m.costoReal ?? m.costoEstimado), 0),
      iaUsd: this.usoIaT.filter((u) => u.negocioId === negocioId && enRango(u.fecha)).reduce((s, u) => s + u.costoUsd, 0),
    };
  }
  async salientes(desde: Date, hasta: Date, negocioId?: number): Promise<Saliente[]> {
    return this.mensajesT
      .filter(
        (m) =>
          m.direccion === 'sale' &&
          m.wamid &&
          m.fecha >= desde &&
          m.fecha < hasta &&
          (negocioId === undefined || m.negocioId === negocioId),
      )
      .map((m) => ({ negocioId: m.negocioId, fecha: m.fecha, categoria: m.categoria, costo: m.costoReal ?? m.costoEstimado }));
  }

  async guardarMedia(negocioId: number, mime: string, datos: Buffer, fecha: Date) {
    const id = this.id('media');
    this.mediaT.push({ id, negocioId, mime, datos, creado: fecha });
    return id;
  }
  async media(id: number) {
    return this.mediaT.find((m) => m.id === id);
  }
  async borrarMediaVieja(antes: Date) {
    const viejos = this.mediaT.filter((m) => m.creado < antes).map((m) => m.id);
    this.mediaT = this.mediaT.filter((m) => !viejos.includes(m.id));
    for (const m of this.mensajesT) if (m.mediaId !== null && viejos.includes(m.mediaId)) m.mediaId = null;
    return viejos.length;
  }

  async crearPlantilla(p: NuevaPlantilla) {
    if (this.plantillasT.some((x) => x.negocioId === p.negocioId && x.nombre === p.nombre && x.idioma === p.idioma)) return undefined;
    const nueva: Plantilla = { ...p, id: this.id('plantillas') };
    this.plantillasT.push(nueva);
    return { ...nueva };
  }
  async plantilla(negocioId: number, nombre: string, idioma: string) {
    const p = this.plantillasT.find((x) => x.negocioId === negocioId && x.nombre === nombre && x.idioma === idioma);
    return p ? { ...p } : undefined;
  }
  async plantillas(negocioId?: number) {
    return this.plantillasT.filter((p) => negocioId === undefined || p.negocioId === negocioId).map((p) => ({ ...p }));
  }
  async plantillaPorMetaId(metaId: string) {
    const p = this.plantillasT.find((x) => x.metaId === metaId);
    return p ? { ...p } : undefined;
  }
  async plantillasDeWaba(wabaId: string, nombre: string, idioma: string) {
    return this.plantillasT.filter((p) => p.wabaId === wabaId && p.nombre === nombre && p.idioma === idioma).map((p) => ({ ...p }));
  }
  async cambiarPlantilla(id: number, c: CambiosDePlantilla) {
    const p = this.plantillasT.find((x) => x.id === id);
    if (p) Object.assign(p, sinIndefinidos(c));
  }

  async precios() {
    return this.preciosT.map((p) => ({ ...p }));
  }
  async ponerPrecio(categoria: string, precioArs: number, fecha: Date) {
    const p = this.preciosT.find((x) => x.categoria === categoria);
    if (p) Object.assign(p, { precioArs, desde: fecha });
    else this.preciosT.push({ categoria, precioArs, desde: fecha });
  }
  async dolar() {
    return this.dolarT.at(-1)?.arsPorUsd;
  }
  async ponerDolar(arsPorUsd: number, _quien: string, fecha: Date) {
    this.dolarT.push({ arsPorUsd, desde: fecha });
  }
  async registrarUsoIa(u: UsoIa) {
    this.usoIaT.push(u);
  }

  async crearEvento(negocioId: number | null, tipo: TipoDeEventoGuardado, datos: Record<string, unknown>, fecha: Date) {
    const e: Evento = {
      id: this.id('eventos'),
      negocioId,
      tipo,
      datos,
      fecha,
      entregado: false,
      intentos: 0,
      proximoIntento: null,
      alertado: false,
    };
    this.eventosT.push(e);
    return { ...e };
  }
  async eventosPendientes(negocioId: number | null, limite: number) {
    return this.eventosT
      .filter((e) => !e.entregado && e.negocioId === negocioId)
      .slice(0, limite)
      .map((e) => ({ ...e }));
  }
  async ackEventos(negocioId: number | null, ids: number[]) {
    let n = 0;
    for (const e of this.eventosT) {
      if (ids.includes(e.id) && !e.entregado && e.negocioId === negocioId) {
        e.entregado = true;
        n++;
      }
    }
    return n;
  }
  async eventosParaPush(ahora: Date) {
    return this.eventosT
      .filter((e) => {
        const n = this.negociosT.find((x) => x.id === e.negocioId);
        return !e.entregado && !e.alertado && n?.urlBase && e.proximoIntento && e.proximoIntento <= ahora;
      })
      .map((e) => ({ ...e }));
  }
  async cambiarEvento(id: number, c: CambiosDeEvento) {
    const e = this.eventosT.find((x) => x.id === id);
    if (e) Object.assign(e, sinIndefinidos(c));
  }

  async crearTrabajo(t: NuevoTrabajo) {
    const nuevo: TrabajoIa = { ...t, id: this.id('trabajos'), estado: 'pendiente', tomadaHasta: null, resultado: null, error: null };
    this.trabajosT.push(nuevo);
    return { ...nuevo };
  }
  async trabajo(id: number) {
    const t = this.trabajosT.find((x) => x.id === id);
    return t ? { ...t } : undefined;
  }
  async trabajoPendiente(numeroId: number, c: string, tipo: TipoDeTrabajo) {
    const t = this.trabajosT.find((x) => x.numeroId === numeroId && x.contacto === c && x.tipo === tipo && x.estado === 'pendiente');
    return t ? { ...t } : undefined;
  }
  async tomarTrabajos(ahora: Date, hasta: Date, limite: number) {
    const libres = this.trabajosT
      .filter((t) => t.estado === 'pendiente' || (t.estado === 'tomada' && t.tomadaHasta! < ahora))
      .slice(0, limite);
    for (const t of libres) Object.assign(t, { estado: 'tomada', tomadaHasta: hasta });
    return libres.map((t) => ({ ...t }));
  }
  async cambiarTrabajo(id: number, c: CambiosDeTrabajo) {
    const t = this.trabajosT.find((x) => x.id === id);
    if (t) Object.assign(t, sinIndefinidos(c));
  }
  async liberarTrabajosVencidos(ahora: Date) {
    let n = 0;
    for (const t of this.trabajosT) {
      if (t.estado === 'tomada' && t.tomadaHasta! < ahora) {
        Object.assign(t, { estado: 'pendiente', tomadaHasta: null });
        n++;
      }
    }
    return n;
  }

  async crearAlerta(a: Omit<Alerta, 'id'>) {
    if (a.clave && this.alertasT.some((x) => x.clave === a.clave)) return undefined;
    const nueva = { ...a, id: this.id('alertas') };
    this.alertasT.push(nueva);
    return { ...nueva };
  }
  async alertas(limite: number) {
    return [...this.alertasT].reverse().slice(0, limite);
  }
  async registrarIntentoNegado(negocioId: number, metodo: string, ruta: string, fecha: Date) {
    this.intentosNegados.push({ negocioId, metodo, ruta, fecha });
  }
  async registrarWebhook(numeroId: number, fecha: Date) {
    this.webhooksT.push({ numeroId, fecha });
  }
  async contarWebhooks(numeroId: number, desde: Date) {
    return this.webhooksT.filter((w) => w.numeroId === numeroId && w.fecha > desde).length;
  }
  async borrarWebhooksViejos(antes: Date) {
    const antesN = this.webhooksT.length;
    this.webhooksT = this.webhooksT.filter((w) => w.fecha >= antes);
    return antesN - this.webhooksT.length;
  }
}

function sinIndefinidos<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
