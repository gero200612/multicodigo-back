import { describe, expect, it } from 'vitest';
import { armarTicket, partirTicket, TIPO_GRANDE } from '../src/ticket.js';
import { parseCommand } from '../src/router.js';
import { conDespliegue } from '../src/despliegue.js';

describe('/ticket', () => {
  it('se parsea con la descripción de varias líneas', () => {
    expect(parseCommand('/ticket bug: no anda el login\nen Safari\ncon iPhone')).toEqual({
      kind: 'ticket',
      texto: 'bug: no anda el login\nen Safari\ncon iPhone',
    });
  });

  it('arma el mismo pedido que el formulario del panel', () => {
    const p = armarTicket('bug: no anda el login\nen Safari', 'Sincro')!;
    expect(p.startsWith('[TICKET · Bug · prioridad Media] no anda el login')).toBe(true);
    expect(p).toContain('Proyecto: Sincro');
    expect(p).toContain('en Safari');
    expect(p).toContain('NO me muestres el plan');
    expect(p).toContain('ANÁLISIS FUNCIONAL (prendido)');
  });

  it('sin tipo es una mejora, y sin descripción el título hace de las dos', () => {
    const p = armarTicket('exportar a excel', 'X')!;
    expect(p.startsWith('[TICKET · Mejora · prioridad Media] exportar a excel')).toBe(true);
    expect(p).toContain('DESCRIPCIÓN:\nexportar a excel');
  });

  it('sin título no hay ticket', () => {
    expect(armarTicket('   ', 'X')).toBeUndefined();
  });

  it('el bloque de despliegue no le saca la etiqueta del principio', () => {
    const repos = [{ nombre: 'front', github_repo: 'a/front', render_url: 'https://x.onrender.com' }] as never;
    const p = conDespliegue('[TICKET · Mejora · prioridad Media] x', repos);
    expect(p.startsWith('[TICKET')).toBe(true);
  });
  it('nuevo: es una funcionalidad grande, que va como pliego', () => {
    expect(partirTicket('nuevo: módulo de stock\ncon lotes')).toEqual({ tipo: TIPO_GRANDE, titulo: 'módulo de stock', descripcion: 'con lotes' });
  });
});
