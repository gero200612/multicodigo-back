import { describe, expect, it } from 'vitest';
import { horarioEnCastellano, horariosParaOfrecer, invitacionIcs, sigueLibre } from '../src/agenda.js';
import { elegirRubro, RUBROS } from '../src/rubros.js';
import { leerDia } from '../src/telegram.js';
import { esIpPrivada, leerSitio, mailsDeHtml, textoDeHtml } from '../src/web.js';

describe('agenda', () => {
  const martes = new Date('2026-09-29T17:00:00Z');

  it('ofrece tres horarios en tres dias habiles distintos, desde mañana, dentro de 12 a 20', () => {
    const hs = horariosParaOfrecer(martes, [], []);
    expect(hs.map(horarioEnCastellano)).toEqual([
      'miércoles 30/9 a las 15:00',
      'jueves 1/10 a las 12:30',
      'viernes 2/10 a las 18:00',
    ]);
  });

  it('salta los dias ocupados y los horarios tomados', () => {
    const tomado = new Date('2026-09-30T18:00:00Z'); // miercoles 15hs
    const hs = horariosParaOfrecer(martes, [tomado], ['2026-10-01']);
    expect(hs.map(horarioEnCastellano)).toEqual([
      'miércoles 30/9 a las 15:30',
      'viernes 2/10 a las 12:30',
      'lunes 5/10 a las 18:00',
    ]);
  });

  it('sigueLibre rechaza fuera de franja y fines de semana', () => {
    expect(sigueLibre(new Date('2026-09-30T18:00:00Z'), [], [])).toBe(true);
    expect(sigueLibre(new Date('2026-09-30T12:00:00Z'), [], [])).toBe(false); // 9hs
    expect(sigueLibre(new Date('2026-10-03T18:00:00Z'), [], [])).toBe(false); // sabado
  });

  it('la invitacion es un VEVENT valido con los invitados', () => {
    const ics = invitacionIcs({
      uid: 'r1@sincro',
      inicio: new Date('2026-09-30T18:00:00Z'),
      fin: new Date('2026-09-30T18:30:00Z'),
      titulo: 'Sincro + La Distri, SRL',
      descripcion: 'Charla',
      link: 'https://meet.jit.si/Sincro-abc',
      organizador: 'sincro.ventas@gmail.com',
      invitados: ['ana@x.com'],
    });
    expect(ics).toContain('METHOD:REQUEST');
    expect(ics).toContain('SUMMARY:Sincro + La Distri\\, SRL');
    expect(ics).toContain('ATTENDEE;ROLE=REQ-PARTICIPANT;RSVP=TRUE:mailto:ana@x.com');
  });
});

describe('web', () => {
  it('saca los mails, los del propio dominio primero, sin falsos de imagenes', () => {
    const html = `<a href="mailto:Info@LaDistri.com.ar">x</a> diseño: web@agencia.com logo@2x.png foto.jpg@x.png`;
    expect(mailsDeHtml(html, 'https://www.ladistri.com.ar')).toEqual(['info@ladistri.com.ar', 'web@agencia.com']);
  });

  it('el texto no trae scripts ni estilos', () => {
    expect(textoDeHtml('<style>a{}</style><p>Hola</p><script>x()</script><p>chau</p>')).toBe('Hola\n chau');
  });

  it('no le pega a la red interna', () => {
    for (const ip of ['127.0.0.1', '10.0.0.5', '192.168.1.1', '172.20.0.1', '169.254.1.1', '::1', 'fd00::1']) {
      expect(esIpPrivada(ip)).toBe(true);
    }
    expect(esIpPrivada('8.8.8.8')).toBe(false);
  });

  it('sin mail en la home busca en la pagina de contacto', async () => {
    const paginas: Record<string, string> = {
      'https://x.com.ar': '<p>Somos X</p>',
      'https://x.com.ar/contacto': '<p>Escribinos a hola@x.com.ar</p>',
    };
    const r = await leerSitio('https://x.com.ar', async (u) => paginas[u.replace(/\/$/, '')]);
    expect(r?.mails).toEqual(['hola@x.com.ar']);
  });
});

describe('rubros', () => {
  it('prueba primero los que nunca se probaron', () => {
    const stats = RUBROS.slice(1).map((r) => ({ rubro: r.id, contactados: 10, respuestas: 5 }));
    expect(elegirRubro(stats, () => 0).id).toBe(RUBROS[0]!.id);
  });

  it('despues se queda con el que mejor responde', () => {
    const stats = RUBROS.map((r) => ({ rubro: r.id, contactados: 20, respuestas: r.id === 'taller' ? 6 : 1 }));
    expect(elegirRubro(stats, () => 0.9).id).toBe('taller');
  });
});

describe('leerDia', () => {
  it('entiende dd/mm y dd/mm/aaaa', () => {
    const ahora = new Date('2026-09-29T17:00:00Z');
    expect(leerDia('30/9', ahora)).toBe('2026-09-30');
    expect(leerDia('1/10/2026', ahora)).toBe('2026-10-01');
    expect(leerDia('mañana', ahora)).toBeUndefined();
  });
});
