import { describe, it, expect } from 'vitest';
import { parseCommand } from '../src/router.js';

describe('parseCommand', () => {
  it('trata texto suelto como prompt sin agente', () => {
    expect(parseCommand('que hace el stock')).toEqual({
      kind: 'prompt',
      agent: undefined,
      text: 'que hace el stock',
    });
  });

  it('extrae el agente de /c1 con texto', () => {
    expect(parseCommand('/c1 que hace el stock')).toEqual({
      kind: 'prompt',
      agent: 'c1',
      text: 'que hace el stock',
    });
  });

  it('trata /c2 solo como cambio de agente activo', () => {
    expect(parseCommand('/c2')).toEqual({ kind: 'switch', agent: 'c2' });
  });

  it('reconoce /status', () => {
    expect(parseCommand('/status')).toEqual({ kind: 'status' });
  });

  it('trata un comando desconocido como prompt literal', () => {
    expect(parseCommand('/foo bar')).toEqual({ kind: 'prompt', agent: undefined, text: '/foo bar' });
  });

  it('devuelve empty con texto en blanco', () => {
    expect(parseCommand('   ')).toEqual({ kind: 'empty' });
  });

  it('ignora el sufijo @nombre_del_bot en los comandos', () => {
    expect(parseCommand('/c1@mi_bot hola')).toEqual({ kind: 'prompt', agent: 'c1', text: 'hola' });
  });
});

describe('parseCommand — proyecto', () => {
  it('/proyecto <nombre> cambia el proyecto activo', () => {
    const c = parseCommand('/proyecto sincroresto');
    expect(c.kind).toBe('project');
    if (c.kind !== 'project') throw new Error('esperaba project');
    expect(c.project).toBe('sincroresto');
  });

  // Sin nombre es una pregunta, no un cambio: "¿en cuál estoy?".
  it('/proyecto solo pregunta cual esta activo', () => {
    const c = parseCommand('/proyecto');
    expect(c.kind).toBe('project');
    if (c.kind !== 'project') throw new Error('esperaba project');
    expect(c.project).toBeUndefined();
  });

  it('acepta el alias corto /p', () => {
    const c = parseCommand('/p demo');
    expect(c.kind).toBe('project');
    if (c.kind !== 'project') throw new Error('esperaba project');
    expect(c.project).toBe('demo');
  });

  // El nombre va a una ruta de filesystem: no puede traer separadores.
  it('rechaza un nombre con barra, que escaparia del directorio', () => {
    expect(parseCommand('/proyecto ../otro').kind).toBe('prompt');
  });

  it('rechaza un nombre con espacios en el medio', () => {
    expect(parseCommand('/proyecto mi proyecto').kind).toBe('prompt');
  });

  it('ignora mayusculas en el comando pero respeta el nombre', () => {
    const c = parseCommand('/Proyecto MiRepo');
    if (c.kind !== 'project') throw new Error('esperaba project');
    expect(c.project).toBe('MiRepo');
  });
});
