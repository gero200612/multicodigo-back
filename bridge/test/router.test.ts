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

  it('reconoce /vincular', () => {
    expect(parseCommand('/vincular')).toEqual({ kind: 'vincular' });
  });

  it('reconoce /vincular con el sufijo del bot', () => {
    expect(parseCommand('/vincular@MultiCodigo_bot')).toEqual({ kind: 'vincular' });
  });

  it('/vincular con texto atras sigue siendo vincular', () => {
    // El codigo lo genera el bot, no lo trae el usuario: cualquier cosa que
    // venga atras es ruido y no un argumento.
    expect(parseCommand('/vincular ABC123')).toEqual({ kind: 'vincular' });
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

  it('reconoce /start y /menu como lo mismo', () => {
    expect(parseCommand('/start')).toEqual({ kind: 'menu' });
    expect(parseCommand('/menu')).toEqual({ kind: 'menu' });
  });
});

describe('/cowork', () => {
  it('sin argumento pide ver la lista', () => {
    expect(parseCommand('/cowork')).toEqual({ kind: 'cowork', agent: undefined });
  });

  it('con un agente lo suma o lo saca', () => {
    expect(parseCommand('/cowork c2')).toEqual({ kind: 'cowork', agent: 'c2' });
  });

  it('acepta el agente en mayusculas: se escribe desde un telefono', () => {
    expect(parseCommand('/cowork C3')).toEqual({ kind: 'cowork', agent: 'c3' });
  });

  // Mismo criterio que /proyecto: es mas probable que se hayan equivocado de
  // comando que que quieran un agente llamado asi.
  it('con algo que no es un agente, es texto comun', () => {
    expect(parseCommand('/cowork que hace el stock')).toEqual({
      kind: 'prompt',
      agent: undefined,
      text: '/cowork que hace el stock',
    });
  });
});

describe('/permisos', () => {
  it('sin argumento muestra el actual', () => {
    expect(parseCommand('/permisos')).toEqual({ kind: 'permisos', modo: undefined });
  });

  it('con un modo lo cambia', () => {
    expect(parseCommand('/permisos todo')).toEqual({ kind: 'permisos', modo: 'todo' });
    expect(parseCommand('/permisos ediciones')).toEqual({ kind: 'permisos', modo: 'ediciones' });
    expect(parseCommand('/permisos preguntar')).toEqual({ kind: 'permisos', modo: 'preguntar' });
  });

  // Mismo criterio que /proyecto y /cowork.
  it('con algo que no es un modo, es texto comun', () => {
    expect(parseCommand('/permisos dale que va')).toEqual({
      kind: 'prompt',
      agent: undefined,
      text: '/permisos dale que va',
    });
  });
});
