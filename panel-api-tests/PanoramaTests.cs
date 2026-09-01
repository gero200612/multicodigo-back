using Microsoft.Extensions.Logging.Abstractions;
using MultiCodigo.Panel;

namespace MultiCodigo.Panel.Tests;

public class PanoramaTests
{
    private static (PanoramaService Svc, GatewayFalso G, LoginFalso L, BridgeFalso B, HistorialFalso H) Armar()
    {
        var g = new GatewayFalso();
        var l = new LoginFalso();
        var b = new BridgeFalso();
        var h = new HistorialFalso();
        return (new PanoramaService(g, l, b, h, NullLogger<PanoramaService>.Instance), g, l, b, h);
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
        var (svc, g, _, _, _) = Armar();
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
        var (svc, _, l, _, h) = Armar();
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
        var (svc, g, l, _, h) = Armar();
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
        var (svc, g, l, _, _) = Armar();
        g.Agentes = [new("c1", true)];
        l.Estados["c1"] = new EstadoCredencial(true, "a");

        Assert.False((await svc.VerAsync("jwt")).Slots.Single().Funcionando);
    }

    [Fact]
    public async Task SiElLoginSeCaeIgualMuestraLosSlots()
    {
        var (svc, _, l, _, _) = Armar();
        l.Falla = true;

        var p = await svc.VerAsync("jwt");

        Assert.Equal(2, p.Slots.Count);
        Assert.False(p.Slots[0].TieneCredencial);
    }

    [Fact]
    public async Task SiSupabaseSeCaeIgualMuestraLosSlots()
    {
        var (svc, _, _, _, h) = Armar();
        h.Falla = true;

        var p = await svc.VerAsync("jwt");

        Assert.Equal(2, p.Slots.Count);
        Assert.Null(p.Slots[0].UltimoTest);
    }

    [Fact]
    public async Task SiElBridgeSeCaeIgualMuestraElResto()
    {
        var (svc, _, _, b, _) = Armar();
        b.Falla = true;

        var p = await svc.VerAsync("jwt");

        Assert.Empty(p.Jobs);
        Assert.Equal(2, p.Slots.Count);
    }

    [Fact]
    public async Task SiLaColaSeCaeIgualMuestraElResto()
    {
        var (svc, g, _, _, _) = Armar();
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
        var (svc, g, _, _, _) = Armar();
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
        var (svc, g, _, _, h) = Armar();
        g.Agentes = [new("c1", true), new("c2", true)];

        await svc.VerAsync("jwt-del-usuario");

        Assert.Equal(2, h.JwtsLeidos.Count);
        Assert.All(h.JwtsLeidos, j => Assert.Equal("jwt-del-usuario", j));
    }
}
