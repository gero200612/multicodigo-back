using Microsoft.Extensions.Logging.Abstractions;
using MultiCodigo.Panel;

namespace MultiCodigo.Panel.Tests;

public class PanoramaTests
{
    private static (PanoramaService Svc, GatewayFalso G, LoginFalso L, BridgeFalso B,
                    HistorialFalso H, AgentesFalso A) Armar()
    {
        var g = new GatewayFalso();
        var l = new LoginFalso();
        var b = new BridgeFalso();
        var h = new HistorialFalso();
        var a = new AgentesFalso();
        return (new PanoramaService(g, l, b, h, a, NullLogger<PanoramaService>.Instance), g, l, b, h, a);
    }

    /// <summary>
    /// Cada uno ve SOLO los agentes de sus proyectos.
    ///
    /// El panorama pedía la lista al gateway —que la saca de Docker y no sabe
    /// nada de usuarios— y la devolvía entera. El JWT se usaba para enriquecer
    /// cada slot, no para decidir cuáles se ven, así que alguien recién invitado
    /// a su propio proyecto entraba y veía los agentes de todos los demás.
    ///
    /// El filtro correcto ya estaba a mano: `ProyectosPorSlotAsync` consulta con
    /// el JWT del usuario y RLS deja pasar solo los slots de sus proyectos.
    /// </summary>
    [Fact]
    public async Task SoloSeVenLosAgentesDeMisProyectos()
    {
        var (svc, g, _, _, _, a) = Armar();
        // Tres slots en la máquina; dos son de otro proyecto.
        g.Agentes = [new("c1", true, "ajeno"), new("c2", true, "ajeno"), new("c3", true, "mio")];
        a.PorSlot.Clear();
        a.PorSlot["c3"] = "33333333-3333-4333-8333-333333333333";

        var p = await svc.VerAsync("jwt");

        Assert.Equal(["c3"], p.Slots.Select(s => s.Slot).ToArray());
    }

    /// <summary>
    /// Sin ningún slot propio, la lista viene vacía y no completa.
    ///
    /// Es el caso de alguien recién invitado, y el que más importa: es
    /// exactamente cuando el bug de arriba mostraba todo.
    /// </summary>
    [Fact]
    public async Task SinSlotsPropiosNoSeVeNinguno()
    {
        var (svc, g, _, _, _, a) = Armar();
        g.Agentes = [new("c1", true, "ajeno"), new("c2", true, "ajeno")];
        a.PorSlot.Clear();

        var p = await svc.VerAsync("jwt");

        Assert.Empty(p.Slots);
    }

    /// <summary>
    /// El id del proyecto sale de la TABLA y no del contenedor.
    ///
    /// Los dos pueden divergir: el contenedor lleva el proyecto con el que se
    /// creo. Cuando el nombre del contenedor quedaba viejo, el front no podia
    /// cruzarlo con la lista de proyectos del usuario y el boton de probar
    /// quedaba deshabilitado sin decir por que.
    /// </summary>
    [Fact]
    public async Task ElIdDelProyectoSaleDeLaTablaYNoDelContenedor()
    {
        var (svc, g, _, _, _, a) = Armar();
        g.Agentes = [new("c1", true, "nombre-viejo-del-contenedor")];
        a.PorSlot["c1"] = "22222222-2222-4222-8222-222222222222";

        var p = await svc.VerAsync("jwt");
        var slot = p.Slots.Single();

        Assert.Equal("22222222-2222-4222-8222-222222222222", slot.ProyectoId);
        // El nombre del contenedor se sigue devolviendo, pero solo para mostrar.
        Assert.Equal("nombre-viejo-del-contenedor", slot.Proyecto);
    }

    /// <summary>
    /// Un slot que la tabla no conoce NO se muestra.
    ///
    /// Antes se mostraba con `proyectoId` en null y el front deshabilitaba el
    /// botón de probar. Desde que el panorama filtra por la asignación de la
    /// tabla, un slot sin anotar es indistinguible de uno de otro usuario —en
    /// los dos casos la consulta con el JWT no lo devuelve— y mostrarlo sería
    /// exponer los agentes ajenos por la puerta de atrás.
    ///
    /// El costo es real: un slot recién creado que todavía no se registró en la
    /// tabla no aparece hasta que se registre. Es preferible a la alternativa.
    /// </summary>
    [Fact]
    public async Task UnSlotSinAnotarNoSeMuestra()
    {
        var (svc, g, _, _, _, a) = Armar();
        g.Agentes = [new("c1", true, "demo")];
        a.PorSlot.Clear();

        var p = await svc.VerAsync("jwt");

        Assert.Empty(p.Slots);
    }

    /// <summary>
    /// El proyecto de cada slot llega al front.
    ///
    /// El gateway ya lo devolvia en /agents y el panel lo descartaba en su DTO.
    /// Sin esto el dashboard no puede probar un slot: probar corre un turno en el
    /// worktree de UN proyecto, y esa pantalla es una vista global de slots.
    /// </summary>
    [Fact]
    public async Task ElProyectoDeCadaSlotLlegaAlPanorama()
    {
        var (svc, g, _, _, _, _) = Armar();
        g.Agentes = [new("c1", true, "mi-proyecto"), new("c2", false, null)];

        var p = await svc.VerAsync("jwt");

        Assert.Equal("mi-proyecto", p.Slots.Single(s => s.Slot == "c1").Proyecto);
        // Un slot sin proyecto asignado se muestra igual, sin proyecto: el front
        // deshabilita el boton, que es honesto — no hay worktree que probar.
        Assert.Null(p.Slots.Single(s => s.Slot == "c2").Proyecto);
    }

