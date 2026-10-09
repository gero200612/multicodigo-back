import { dominio } from '../src/cadenas.js';
import type {
  Agente,
  Anuncio,
  CambiosDeAnuncio,
  EstadoDeAnuncio,
  Gasto,
  Investigacion,
  NuevoAnuncio,
  CierreDeCorrida,
  Corrida,
  MailQueFunciono,
  CambiosDePresupuesto,
  Presupuesto,
  CambiosDeDemo,
  CambiosDeSaliente,
  Demo,
  FiltroDeLeads,
  TipoDeSaliente,
  EstadoDeSaliente,
  Lead,
  NuevaTarea,
  NuevoLead,
  Recibido,
  Reunion,
  Saliente,
  Store,
  Tarea,
  Cliente,
  CuentaClaude,
  Fijo,
  NuevoCliente,
  NuevoFijo,
  NuevoPago,
  Pago,
} from '../src/store.js';

interface Fila extends Tarea {
  clave?: string;
  estado: 'pendiente' | 'corriendo' | 'lista' | 'fallida';
  disponibleDesde: Date;
  ultimoError?: string;
}

const copia = <T>(v: T): T => JSON.parse(JSON.stringify(v));

/** Un Store en memoria con la misma semantica que el de Postgres. */
export class MemoriaStore implements Store {
  estado = new Map<string, unknown>();
  tareas: Fila[] = [];
  primeros = new Map<string, Date>();
  envios: { cuenta: string; para: string; asunto: string; en: Date }[] = [];
  recibidos = new Set<string>();
  bajas = new Set<string>();
  leads: (Lead & { externo?: string; creado: Date; leadgenId?: string })[] = [];
  salientes: Saliente[] = [];
  ofertas = new Map<number, Date[]>();
  reuniones: (Reunion & { creada: Date; cancelada?: boolean })[] = [];
  ocupados = new Set<string>();
  busquedas: { rubro: string; ciudad: string; fuente: string; hallados: number }[] = [];
  rebotes: { cuenta: string; email?: string; en: Date }[] = [];
  demos: Demo[] = [];
  presupuestos: Presupuesto[] = [];
  corridasGuardadas: Corrida[] = [];
  libretas = new Map<Agente, string>();
  anunciosGuardados: (Anuncio & { imagen: Buffer })[] = [];
  gastosGuardados: Gasto[] = [];
  /** Lo que devuelve `mailsQueFuncionaron`: se carga a mano en cada test. */
  funcionaron: MailQueFunciono[] = [];

  constructor(private ahora: () => Date = () => new Date()) {}

  async leerEstado<T>(clave: string) {
    return this.estado.get(clave) as T | undefined;
  }
  async guardarEstado(clave: string, valor: unknown) {
    if (valor === null) this.estado.delete(clave);
    else this.estado.set(clave, copia(valor));
  }

