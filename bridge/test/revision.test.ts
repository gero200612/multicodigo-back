import { describe, it, expect } from 'vitest';
import { partesDelPliego, promptDeRevision } from '../src/revision.js';

const TICKET = [
  '# Eliminar agentes',
  '',
  'tengo que poder eliminar agentes desde actividad o configuracion',
  '',
  'Es una funcionalidad nueva (prioridad Media) sobre el proyecto existente: respetá su estructura.',
  '',
  '## Reglas',
  'PERMISOS: ...',
  '',
  '## Análisis funcional',
  'ANÁLISIS FUNCIONAL (prendido): ...',
].join('\n');

describe('revision', () => {
  it('saca el título y la descripción del pliego del panel', () => {
    expect(partesDelPliego(TICKET)).toEqual({
      titulo: 'Eliminar agentes',
      descripcion: 'tengo que poder eliminar agentes desde actividad o configuracion',
      desarrollo: false,
    });
  });

  it('un desarrollo adentro de un proyecto se marca como desarrollo', () => {
    const md = '# panel\n\nEs una aplicación desde cero, adentro del proyecto existente "x".\n\nturnos online\n\n## Funcionalidades\n1. a';
    expect(partesDelPliego(md)).toEqual({ titulo: 'panel', descripcion: 'turnos online', desarrollo: true });
  });

  it('el pedido de cierre lleva la marca del ticket, la descripción, el análisis y no toca main', () => {
    const p = promptDeRevision({
      md: TICKET, proyecto: 'Punchi', agente: 'c2', otros: ['c4'], hechas: 3, sinResolver: ['algo'], completo: true,
    });
    expect(p.split('\n')[0]).toBe('[TICKET · Nueva funcionalidad] Eliminar agentes');
    expect(p).toContain('DESCRIPCIÓN:\ntengo que poder eliminar agentes');
    expect(p).toContain('claude/c2/trabajo');
    expect(p).toContain('(c4)');
    expect(p).toContain('ANÁLISIS FUNCIONAL (prendido)');
    expect(p).toContain('NO lo pases a main');
  });
});
