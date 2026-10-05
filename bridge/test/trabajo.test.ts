import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { ejecutarTurno, ejecutarTurnoConRelevo, type PipelineDeps } from '../src/pipeline.js';
import { InMemoryStore } from '../src/store.js';
import { LimitePorChat } from '../src/vinculacion.js';
import { avisoDeTrabajo, registrarTrabajo, trabajoDeMiEmpresa } from '../src/trabajo.js';
import type { EnCurso } from '../src/gateway-admin.js';

const USUARIO = '99999999-9999-4999-8999-999999999999';
const PROYECTO = '11111111-1111-4111-8111-111111111111';

const enCurso = (o: Partial<EnCurso>): EnCurso => ({
  agente: 'c3',
  proyecto: 'padel',
  repo: 'web',
  rama: 'claude/c3/trabajo',
  archivos: ['src/a.ts'],
  sinCommitear: false,
  ...o,
});

describe('el trabajo de mi empresa', () => {
  const store = {
    proyectosDeMiEmpresa: async (_u: string, nombres: string[]) =>
      nombres
        .filter((n) => n !== 'de-otra-empresa')
        .map((nombre) => ({ nombre, visible: nombre !== 'secreto' })),
  };

  it('saca lo de otras empresas, esconde el nombre de lo que no ves y me saca a mi', async () => {
    const r = await trabajoDeMiEmpresa(
      USUARIO,
      ['web'],
      {
        store,
        trabajoEnCurso: async () => [
          enCurso({ agente: 'c3', proyecto: 'padel' }),
          enCurso({ agente: 'c4', proyecto: 'secreto' }),
          enCurso({ agente: 'c5', proyecto: 'de-otra-empresa' }),
          enCurso({ agente: 'c1', proyecto: 'padel' }),
        ],
      },
      'c1',
    );
    expect(r.map((t) => [t.agente, t.proyecto])).toEqual([
      ['c3', 'padel'],
      ['c4', null],
    ]);
  });

  it('el aviso nombra agente, repo, rama y archivos, y no dice el proyecto que no ves', () => {
    const aviso = avisoDeTrabajo([
      { ...enCurso({ sinCommitear: true, archivos: ['src/a.ts', 'src/b.ts'] }), proyecto: 'padel' },
      { ...enCurso({ agente: 'c4' }), proyecto: null },
    ])!;
    expect(aviso).toContain('c3 (proyecto padel), repo web, rama claude/c3/trabajo, escribiendo ahora: src/a.ts, src/b.ts');
    expect(aviso).toContain('c4 (otro proyecto de la empresa)');
    expect(aviso).toContain('Evitá modificar esos archivos');
  });

  it('sin trabajo no hay aviso', () => {
    expect(avisoDeTrabajo([])).toBeUndefined();
  });
});

function deps(o: Partial<PipelineDeps> = {}): PipelineDeps {
  return {
    store: new InMemoryStore(),
    defaultAgent: 'c1',
    project: 'demo',
    limite: new LimitePorChat(),
    ask: vi.fn(async (r: { jobId: string }) => ({ jobId: r.jobId, sessionId: 's', text: 'ok', turns: 1 })),
    transcribe: async () => '',
    listarAgentes: async () => [],
    ...o,
  } as PipelineDeps;
}

const turno = {
  proyectoId: PROYECTO,
  proyecto: 'demo',
  agente: 'c1' as const,
  usuarioId: USUARIO,
  prompt: 'agregá el login',
  origen: 'panel' as const,
  repos: [{ nombre: 'web', github_repo: 'acme/web' }],
};

describe('el turno', () => {
  it('no usa un Claude ajeno, y corta antes de crear el job', async () => {
    const store = new InMemoryStore();
    store.puedeUsarSlot = async () => false;
    const ask = vi.fn();
    await expect(ejecutarTurno(deps({ store, ask }), turno)).rejects.toThrow('slot_ajeno');
    expect(ask).not.toHaveBeenCalled();
  });

  it('le pasa al agente el trabajo en curso delante del pedido, pero el job guarda el pedido original', async () => {
    const store = new InMemoryStore();
    const ask = vi.fn(async (r: { jobId: string }) => ({ jobId: r.jobId, sessionId: 's', text: 'ok', turns: 1 }));
    const trabajoEnCurso = vi.fn(async () => [enCurso({ agente: 'c3', proyecto: 'demo' })]);
    const { jobId } = await ejecutarTurno(deps({ store, ask, trabajoEnCurso }), turno);

    expect(trabajoEnCurso).toHaveBeenCalledWith(['web']);
    const enviado = (ask.mock.calls[0]![0] as unknown as { prompt: string }).prompt;
    expect(enviado).toContain('Trabajo en curso de otros agentes');
    expect(enviado).toContain('c3 (proyecto demo)');
    expect(enviado.endsWith('## El pedido\n\nagregá el login')).toBe(true);
    expect((await store.recentJobs(5)).find((j) => j.id === jobId)?.prompt).toBe('agregá el login');
  });

  it('si el gateway no contesta, el turno sigue sin aviso', async () => {
    const ask = vi.fn(async (r: { jobId: string }) => ({ jobId: r.jobId, sessionId: 's', text: 'ok', turns: 1 }));
    await ejecutarTurno(
      deps({
        ask,
        trabajoEnCurso: async () => {
          throw new Error('caido');
        },
      }),
      turno,
    );
    expect((ask.mock.calls[0]![0] as unknown as { prompt: string }).prompt).toBe('agregá el login');
  });

  it('el relevo saltea los Claudes que la persona no puede usar', async () => {
    const store = new InMemoryStore();
    store.puedeUsarSlot = async (_u: string, slot: string) => slot !== 'c2';
    const ask = vi.fn(async (r: { jobId: string; agent: string }) => {
      if (r.agent === 'c1') throw new Error('usage_limit');
      return { jobId: r.jobId, sessionId: 's', text: `contesto ${r.agent}`, turns: 1 };
    });
    const listarAgentes = async () =>
      ['c1', 'c2', 'c3'].map((id) => ({ id, cuenta: true, arriba: true }));
    const r = await ejecutarTurnoConRelevo(
      deps({ store, ask, listarAgentes } as Partial<PipelineDeps>),
      turno,
    );
    expect(r.agente).toBe('c3');
  });
});

describe('POST /interno/trabajo', () => {
  it('pide el token interno y devuelve el trabajo de la empresa del usuario', async () => {
    const app = Fastify();
    const trabajo = vi.fn(async () => [{ ...enCurso({}), proyecto: 'padel' }]);
    registrarTrabajo(app, { apiToken: 'token-interno-largo-de-prueba', trabajo });

    const sin = await app.inject({ method: 'POST', url: '/interno/trabajo', payload: { usuarioId: USUARIO } });
    expect(sin.statusCode).toBe(401);

    const r = await app.inject({
      method: 'POST',
      url: '/interno/trabajo',
      headers: { authorization: 'Bearer token-interno-largo-de-prueba' },
      payload: { usuarioId: USUARIO },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().trabajo).toHaveLength(1);
    expect(trabajo).toHaveBeenCalledWith(USUARIO);
  });
});
