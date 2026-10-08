/**
 * Prueba de humo de Meta: SOLO LECTURA. No crea, no cambia y no borra nada.
 *
 * Confirma, con el token de verdad, lo que el codigo da por hecho antes de
 * gastar un peso: que la cuenta publicitaria se lee (y en que moneda), que el
 * token de la pagina sale, que los formularios de la pagina se leen y cual es
 * la cuenta de Instagram que va en los creativos.
 *
 * En el servidor, con las variables de Homero ya cargadas:
 *   docker exec homero node --experimental-strip-types scripts/meta-humo.ts
 *
 * El token nunca se imprime: va en el header y se tacha de cualquier error.
 */

const token = process.env.META_TOKEN ?? '';
const cuentaCruda = process.env.META_AD_ACCOUNT_ID ?? '';
const pagina = process.env.META_PAGE_ID ?? '';
const version = process.env.META_API_VERSION || 'v23.0';

if (!token || !cuentaCruda || !pagina) {
  console.error('Faltan META_TOKEN, META_AD_ACCOUNT_ID o META_PAGE_ID.');
  process.exit(1);
}
const cuenta = cuentaCruda.startsWith('act_') ? cuentaCruda : `act_${cuentaCruda}`;
const tachar = (t: string, ...secretos: string[]) => secretos.filter(Boolean).reduce((x, s) => x.split(s).join('[token]'), t);

async function leer(ruta: string, campos: Record<string, string>, conToken = token): Promise<Record<string, unknown>> {
  const url = `https://graph.facebook.com/${version}/${ruta}?${new URLSearchParams(campos)}`;
  const r = await fetch(url, { headers: { authorization: `Bearer ${conToken}` }, signal: AbortSignal.timeout(30_000) });
  const json = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok || json.error) {
    const e = (json.error ?? {}) as { message?: string; code?: number };
    throw new Error(tachar(`${ruta}: ${e.message ?? `HTTP ${r.status}`} (codigo ${e.code ?? '?'})`, token, conToken));
  }
  return json;
}

async function paso(nombre: string, f: () => Promise<void>): Promise<boolean> {
  try {
    await f();
    return true;
  } catch (err) {
    console.log(`✗ ${nombre}: ${tachar(err instanceof Error ? err.message : String(err), token)}`);
    return false;
  }
}

let tokenDePagina = '';
const resultados = [
  await paso('cuenta publicitaria', async () => {
    const c = await leer(cuenta, { fields: 'name,currency,account_status,amount_spent,spend_cap,timezone_name' });
    console.log(`✓ cuenta ${cuenta}: ${String(c.name)}`);
    console.log(`  moneda ${String(c.currency)} · estado ${String(c.account_status)} (1 = activa) · zona ${String(c.timezone_name)}`);
    // amount_spent y spend_cap vienen en centavos.
    console.log(`  gastado ${String(c.amount_spent)} centavos · limite ${String(c.spend_cap ?? 'sin limite')} centavos`);
  }),
  await paso('token de la pagina', async () => {
    const p = await leer(pagina, { fields: 'name,access_token,instagram_business_account' });
    tokenDePagina = typeof p.access_token === 'string' ? p.access_token : '';
    console.log(`✓ pagina ${pagina}: ${String(p.name)} · token de pagina: ${tokenDePagina ? 'sí' : 'NO (se usaria el del sistema)'}`);
    const ig = (p.instagram_business_account as { id?: string } | undefined)?.id;
    console.log(`  instagram_business_account: ${ig ?? 'NINGUNA (los anuncios saldrian solo en Facebook)'}`);
  }),
  await paso('formularios de la pagina', async () => {
    const f = await leer(`${pagina}/leadgen_forms`, { fields: 'id,name,status,locale', limit: '25' }, tokenDePagina || token);
    const lista = (f.data as { id: string; name: string; status: string }[] | undefined) ?? [];
    console.log(`✓ leadgen_forms: ${lista.length}`);
    for (const x of lista) console.log(`  ${x.id} · ${x.name} · ${x.status}`);
  }),
  await paso('busqueda de intereses', async () => {
    const s = await leer('search', { type: 'adinterest', q: 'Pequeña y mediana empresa', limit: '3', locale: 'es_LA' });
    const lista = (s.data as { id: string; name: string }[] | undefined) ?? [];
    console.log(`✓ intereses: ${lista.map((x) => `${x.id} ${x.name}`).join(' · ') || 'ninguno'}`);
  }),
  await paso('insights del mes', async () => {
    const i = await leer(`${cuenta}/insights`, { level: 'ad', fields: 'ad_id,spend,impressions,actions', date_preset: 'this_month' });
    console.log(`✓ insights: ${((i.data as unknown[] | undefined) ?? []).length} fila(s)`);
  }),
];

const fallaron = resultados.filter((r) => !r).length;
console.log(fallaron ? `\n${fallaron} paso(s) fallaron.` : '\nTodo legible. No se creó nada.');
process.exit(fallaron ? 1 : 0);