  async encolar(t: NuevaTarea) {
    if (t.clave && this.tareas.some((f) => f.clave === t.clave)) return false;
    this.tareas.push({
      id: this.tareas.length + 1,
      tipo: t.tipo,
      payload: copia(t.payload),
      requiereIa: t.requiereIa,
      intentos: 0,
      clave: t.clave,
      estado: 'pendiente',
      disponibleDesde: t.disponibleDesde ?? this.ahora(),
    });
    return true;
  }
  async colaPorTipo() {
    const porTipo = new Map<Fila['tipo'], Fila[]>();
    for (const t of this.tareas.filter((x) => x.estado === 'pendiente')) {
      porTipo.set(t.tipo, [...(porTipo.get(t.tipo) ?? []), t]);
    }
    return [...porTipo.entries()].map(([tipo, fs]) => ({
      tipo,
      pendientes: fs.length,
      proxima: fs.map((f) => f.disponibleDesde).sort((a, b) => a.getTime() - b.getTime())[0],
      ultimoError: fs.find((f) => f.ultimoError)?.ultimoError,
    }));
  }
  async tomarSiguiente(ahora: Date, iaDisponible: boolean) {
    const f = this.tareas
      .filter(
        (t) =>
          t.estado === 'pendiente' &&
          t.disponibleDesde.getTime() <= ahora.getTime() &&
          (iaDisponible || !t.requiereIa),
      )
      .sort((a, b) => a.disponibleDesde.getTime() - b.disponibleDesde.getTime() || a.id - b.id)[0];
    if (!f) return undefined;
    f.estado = 'corriendo';
    return { id: f.id, tipo: f.tipo, payload: f.payload, requiereIa: f.requiereIa, intentos: f.intentos };
  }
  private fila(id: number) {
    return this.tareas.find((t) => t.id === id)!;
  }
  async terminar(id: number) {
    this.fila(id).estado = 'lista';
  }
  async reprogramar(id: number, cuando: Date, o: { contarIntento: boolean; error?: string }) {
    const f = this.fila(id);
    f.estado = 'pendiente';
    f.disponibleDesde = cuando;
    if (o.contarIntento) f.intentos++;
    if (o.error) f.ultimoError = o.error;
  }
  async fallar(id: number, error: string) {
    const f = this.fila(id);
    f.estado = 'fallida';
    f.intentos++;
    f.ultimoError = error;
  }
  async rescatarColgadas() {
    let n = 0;
    for (const t of this.tareas)
      if (t.estado === 'corriendo') {
        t.estado = 'pendiente';
        n++;
      }
    return n;
  }
  async cancelarTareas(tipos: string[]) {
    let n = 0;
    for (const t of this.tareas)
      if (t.estado === 'pendiente' && tipos.includes(t.tipo)) {
        t.estado = 'fallida';
        n++;
      }
    return n;
  }
  async tareasEnCurso(tipos: string[]) {
    return this.tareas.filter((t) => (t.estado === 'pendiente' || t.estado === 'corriendo') && tipos.includes(t.tipo)).length;
  }
  async contarTareas() {
    return {
      pendientes: this.tareas.filter((t) => t.estado === 'pendiente').length,
      fallidas: this.tareas.filter((t) => t.estado === 'fallida').length,
    };
  }

  async registrarCuenta() {}
  async primerEnvio(email: string) {
    return this.primeros.get(email);
  }
  async enviosDesde(email: string, desde: Date) {
    return this.envios.filter((e) => e.cuenta === email && e.en.getTime() >= desde.getTime()).length;
  }
  async registrarEnvio(e: { cuenta: string; para: string; asunto: string }) {
    this.envios.push({ ...e, en: this.ahora() });
    if (!this.primeros.has(e.cuenta)) this.primeros.set(e.cuenta, this.ahora());
  }

  async guardarRecibido(r: Recibido) {
    const k = `${r.cuenta}|${r.messageId}`;
    if (this.recibidos.has(k)) return false;
    this.recibidos.add(k);
    return true;
  }
  async esBaja(email: string) {
    return this.bajas.has(email.toLowerCase());
  }
  async agregarBaja(email: string) {
    this.bajas.add(email.toLowerCase());
  }

  // ---- ventas

