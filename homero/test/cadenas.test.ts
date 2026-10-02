import { describe, expect, it } from 'vitest';
import { dominio, sinCadenas } from '../src/cadenas.js';
import type { Hallazgo } from '../src/fuentes.js';

const h = (nombre: string, web?: string, extra: Partial<Hallazgo> = {}): Hallazgo => ({
  externo: `osm:node/${nombre}`,
  nombre,
  web,
  fuente: 'osm',
  ...extra,
});
const nadaVisto = async () => false;
const nombres = (l: Hallazgo[]) => l.map((x) => x.nombre);

describe('dominio', () => {
  it('saca protocolo, www y ruta', () => {
    expect(dominio('https://www.megatlon.com/sedes/palermo')).toBe('megatlon.com');
    expect(dominio('sportclub.com.ar')).toBe('sportclub.com.ar');
  });
  it('las webs genericas no son un dominio propio', () => {
    expect(dominio('https://instagram.com/mi.gym')).toBeUndefined();
    expect(dominio('https://linktr.ee/algo')).toBeUndefined();
    expect(dominio('https://algo.wixsite.com/x')).toBeUndefined();
    expect(dominio(undefined)).toBeUndefined();
  });
});

describe('sinCadenas', () => {
  it('lo que paso el 2026-10-02: Megatlon y SportClub afuera, el kung fu queda', async () => {
    const r = await sinCadenas(
      [
        h('Megatlon', 'https://www.megatlon.com/sede/a'),
        h('Megatlon', 'https://megatlon.com/sede/b'),
        h('SportClub', 'https://www.sportclub.com.ar'),
        h('SportClub Belgrano Plaza', 'https://sportclub.com.ar/belgrano'),
        h('SportClub Palermo'),
        h('Instituto Choy Lee Fut Kung Fu Familia Chan', 'https://choyleefut.com.ar'),
      ],
      nadaVisto,
    );
    expect(nombres(r.quedan)).toEqual(['Instituto Choy Lee Fut Kung Fu Familia Chan']);
    expect(r.cadenas).toHaveLength(5);
  });

  it('la marca de OSM alcanza aunque venga sola', async () => {
    const r = await sinCadenas([h('Smart Fit', 'https://smartfit.com.ar', { marca: true })], nadaVisto);
    expect(r.quedan).toHaveLength(0);
  });

  it('un dominio que ya estaba en un lead anterior es otra sede', async () => {
    const r = await sinCadenas([h('Megatlon Olivos', 'https://megatlon.com')], async (d) => d === 'megatlon.com');
    expect(r.quedan).toHaveLength(0);
  });

  it('dos negocios distintos con Instagram de web no son cadena', async () => {
    const r = await sinCadenas(
      [h('Gym Norte', 'https://instagram.com/gymnorte'), h('Funcional Sur', 'https://instagram.com/funcionalsur')],
      nadaVisto,
    );
    expect(r.quedan).toHaveLength(2);
  });

  it('nombres cortos que se repiten no cuentan', async () => {
    const r = await sinCadenas([h('Spa'), h('Spa')], nadaVisto);
    expect(r.quedan).toHaveLength(2);
  });
});