    [Fact]
    public async Task JuntaLosTresEstados()
    {
        var (svc, _, l, _, h, _) = Armar();
        l.Estados["c1"] = new EstadoCredencial(true, "yo@ejemplo.com", "ayer", false);
        h.Ultimos["c1"] = new ResultadoTest(true, "hoy", "ok");

        var p = await svc.VerAsync("jwt");

        var c1 = p.Slots.Single(s => s.Slot == "c1");
        Assert.True(c1.Arriba);
        Assert.True(c1.TieneCredencial);
        Assert.Equal("yo@ejemplo.com", c1.Account);
        Assert.True(c1.Funcionando);

        var c2 = p.Slots.Single(s => s.Slot == "c2");
        Assert.False(c2.Arriba);
        Assert.False(c2.TieneCredencial);
        Assert.False(c2.Funcionando);
    }

    /// <summary>
    /// El caso que el diseño insiste en no colapsar: un slot puede estar arriba,
    /// con credencial, y roto. Es exactamente lo que pasa cuando vence un token
    /// —el modo de falla más frecuente del sistema— y si "funcionando" se
    /// dedujera de los otros dos, el panel diría que está todo bien.
    /// </summary>
    [Fact]
    public async Task ArribaYConCredencialPuedeNoEstarFuncionando()
    {
        var (svc, g, l, _, h, _) = Armar();
        g.Agentes = [new("c1", true)];
        l.Estados["c1"] = new EstadoCredencial(true, "a");
        h.Ultimos["c1"] = new ResultadoTest(false, "hoy", "auth_expired");

        var c1 = (await svc.VerAsync("jwt")).Slots.Single();

        Assert.True(c1.Arriba);
        Assert.True(c1.TieneCredencial);
        Assert.False(c1.Funcionando);
    }

    [Fact]
    public async Task SinTestCorridoNoEstaFuncionando()
    {
        var (svc, g, l, _, _, _) = Armar();
        g.Agentes = [new("c1", true)];
        l.Estados["c1"] = new EstadoCredencial(true, "a");

        Assert.False((await svc.VerAsync("jwt")).Slots.Single().Funcionando);
    }

    [Fact]
    public async Task SiElLoginSeCaeIgualMuestraLosSlots()
    {
        var (svc, _, l, _, _, _) = Armar();
        l.Falla = true;

        var p = await svc.VerAsync("jwt");

        Assert.Equal(2, p.Slots.Count);
        Assert.False(p.Slots[0].TieneCredencial);
    }

    [Fact]
    public async Task SiSupabaseSeCaeIgualMuestraLosSlots()
    {
        var (svc, _, _, _, h, _) = Armar();
        h.Falla = true;

        var p = await svc.VerAsync("jwt");

        Assert.Equal(2, p.Slots.Count);
        Assert.Null(p.Slots[0].UltimoTest);
    }

    [Fact]
    public async Task SiElBridgeSeCaeIgualMuestraElResto()
    {
        var (svc, _, _, b, _, _) = Armar();
        b.Falla = true;

        var p = await svc.VerAsync("jwt");

        Assert.Empty(p.Jobs);
        Assert.Equal(2, p.Slots.Count);
    }

    [Fact]
    public async Task SiLaColaSeCaeIgualMuestraElResto()
    {
        var (svc, g, _, _, _, _) = Armar();
        g.ColaFalla = true;

        var p = await svc.VerAsync("jwt");

        Assert.Empty(p.Cola.Corriendo);
        Assert.Equal(2, p.Slots.Count);
    }

    /// <summary>
    /// Sin el gateway no hay nada que mostrar, y eso SÍ tiene que propagarse:
    /// una lista vacía se leería como "no tenés ningún agente".
    /// </summary>
    [Fact]
    public async Task SiElGatewayNoRespondeElErrorSube()
    {
        var (svc, g, _, _, _, _) = Armar();
        g.AgentesFalla = true;

        await Assert.ThrowsAsync<HttpRequestException>(() => svc.VerAsync("jwt"));
    }

    /// <summary>
    /// El panel no tiene credencial de escritura a Supabase: reenvía el JWT del
    /// usuario y RLS decide. Si esto se rompiera y empezara a usar una clave
    /// propia, cualquier agujero suyo escribiría la base con permisos que el
    /// usuario no tiene.
    /// </summary>
    [Fact]
    public async Task LeReenviaElJwtDelUsuarioAlHistorial()
    {
        var (svc, g, _, _, h, _) = Armar();
        g.Agentes = [new("c1", true), new("c2", true)];

        await svc.VerAsync("jwt-del-usuario");

        Assert.Equal(2, h.JwtsLeidos.Count);
        Assert.All(h.JwtsLeidos, j => Assert.Equal("jwt-del-usuario", j));
    }
}
