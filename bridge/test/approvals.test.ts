import { describe, it, expect, vi } from 'vitest';
import { tickApprovals, startWatching } from '../src/approvals.js';
import type { ApprovalRequest } from '@multicodigo/shared';

function aprobacion(id: string, summary = 's'): ApprovalRequest {
  return {
    approvalId: id,
    jobId: '22222222-2222-4222-8222-222222222222',
    agent: 'c1',
    tool: 'Write',
    summary,
    createdAt: '2026-08-25T12:00:00.000Z',
    expiresAt: '2026-08-25T12:15:00.000Z',
  };
}

describe('tickApprovals', () => {
  it('anuncia una aprobacion nueva', async () => {
    const anunciadas: string[] = [];
    await tickApprovals({
      fetchPending: async () => [aprobacion('a')],
      announce: async (a) => void anunciadas.push(a.approvalId),
      seen: new Set(),
    });
    expect(anunciadas).toEqual(['a']);
  });

  // El poller corre cada 2 segundos y la aprobacion sigue pendiente hasta que
  // el usuario decide: sin esto, el chat recibe el mismo mensaje 450 veces.
  it('no vuelve a anunciar la misma aprobacion', async () => {
    const anunciadas: string[] = [];
    const seen = new Set<string>();
    const deps = {
      fetchPending: async () => [aprobacion('a')],
      announce: async (x: ApprovalRequest) => void anunciadas.push(x.approvalId),
      seen,
    };
    await tickApprovals(deps);
    await tickApprovals(deps);
    await tickApprovals(deps);
    expect(anunciadas).toEqual(['a']);
  });

  it('anuncia la segunda aprobacion cuando aparece', async () => {
    const anunciadas: string[] = [];
    const seen = new Set<string>();
    let lista = [aprobacion('a')];
    const deps = {
      fetchPending: async () => lista,
      announce: async (x: ApprovalRequest) => void anunciadas.push(x.approvalId),
      seen,
    };
    await tickApprovals(deps);
    lista = [aprobacion('a'), aprobacion('b')];
    await tickApprovals(deps);
    expect(anunciadas).toEqual(['a', 'b']);
  });

  // El poller no puede morir por un error de red: el turno del hijo sigue
  // corriendo y la proxima pasada tiene que volver a intentar.
  it('no tira cuando fetchPending falla', async () => {
    await expect(
      tickApprovals({
        fetchPending: async () => {
          throw new Error('ECONNREFUSED');
        },
        announce: async () => {},
        seen: new Set(),
      }),
    ).resolves.toBeUndefined();
  });

  it('no tira cuando announce falla, y reintenta esa aprobacion despues', async () => {
    const seen = new Set<string>();
    let fallar = true;
    const anunciadas: string[] = [];
    const deps = {
      fetchPending: async () => [aprobacion('a')],
      announce: async (x: ApprovalRequest) => {
        if (fallar) throw new Error('telegram caido');
        anunciadas.push(x.approvalId);
      },
      seen,
    };
    await expect(tickApprovals(deps)).resolves.toBeUndefined();
    fallar = false;
    await tickApprovals(deps);
    expect(anunciadas).toEqual(['a']);
  });
});

describe('startWatching', () => {
  it('deja de poulear cuando se lo para', async () => {
    vi.useFakeTimers();
    let vueltas = 0;
    const stop = startWatching(
      {
        fetchPending: async () => {
          vueltas += 1;
          return [];
        },
        announce: async () => {},
        seen: new Set(),
      },
      1000,
    );
    await vi.advanceTimersByTimeAsync(3000);
    const alParar = vueltas;
    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(vueltas).toBe(alParar);
    expect(alParar).toBeGreaterThan(0);
    vi.useRealTimers();
  });
});