  async crearLead(l: NuevoLead) {
    const email = l.email?.toLowerCase();
    if (l.externo && this.leads.some((x) => x.externo === l.externo)) return undefined;
    if (email && this.leads.some((x) => x.email === email)) return undefined;
    const id = this.leads.length + 1;
    this.leads.push({ ...l, email, id, estado: 'nuevo', creado: this.ahora() });
    return id;
  }
  async lead(id: number) {
    const l = this.leads.find((x) => x.id === id);
    return l ? { ...l } : undefined;
  }
  async leadsEnBorrador() {
    return this.leads.filter((l) => l.estado === 'borrador').map((l) => l.id);
  }
  async hayLeadConDominio(d: string) {
    return this.leads.some((l) => dominio(l.web ?? undefined) === d);
  }
  async leadPorEmail(email: string) {
    const l = this.leads.find((x) => x.email === email.toLowerCase());
    return l ? { ...l } : undefined;
  }
  async actualizarLead(id: number, c: Partial<Pick<Lead, 'estado' | 'investigacion' | 'casilla' | 'email'>>) {
    const l = this.leads.find((x) => x.id === id)!;
    Object.assign(l, Object.fromEntries(Object.entries(c).filter(([, v]) => v !== undefined)));
    if (c.email) l.email = c.email.toLowerCase();
  }
  async crearSaliente(s: Omit<Saliente, 'id' | 'estado' | 'messageId' | 'telegramMsg'> & { estado?: EstadoDeSaliente }) {
    const id = this.salientes.length + 1;
    this.salientes.push({ ...s, id, estado: s.estado ?? 'borrador' });
    return id;
  }
  async saliente(id: number) {
    const s = this.salientes.find((x) => x.id === id);
    return s ? { ...s } : undefined;
  }
  async salientesDeLead(leadId: number) {
    return this.salientes
      .filter((s) => s.leadId === leadId)
      .sort((a, b) => a.paso - b.paso || a.id - b.id)
      .map((s) => ({ ...s }));
  }
  async salientePorTelegram(msg: number) {
    const s = this.salientes.find((x) => x.telegramMsg === msg);
    return s ? { ...s } : undefined;
  }
  async salientePorMessageId(mid: string) {
    const s = this.salientes.find((x) => x.messageId === mid);
    return s ? { ...s } : undefined;
  }
  async actualizarSaliente(id: number, c: CambiosDeSaliente) {
    const s = this.salientes.find((x) => x.id === id)!;
    Object.assign(s, Object.fromEntries(Object.entries(c).filter(([, v]) => v !== undefined)));
  }
  async marcarEnviado(id: number, messageId?: string) {
    const s = this.salientes.find((x) => x.id === id)!;
    s.estado = 'enviado';
    s.messageId = messageId;
  }
  async cancelarSeguimientos(leadId: number) {
    let n = 0;
    for (const s of this.salientes)
      if (s.leadId === leadId && s.tipo === 'seguimiento' && (s.estado === 'borrador' || s.estado === 'aprobado')) {
        s.estado = 'cancelado';
        n++;
      }
    return n;
  }
  async guardarOferta(leadId: number, horarios: Date[]) {
    this.ofertas.set(leadId, horarios);
  }
  async oferta(leadId: number) {
    return this.ofertas.get(leadId);
  }
  async crearReunion(r: Omit<Reunion, 'id'>) {
    if (this.reuniones.some((x) => !x.cancelada && x.inicio.getTime() === r.inicio.getTime())) return undefined;
    const id = this.reuniones.length + 1;
    this.reuniones.push({ ...r, id, creada: this.ahora() });
    return id;
  }
  async reunion(id: number) {
    return this.reuniones.find((x) => x.id === id && !x.cancelada);
  }
  async cancelarReunion(id: number) {
    const r = this.reuniones.find((x) => x.id === id);
    if (r) r.cancelada = true;
  }
  async reunionesDesde(desde: Date) {
    return this.reuniones.filter((r) => !r.cancelada && r.inicio.getTime() >= desde.getTime()).sort((a, b) => a.inicio.getTime() - b.inicio.getTime());
  }
  async diasOcupados() {
    return [...this.ocupados];
  }
  async marcarOcupado(dia: string, ocupado: boolean) {
    if (ocupado) this.ocupados.add(dia);
    else this.ocupados.delete(dia);
  }
  async registrarBusqueda(b: { rubro: string; ciudad: string; fuente: string; hallados: number }) {
    this.busquedas.push(b);
  }
  async rendimientoPorRubro() {
    const rubros = [...new Set(this.leads.map((l) => l.rubro))];
    return rubros.map((rubro) => {
      const ls = this.leads.filter((l) => l.rubro === rubro);
      return {
        rubro,
        contactados: ls.filter((l) => ['contactado', 'respondio', 'reunion', 'cerrado', 'baja'].includes(l.estado)).length,
        respuestas: ls.filter((l) => ['respondio', 'reunion', 'cerrado'].includes(l.estado)).length,
        reuniones: ls.filter((l) => l.estado === 'reunion').length,
      };
    });
  }
  async pipeline() {
    const ini = this.salientes.filter((s) => s.tipo === 'inicial');
    return {
      borradores: ini.filter((s) => s.estado === 'borrador').length,
      aprobados: ini.filter((s) => s.estado === 'aprobado').length,
    };
  }
  async registrarRebote(cuenta: string, email?: string) {
    this.rebotes.push({ cuenta, email, en: this.ahora() });
  }
  async rebotesDesde(cuenta: string, desde: Date) {
    return this.rebotes.filter((r) => r.cuenta === cuenta && r.en.getTime() >= desde.getTime()).length;
  }
  async metricasDesde(desde: Date) {
    const d = desde.getTime();
    return {
      enviados: this.envios.filter((e) => e.en.getTime() >= d).length,
      respuestas: this.recibidos.size,
      reuniones: this.reuniones.filter((r) => r.creada.getTime() >= d).length,
      leads: this.leads.filter((l) => l.creado.getTime() >= d).length,
    };
  }
  async salientesEnBorrador(tipos: TipoDeSaliente[]) {
    return this.salientes.filter((s) => s.estado === 'borrador' && tipos.includes(s.tipo)).map((s) => ({ ...s }));
  }
  async listarLeads(f: FiltroDeLeads) {
    const q = f.q?.toLowerCase();
    const todos = this.leads
      .filter((l) => (!f.estado || l.estado === f.estado) && (!f.rubro || l.rubro === f.rubro))
      .filter((l) => !q || [l.nombre, l.email, l.web].some((x) => x?.toLowerCase().includes(q)))
      .sort((a, b) => b.id - a.id);
    return { total: todos.length, leads: todos.slice(f.desde, f.desde + f.limite).map((l) => ({ ...l })) };
  }
  async crearDemo(d: { reunionId: number; leadId: number; proyecto: string }) {
    if (this.demos.some((x) => x.reunionId === d.reunionId)) return undefined;
    const id = this.demos.length + 1;
    this.demos.push({ ...d, id, estado: 'redactando' });
    return id;
  }
  async demo(id: number) {
    const d = this.demos.find((x) => x.id === id);
    return d ? { ...d } : undefined;
  }
  async demoDeReunion(reunionId: number) {
    const d = this.demos.find((x) => x.reunionId === reunionId);
    return d ? { ...d } : undefined;
  }
  async demoPorTelegram(msg: number) {
    const d = this.demos.find((x) => x.telegramMsg === msg);
    return d ? { ...d } : undefined;
  }
  async actualizarDemo(id: number, c: CambiosDeDemo) {
    const d = this.demos.find((x) => x.id === id)!;
    Object.assign(d, Object.fromEntries(Object.entries(c).filter(([, v]) => v !== undefined)));
    if (c.error === '') d.error = undefined;
  }
  async demosEnviadas() {
    return this.demos.filter((d) => d.estado === 'enviada').map((d) => ({ ...d }));
  }
  async demosPresupuestables() {
    return this.demos
      .filter((d) => d.estado === 'enviada' || d.estado === 'lista')
      .reverse()
      .map((d) => ({ ...d }));
  }

