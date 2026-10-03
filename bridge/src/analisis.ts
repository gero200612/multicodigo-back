import PDFDocument from 'pdfkit';
import type { DocumentosDeps, DocumentoGuardado } from './documentos.js';

/**
 * El análisis funcional de un cambio: capturas de las pantallas y un PDF que
 * las explica, en la carpeta "Análisis funcional (<proyecto>)" de Archivos.
 *
 * El agente saca las capturas con `mirar` (pidiendo guardarlas) y después arma
 * el análisis con secciones que nombran esas capturas. Las imágenes viajan una
 * sola vez —al guardarse— y el PDF las lee del disco del proyecto.
 */

/** Una captura del agente: el nombre que le puso y el PNG en base64. */
export interface CapturaEntrante {
  nombre: string;
  png: string;
}

export interface SeccionDeAnalisis {
  titulo: string;
  texto: string;
  /** Nombres de capturas YA guardadas en este proyecto. */
  capturas?: string[];
}

export interface DepsDeAnalisis extends DocumentosDeps {
  /** Lee un archivo del disco de documentos (ruta relativa a docsRaiz). */
  leer: (ruta: string) => Promise<Uint8Array>;
}

const FIRMA_PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const MAXIMO_PNG = 8 * 1024 * 1024;
const NOMBRE_SEGURO = /^[A-Za-z0-9._-]{1,120}$/;

/** "Análisis funcional (Sincro Resto)", con el nombre limpio para ser carpeta. */
export function carpetaDeAnalisis(proyecto: string): string {
  const limpio = proyecto.replace(/[^\p{L}\p{N} ._-]/gu, '').trim().slice(0, 100) || 'proyecto';
  return `Análisis funcional (${limpio})`;
}

/** Un nombre de archivo seguro, con sello de tiempo para no pisar el anterior. */
function nombreConSello(base: string, ext: string, ahora: Date): string {
  const limpio = base
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 60) || 'captura';
  const sello = ahora.toISOString().slice(0, 19).replace(/[-:T]/g, '');
  return `${limpio}-${sello}.${ext}`;
}

function esPng(datos: Uint8Array): boolean {
  return FIRMA_PNG.every((b, i) => datos[i] === b);
}

async function escribir(rutaRelativa: string, datos: Uint8Array, deps: DocumentosDeps): Promise<void> {
  const completa = `${deps.docsRaiz}/${rutaRelativa}`;
  await deps.crearDir(completa.slice(0, completa.lastIndexOf('/')));
  await deps.escribir(completa, datos);
}

/** Guarda las capturas como documentos del proyecto. Devuelve los nombres con que quedaron. */
export async function guardarCapturas(
  entrada: { proyectoId: string; usuarioId: string; proyecto: string; capturas: CapturaEntrante[]; ahora?: Date },
  deps: DocumentosDeps,
): Promise<string[]> {
  const carpeta = `${carpetaDeAnalisis(entrada.proyecto)}/capturas`;
  const ahora = entrada.ahora ?? new Date();
  const nombres: string[] = [];
  for (const c of entrada.capturas) {
    const datos = Uint8Array.from(Buffer.from(c.png, 'base64'));
    if (datos.byteLength === 0 || datos.byteLength > MAXIMO_PNG || !esPng(datos)) continue;
    const nombre = nombreConSello(c.nombre, 'png', ahora);
    const ruta = `${entrada.proyectoId}/${nombre}`;
    await escribir(ruta, datos, deps);
    await deps.guardarFila({
      proyectoId: entrada.proyectoId,
      nombre,
      nombreOriginal: nombre,
      ruta,
      rutaTexto: null,
      tipo: 'png',
      bytes: datos.byteLength,
      subidoPor: entrada.usuarioId,
      origen: 'agente',
      carpeta,
    });
    nombres.push(nombre);
  }
  return nombres;
}

