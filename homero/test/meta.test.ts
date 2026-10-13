import { describe, expect, it } from 'vitest';
import { aCentavos, clienteDeMeta, consultasDe, dePesos } from '../src/meta.js';

const TOKEN = 'EAAtokenSecretoDeMeta123';

/** Un `fetch` falso: devuelve las respuestas en orden y anota cada pedido. */
function fetchFalso(respuestas: { status?: number; json: unknown }[]) {
  const pedidos: {
    url: string;
    metodo: string;
    auth: string;
    cuerpo: URLSearchParams;
    headers: Record<string, string>;
    /** El cuerpo binario (la subida de un video), si no era un formulario. */
    bytes?: Buffer;
  }[] = [];
  const pedir = (async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    pedidos.push({
      url,
      metodo: String(init.method),
      auth: String(headers.authorization),
      cuerpo: new URLSearchParams(typeof init.body === 'string' ? init.body : ''),
      headers,
      ...(init.body && typeof init.body !== 'string' ? { bytes: Buffer.from(init.body as Uint8Array) } : {}),
    });
    const r = respuestas.shift() ?? { json: {} };
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { pedir, pedidos };
}

const cfg = { token: TOKEN, cuenta: '980029277705534', pagina: '61595291607526', version: 'v23.0' };

describe('cliente de Meta', () => {
  it('los presupuestos van en centavos; los gastos de insights vienen en pesos', () => {
    expect(aCentavos(1500)).toBe(150_000);
    expect(aCentavos(1234.567)).toBe(123_457);
    expect(dePesos(5_000_000)).toBe(50_000);
  });

  it('el conjunto: diario en centavos, Argentina 25 a 65, token en el header y nunca en la URL', async () => {
    const f = fetchFalso([{ json: { id: 'set1' } }]);
    const meta = clienteDeMeta(cfg, f.pedir);
    const id = await meta.crearConjunto({ campana: 'camp1', nombre: '#1 · taller', diario: 1500, intereses: [{ id: '6003', name: 'Pymes' }] });
    expect(id).toBe('set1');
    const p = f.pedidos[0]!;
    expect(p.url).toBe('https://graph.facebook.com/v23.0/act_980029277705534/adsets');
    expect(p.url).not.toContain(TOKEN);
    expect(p.auth).toBe(`Bearer ${TOKEN}`);
    expect(p.cuerpo.get('daily_budget')).toBe('150000');
    expect(p.cuerpo.get('optimization_goal')).toBe('LEAD_GENERATION');
    expect(JSON.parse(p.cuerpo.get('targeting')!)).toMatchObject({
      geo_locations: { countries: ['AR'] },
      age_min: 25,
      age_max: 65,
      flexible_spec: [{ interests: [{ id: '6003', name: 'Pymes' }] }],
    });
  });

  it('la campaña: OUTCOME_LEADS y sin categorías especiales', async () => {
    const f = fetchFalso([{ json: { id: 'camp1' } }]);
    await clienteDeMeta(cfg, f.pedir).crearCampana('Sincro');
    expect(f.pedidos[0]!.cuerpo.get('objective')).toBe('OUTCOME_LEADS');
    expect(f.pedidos[0]!.cuerpo.get('special_ad_categories')).toBe('[]');
  });

  it('un error de Meta llega sin el token aunque Meta lo repita', async () => {
    const f = fetchFalso([{ status: 400, json: { error: { message: `Invalid OAuth access token ${TOKEN}`, code: 190 } } }]);
    const err = await clienteDeMeta(cfg, f.pedir).cambiarDiario('set1', 2000).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('Invalid OAuth access token');
    expect((err as Error).message).not.toContain(TOKEN);
  });

  it('insights: pagina con paging.next, gasto en pesos y una consulta por lead', async () => {
    const siguiente = 'https://graph.facebook.com/v23.0/act_980029277705534/insights?after=abc';
    const f = fetchFalso([
      {
        json: {
          data: [
            {
              ad_id: 'ad1',
              date_start: '2026-10-07',
              spend: '1234.56',
              impressions: '900',
              actions: [
                { action_type: 'lead', value: '3' },
                { action_type: 'onsite_conversion.lead_grouped', value: '3' },
                { action_type: 'link_click', value: '40' },
              ],
            },
          ],
          paging: { next: siguiente },
        },
      },
      { json: { data: [{ ad_id: 'ad2', date_start: '2026-10-07', spend: '10', impressions: '5' }] } },
    ]);
    const filas = await clienteDeMeta(cfg, f.pedir).insights('2026-10-01', '2026-10-08');
    expect(filas).toEqual([
      { anuncio: 'ad1', dia: '2026-10-07', gasto: 1234.56, impresiones: 900, consultas: 3 },
      { anuncio: 'ad2', dia: '2026-10-07', gasto: 10, impresiones: 5, consultas: 0 },
    ]);
    expect(f.pedidos[0]!.url).toContain('level=ad');
    expect(f.pedidos[0]!.url).toContain('time_increment=1');
    expect(f.pedidos[1]!.url).toBe(siguiente);
    expect(f.pedidos.every((p) => !p.url.includes(TOKEN))).toBe(true);
  });

  it('los leads se leen con el token de la página y traen sus campos', async () => {
    const f = fetchFalso([
      { json: { access_token: 'tokenDeLaPagina', id: '61595291607526' } },
      {
        json: {
          data: [
            {
              id: 'L1',
              created_time: '2026-10-08T14:00:00+0000',
              ad_id: 'ad1',
              form_id: 'form1',
              field_data: [
                { name: 'full_name', values: ['Ana Gómez'] },
                { name: 'email', values: ['ana@taller.com'] },
                { name: 'p1', values: ['Los turnos'] },
              ],
            },
          ],
        },
      },
    ]);
    const leads = await clienteDeMeta(cfg, f.pedir).leads('form1', new Date('2026-10-08T00:00:00Z'));
    expect(leads).toEqual([
      {
        id: 'L1',
        creado: new Date('2026-10-08T14:00:00Z'),
        anuncio: 'ad1',
        formulario: 'form1',
        campos: { full_name: 'Ana Gómez', email: 'ana@taller.com', p1: 'Los turnos' },
      },
    ]);
    expect(f.pedidos[0]!.url).toContain('fields=access_token');
    expect(f.pedidos[1]!.auth).toBe('Bearer tokenDeLaPagina');
    expect(decodeURIComponent(f.pedidos[1]!.url)).toContain('"operator":"GREATER_THAN"');
  });

  it('consultasDe toma la mayor de las acciones de lead, no la suma', () => {
    expect(consultasDe([{ action_type: 'lead', value: '2' }, { action_type: 'leadgen_grouped', value: '2' }])).toBe(2);
    expect(consultasDe(undefined)).toBe(0);
  });
});

describe('cliente de Meta: reels', () => {
  const VIDEO = Buffer.from('mp4 de mentira');
  const IG = { json: { instagram_business_account: { id: 'ig1' } } };

  it('IG: contenedor REELS resumable de prueba, y los bytes van a rupload con OAuth', async () => {
    const f = fetchFalso([IG, { json: { id: 'cont1' } }, { json: { success: true } }]);
    const id = await clienteDeMeta(cfg, f.pedir).subirReelInstagram(VIDEO, { caption: 'Hola #sincro', prueba: true });
    expect(id).toBe('cont1');
    const crear = f.pedidos[1]!;
    expect(crear.url).toBe('https://graph.facebook.com/v23.0/ig1/media');
    expect(crear.cuerpo.get('media_type')).toBe('REELS');
    expect(crear.cuerpo.get('upload_type')).toBe('resumable');
    expect(crear.cuerpo.get('caption')).toBe('Hola #sincro');
    expect(crear.cuerpo.get('share_to_feed')).toBe('true');
    expect(JSON.parse(crear.cuerpo.get('trial_params')!)).toEqual({ graduation_strategy: 'SS_PERFORMANCE' });
    const subir = f.pedidos[2]!;
    expect(subir.url).toBe('https://rupload.facebook.com/ig-api-upload/v23.0/cont1');
    expect(subir.auth).toBe(`OAuth ${TOKEN}`);
    expect(subir.headers.offset).toBe('0');
    expect(subir.headers.file_size).toBe(String(VIDEO.length));
    expect(subir.bytes).toEqual(VIDEO);
  });

  it('IG sin prueba: no manda trial_params', async () => {
    const f = fetchFalso([IG, { json: { id: 'cont1' } }, { json: { success: true } }]);
    await clienteDeMeta(cfg, f.pedir).subirReelInstagram(VIDEO, { caption: 'x', prueba: false });
    expect(f.pedidos[1]!.cuerpo.has('trial_params')).toBe(false);
  });

  it('IG: una subida rechazada por rupload es un error sin el token', async () => {
    const f = fetchFalso([IG, { json: { id: 'cont1' } }, { status: 400, json: { debug_info: { message: `bad ${TOKEN}` } } }]);
    const err = await clienteDeMeta(cfg, f.pedir)
      .subirReelInstagram(VIDEO, { caption: 'x', prueba: true })
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('bad');
    expect((err as Error).message).not.toContain(TOKEN);
  });

  it('IG: estado del contenedor y publicar', async () => {
    const f = fetchFalso([{ json: { status_code: 'ERROR', status: 'Error: trial reels not available' } }, IG, { json: { id: 'media1' } }]);
    const meta = clienteDeMeta(cfg, f.pedir);
    expect(await meta.estadoDelContenedor('cont1')).toEqual({ estado: 'ERROR', detalle: 'Error: trial reels not available' });
    expect(f.pedidos[0]!.url).toContain('fields=status_code%2Cstatus');
    expect(await meta.publicarEnInstagram('cont1')).toBe('media1');
    expect(f.pedidos[2]!.url).toBe('https://graph.facebook.com/v23.0/ig1/media_publish');
    expect(f.pedidos[2]!.cuerpo.get('creation_id')).toBe('cont1');
  });

  it('FB: reel de la página en tres pasos, con el token de la página', async () => {
    const f = fetchFalso([
      { json: { access_token: 'tokenDeLaPagina' } },
      { json: { video_id: 'v1' } },
      { json: { success: true } },
      { json: { success: true } },
    ]);
    const id = await clienteDeMeta(cfg, f.pedir).subirReelFacebook(VIDEO, 'Hola #sincro');
    expect(id).toBe('v1');
    expect(f.pedidos[1]!.url).toBe('https://graph.facebook.com/v23.0/61595291607526/video_reels');
    expect(f.pedidos[1]!.cuerpo.get('upload_phase')).toBe('start');
    expect(f.pedidos[1]!.auth).toBe('Bearer tokenDeLaPagina');
    expect(f.pedidos[2]!.url).toBe('https://rupload.facebook.com/video-upload/v23.0/v1');
    expect(f.pedidos[2]!.auth).toBe('OAuth tokenDeLaPagina');
    expect(f.pedidos[2]!.bytes).toEqual(VIDEO);
    const fin = f.pedidos[3]!;
    expect(fin.cuerpo.get('upload_phase')).toBe('finish');
    expect(fin.cuerpo.get('video_id')).toBe('v1');
    expect(fin.cuerpo.get('video_state')).toBe('PUBLISHED');
    expect(fin.cuerpo.get('description')).toBe('Hola #sincro');
  });

  it('métricas de un reel: los nombres de Meta pasan a castellano', async () => {
    const f = fetchFalso([
      {
        json: {
          data: [
            { name: 'reach', values: [{ value: 812 }] },
            { name: 'views', values: [{ value: 1500 }] },
            { name: 'saved', values: [{ value: 9 }] },
            { name: 'shares', values: [{ value: 4 }] },
            { name: 'likes', values: [{ value: 30 }] },
            { name: 'comments', values: [{ value: 2 }] },
            { name: 'ig_reels_avg_watch_time', values: [{ value: 6400 }] },
          ],
        },
      },
    ]);
    expect(await clienteDeMeta(cfg, f.pedir).metricasDeReel('media1')).toEqual({
      alcance: 812,
      vistas: 1500,
      guardados: 9,
      compartidos: 4,
      likes: 30,
      comentarios: 2,
      promedioMs: 6400,
    });
    expect(f.pedidos[0]!.url).toContain('https://graph.facebook.com/v23.0/media1/insights?metric=');
  });

  it('si un reel se puede promocionar, y por qué no', async () => {
    const f = fetchFalso([
      { json: { boost_eligibility_info: { eligible_to_boost: true } } },
      { json: { boost_eligibility_info: { eligible_to_boost: false, boost_ineligible_reason: 'Contains copyrighted music' } } },
    ]);
    const meta = clienteDeMeta(cfg, f.pedir);
    expect(await meta.promocionable('media1')).toEqual({ ok: true });
    expect(await meta.promocionable('media2')).toEqual({ ok: false, motivo: 'Contains copyrighted music' });
  });

  it('el creativo de un reel apunta al media de IG y lleva al formulario', async () => {
    const f = fetchFalso([IG, { json: { id: 'cre1' } }]);
    const id = await clienteDeMeta(cfg, f.pedir).crearCreativoDeReel({ nombre: '#7 · reel', media: 'media1', formulario: 'form1' });
    expect(id).toBe('cre1');
    const p = f.pedidos[1]!;
    expect(p.url).toBe('https://graph.facebook.com/v23.0/act_980029277705534/adcreatives');
    expect(p.cuerpo.get('object_id')).toBe('61595291607526');
    expect(p.cuerpo.get('instagram_user_id')).toBe('ig1');
    expect(p.cuerpo.get('source_instagram_media_id')).toBe('media1');
    expect(JSON.parse(p.cuerpo.get('call_to_action')!)).toEqual({ type: 'SIGN_UP', value: { lead_gen_form_id: 'form1' } });
  });
});