  async presupuesto(id: number) {
    const p = this.presupuestos.find((x) => x.id === id);
    return p ? structuredClone(p) : undefined;
  }
  async presupuestoDeDemo(demoId: number) {
    const p = this.presupuestos.find((x) => x.demoId === demoId);
    return p ? structuredClone(p) : undefined;
  }
  async guardarPedidoDePresupuesto(p: { demoId: number; leadId: number; notas: string }) {
    const previo = this.presupuestos.find((x) => x.demoId === p.demoId);
    if (previo) {
      Object.assign(previo, { notas: p.notas, estado: 'armando', error: undefined, actualizado: new Date() });
      return previo.id;
    }
    const id = this.presupuestos.length + 1;
    this.presupuestos.push({ ...p, id, estado: 'armando', actualizado: new Date() });
    return id;
  }
  async actualizarPresupuesto(id: number, c: CambiosDePresupuesto) {
    const p = this.presupuestos.find((x) => x.id === id)!;
    const { error, ...resto } = c;
    Object.assign(p, Object.fromEntries(Object.entries(resto).filter(([, v]) => v !== undefined)));
    if (error === '') p.error = undefined;
    else if (error !== undefined) p.error = error;
    p.actualizado = new Date();
  }

  async crearCorrida(c: { agente: Agente; objetivo: string; leadId?: number }) {
    const id = this.corridasGuardadas.length + 1;
    this.corridasGuardadas.push({ id, ...c, estado: 'corriendo', inicio: this.ahora() });
    return id;
  }
  async cerrarCorrida(id: number, c: CierreDeCorrida) {
    const f = this.corridasGuardadas.find((x) => x.id === id);
    if (f) Object.assign(f, copia(c), { fin: this.ahora() });
  }
  async borrarCorrida(id: number) {
    this.corridasGuardadas = this.corridasGuardadas.filter((c) => c.id !== id);
  }
  async corrida(id: number) {
    return this.corridasGuardadas.find((x) => x.id === id);
  }
  async corridas(f: { agente?: Agente; limite: number }) {
    return this.corridasGuardadas
      .filter((c) => !f.agente || c.agente === f.agente)
      .sort((a, b) => b.id - a.id)
      .slice(0, f.limite);
  }
  async libreta(agente: Agente) {
    return this.libretas.get(agente) ?? '';
  }
  async guardarLibreta(agente: Agente, contenido: string) {
    this.libretas.set(agente, contenido);
  }
  async busquedasRecientes(limite: number) {
    return this.busquedas
      .slice(-limite)
      .reverse()
      .map((b) => ({ ...b, hecha: this.ahora() }));
  }
  async mailsQueFuncionaron(limite: number) {
    return this.funcionaron.slice(0, limite);
  }