/** El PDF: título, resumen y una sección por pantalla, con sus capturas. */
export async function armarPdf(
  datos: { titulo: string; proyecto: string; resumen: string; secciones: SeccionDeAnalisis[]; fecha: Date },
  imagenes: Map<string, Uint8Array>,
): Promise<Uint8Array> {
  const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: datos.titulo, Author: 'Punchi' } });
  const partes: Buffer[] = [];
  doc.on('data', (b: Buffer) => partes.push(b));
  const listo = new Promise<void>((ok) => doc.on('end', () => ok()));
  const ancho = doc.page.width - 100;
  const texto = (t: string) => t.replace(/^#+\s*/gm, '').replace(/\*\*(.+?)\*\*/g, '$1').trim();

  doc.fillColor('#1c4ed8').fontSize(10).text('ANÁLISIS FUNCIONAL', { characterSpacing: 1 });
  doc.moveDown(0.3).fillColor('#14181d').fontSize(22).text(texto(datos.titulo));
  doc.moveDown(0.2).fillColor('#5b636c').fontSize(10)
    .text(`${datos.proyecto} · ${datos.fecha.toLocaleDateString('es-AR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Argentina/Buenos_Aires' })}`);
  doc.moveDown(1).fillColor('#14181d').fontSize(11.5).text(texto(datos.resumen), { lineGap: 3 });

  for (const s of datos.secciones) {
    doc.moveDown(1.2);
    if (doc.y > doc.page.height - 160) doc.addPage();
    doc.fillColor('#14181d').fontSize(15).text(texto(s.titulo));
    doc.moveDown(0.4).fontSize(11).fillColor('#2b3138').text(texto(s.texto), { lineGap: 2.5 });
    for (const nombre of s.capturas ?? []) {
      const img = imagenes.get(nombre);
      if (!img) continue;
      // El alto escalado se calcula acá: con `fit`, pdfkit dibuja la imagen
      // pero no corre el cursor, y el texto siguiente quedaba encima.
      // `openImage` existe en pdfkit pero no en sus tipos.
      const abierta = (doc as unknown as { openImage(b: Buffer): { width: number; height: number } }).openImage(Buffer.from(img));
      const escala = Math.min(ancho / abierta.width, 340 / abierta.height, 1);
      const w = abierta.width * escala;
      const h = abierta.height * escala;
      doc.moveDown(0.6);
      if (doc.y + h + 30 > doc.page.height - doc.page.margins.bottom) doc.addPage();
      const y = doc.y;
      doc.image(abierta as unknown as Buffer, doc.page.margins.left + (ancho - w) / 2, y, { width: w, height: h });
      doc.rect(doc.page.margins.left + (ancho - w) / 2, y, w, h).lineWidth(0.5).strokeColor('#d3d8dd').stroke();
      doc.y = y + h + 4;
      doc.x = doc.page.margins.left;
      doc.fontSize(8.5).fillColor('#5b636c').text(nombre, { align: 'center', width: ancho });
    }
  }

  doc.end();
  await listo;
  return new Uint8Array(Buffer.concat(partes));
}

/** Arma el PDF con las capturas ya guardadas y lo deja en la carpeta del análisis. */
export async function guardarAnalisis(
  entrada: {
    proyectoId: string;
    usuarioId: string;
    proyecto: string;
    titulo: string;
    resumen: string;
    secciones: SeccionDeAnalisis[];
    ahora?: Date;
  },
  deps: DepsDeAnalisis,
): Promise<DocumentoGuardado & { faltantes: string[] }> {
  const ahora = entrada.ahora ?? new Date();
  const imagenes = new Map<string, Uint8Array>();
  const faltantes: string[] = [];
  for (const nombre of new Set(entrada.secciones.flatMap((s) => s.capturas ?? []))) {
    // Solo nombres planos del propio proyecto: nada de rutas.
    if (!NOMBRE_SEGURO.test(nombre) || nombre.includes('..')) {
      faltantes.push(nombre);
      continue;
    }
    try {
      const datos = await deps.leer(`${entrada.proyectoId}/${nombre}`);
      if (esPng(datos)) imagenes.set(nombre, datos);
      else faltantes.push(nombre);
    } catch {
      faltantes.push(nombre);
    }
  }

  const pdf = await armarPdf({ ...entrada, fecha: ahora }, imagenes);
  const nombre = nombreConSello(`analisis-funcional-${entrada.titulo}`, 'pdf', ahora);
  const ruta = `${entrada.proyectoId}/${nombre}`;
  await escribir(ruta, pdf, deps);

  // El texto, para que el agente lo pueda leer después como cualquier documento.
  const md = [`# ${entrada.titulo}`, '', entrada.resumen, ...entrada.secciones.flatMap((s) => ['', `## ${s.titulo}`, '', s.texto])].join('\n');
  const rutaTexto = `${ruta}.md`;
  await escribir(rutaTexto, new TextEncoder().encode(md), deps);

  await deps.guardarFila({
    proyectoId: entrada.proyectoId,
    nombre,
    nombreOriginal: nombre,
    ruta,
    rutaTexto,
    tipo: 'pdf',
    bytes: pdf.byteLength,
    subidoPor: entrada.usuarioId,
    origen: 'agente',
    carpeta: carpetaDeAnalisis(entrada.proyecto),
  });
  return { nombre, tipo: 'pdf', bytes: pdf.byteLength, faltantes };
}
