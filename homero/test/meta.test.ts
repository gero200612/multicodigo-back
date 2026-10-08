import { describe, expect, it } from 'vitest';
import { aCentavos, clienteDeMeta, consultasDe, dePesos } from '../src/meta.js';

const TOKEN = 'EAAtokenSecretoDeMeta123';

/** Un `fetch` falso: devuelve las respuestas en orden y anota cada pedido. */
function fetchFalso(respuestas: { status?: number; json: unknown }[]) {
  const pedidos: { url: string; metodo: string; auth: string; cuerpo: URLSearchParams }[] = [];
  const pedir = (async (url: string, init: RequestInit) => {
    pedidos.push({
      url,
      metodo: String(init.method),
      auth: String((init.headers as Record<string, string>).authorization),
      cuerpo: new URLSearchParams(typeof init.body === 'string' ? init.body : ''),
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