  // ---- anuncios

  async crearAnuncio(a: NuevoAnuncio) {
    const id = this.anunciosGuardados.length + 1;
    this.anunciosGuardados.push({
      ...copia({ ...a, imagen: undefined }),
      imagen: a.imagen,
      id,
      estado: 'revisando',
      metaIds: {},
      revision: [],
      creadoEn: this.ahora(),
    });
    return id;
  }
  async rehacerAnuncio(id: number, a: NuevoAnuncio) {
    const f = this.anunciosGuardados.find((x) => x.id === id)!;
    Object.assign(f, copia({ ...a, imagen: undefined }), { imagen: a.imagen, estado: 'revisando' });
  }
  private sinImagen(a: Anuncio & { imagen: Buffer }): Anuncio {
    const { imagen: _, ...resto } = a;
    return { ...resto, metaIds: { ...resto.metaIds }, preguntas: [...resto.preguntas], revision: copia(resto.revision) };
  }
  async anuncio(id: number) {
    const a = this.anunciosGuardados.find((x) => x.id === id);
    return a ? this.sinImagen(a) : undefined;
  }
  async anuncios(estados?: EstadoDeAnuncio[]) {
    return this.anunciosGuardados
      .filter((a) => !estados || estados.includes(a.estado))
      .sort((a, b) => b.id - a.id)
      .map((a) => this.sinImagen(a));
  }
  async anuncioPorTelegram(msg: number) {
    const a = this.anunciosGuardados.find((x) => x.telegramMsg === msg);
    return a ? this.sinImagen(a) : undefined;
  }
  async imagenDelAnuncio(id: number) {
    return this.anunciosGuardados.find((x) => x.id === id)?.imagen;
  }
  async actualizarAnuncio(id: number, c: CambiosDeAnuncio) {
    const a = this.anunciosGuardados.find((x) => x.id === id)!;
    Object.assign(a, Object.fromEntries(Object.entries(c).filter(([, v]) => v !== undefined)));
    if (c.metaIds) a.metaIds = { ...c.metaIds };
    if (c.revision) a.revision = copia(c.revision);
  }
  async guardarGastos(g: Gasto[]) {
    for (const f of g) {
      this.gastosGuardados = this.gastosGuardados.filter((x) => !(x.dia === f.dia && x.anuncioId === f.anuncioId));
      this.gastosGuardados.push({ ...f });
    }
  }
  async gastos(desde: string) {
    return this.gastosGuardados.filter((g) => g.dia >= desde).map((g) => ({ ...g }));
  }
  async guardarLeadDeMeta(l: NuevoLead & { leadgenId: string; anuncioId?: number; investigacion: Investigacion }) {
    if (this.leads.some((x) => x.leadgenId === l.leadgenId)) return undefined;
    const email = l.email?.toLowerCase();
    const previo = email ? this.leads.find((x) => x.email === email) : undefined;
    if (previo) {
      Object.assign(previo, {
        estado: ['respondio', 'reunion', 'cerrado', 'baja'].includes(previo.estado) ? previo.estado : 'caliente',
        leadgenId: l.leadgenId,
        anuncioId: l.anuncioId ?? previo.anuncioId,
        telefono: previo.telefono ?? l.telefono,
        investigacion: { ...(previo.investigacion ?? {}), formulario: l.investigacion.formulario, contacto: l.investigacion.contacto },
      });
      return { id: previo.id, nuevo: false };
    }
    const id = this.leads.length + 1;
    this.leads.push({ ...copia(l), email, id, estado: 'caliente', creado: this.ahora() });
    return { id, nuevo: true };
  }
  async resultadosDeAnuncios(desde?: Date) {
    const porAnuncio = new Map<number, { leads: number; reuniones: number }>();
    for (const l of this.leads) {
      if (l.anuncioId === undefined || (desde && l.creado.getTime() < desde.getTime())) continue;
      const r = porAnuncio.get(l.anuncioId) ?? { leads: 0, reuniones: 0 };
      r.leads++;
      if (this.reuniones.some((x) => x.leadId === l.id && !x.cancelada)) r.reuniones++;
      porAnuncio.set(l.anuncioId, r);
    }
    return [...porAnuncio.entries()].map(([anuncioId, r]) => ({ anuncioId, ...r }));
  }

  // ---------------------------------------------------------------- finanzas
  private fijosG: Fijo[] = [];
  private cuentasG = new Map<string, CuentaClaude>();
  private fotos = new Map<string, string[]>();
  private clientesG: Cliente[] = [];
  private pagosG: Pago[] = [];
  private cotizacionesG = new Map<string, number>();
  private idFinanzas = 1;

  async fijos() {
    return [...this.fijosG].sort((a, b) => a.desde.localeCompare(b.desde) || a.id - b.id).map((f) => ({ ...f }));
  }
  async guardarFijo(f: NuevoFijo & { id?: number }) {
    const id = f.id ?? this.idFinanzas++;
    this.fijosG = [...this.fijosG.filter((x) => x.id !== id), { ...f, id }];
    return id;
  }
  async borrarFijo(id: number) {
    this.fijosG = this.fijosG.filter((x) => x.id !== id);
  }
  async cuentasClaude() {
    return [...this.cuentasG.values()].sort((a, b) => a.slot.localeCompare(b.slot)).map((c) => ({ ...c }));
  }
  async guardarCuentaClaude(c: CuentaClaude) {
    this.cuentasG.set(c.slot, { ...c });
  }
  async guardarCuentasDelDia(dia: string, slots: string[]) {
    this.fotos.set(dia, [...slots]);
  }
  async cuentasPorDia(desde: string) {
    return [...this.fotos.entries()]
      .filter(([dia]) => dia >= desde)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([dia, slots]) => ({ dia, slots: [...slots] }));
  }
  async clientes() {
    return [...this.clientesG].sort((a, b) => a.desde.localeCompare(b.desde) || a.id - b.id).map((c) => ({ ...c }));
  }
  async guardarCliente(c: NuevoCliente & { id?: number }) {
    const id = c.id ?? this.idFinanzas++;
    this.clientesG = [...this.clientesG.filter((x) => x.id !== id), { ...c, id }];
    return id;
  }
  async borrarCliente(id: number) {
    this.clientesG = this.clientesG.filter((x) => x.id !== id);
    this.pagosG = this.pagosG.filter((p) => p.clienteId !== id);
  }
  async pagos(desde: string, hasta: string) {
    return this.pagosG
      .filter((p) => p.dia >= desde && p.dia <= hasta)
      .sort((a, b) => a.dia.localeCompare(b.dia) || a.id - b.id)
      .map((p) => ({ ...p }));
  }
  async guardarPago(p: NuevoPago & { id?: number }) {
    const id = p.id ?? this.idFinanzas++;
    this.pagosG = [...this.pagosG.filter((x) => x.id !== id), { ...p, id }];
    return id;
  }
  async borrarPago(id: number) {
    this.pagosG = this.pagosG.filter((x) => x.id !== id);
  }
  async guardarCotizacion(dia: string, valor: number) {
    this.cotizacionesG.set(dia, valor);
  }
  async cotizaciones(hasta: string) {
    return [...this.cotizacionesG.entries()]
      .filter(([dia]) => dia <= hasta)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([dia, valor]) => ({ dia, valor }));
  }
}
