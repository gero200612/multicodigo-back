using MultiCodigo.Panel;

namespace MultiCodigo.Panel.Tests;

public class CualquieraTests
{
    private static SlotVista S(string slot, bool cred = true, bool trabajando = false, string? sinCuota = null, string? proyecto = "p")
        => new(slot, Arriba: false, TieneCredencial: cred, LoginAbierto: false, Funcionando: true,
            ProyectoId: proyecto, SinCuotaHasta: sinCuota, Trabajando: trabajando);

    [Fact]
    public void LibreEsElPrimeroConCuentaSinTurnoYConCuota_EnOrdenNumerico()
    {
        var slots = new[]
        {
            S("c10"),
            S("c1", trabajando: true),
            S("c2", sinCuota: "10:50pm"),
            S("c3", cred: false),
            S("c4", proyecto: null),
            S("c9"),
        };
        Assert.Equal("c9", Cualquiera.Libre(slots));
    }

    [Fact]
    public void SinNingunoLibreDaNull() => Assert.Null(Cualquiera.Libre([S("c1", trabajando: true)]));

    [Fact]
    public async Task EsperaAlPrimeroQueSeLibera_YAvisaUnaSolaVez()
    {
        var vueltas = 0;
        var avisos = 0;
        var r = await Cualquiera.ConElPrimeroLibre(
            _ => Task.FromResult<IEnumerable<SlotVista>>(++vueltas < 3 ? [S("c1", trabajando: true)] : [S("c1")]),
            slot => Task.FromResult(slot),
            () => { avisos++; return Task.CompletedTask; },
            CancellationToken.None, cada: TimeSpan.Zero);
        Assert.Equal("c1", r);
        Assert.Equal(3, vueltas);
        Assert.Equal(1, avisos);
    }

    [Fact]
    public async Task SiOtroLoTomaJustoVuelveAEsperarEnVezDeFallar()
    {
        var intentos = 0;
        var r = await Cualquiera.ConElPrimeroLibre(
            _ => Task.FromResult<IEnumerable<SlotVista>>([S("c1")]),
            slot => ++intentos == 1 ? throw new UpstreamException("agente_ocupado") : Task.FromResult(slot),
            null, CancellationToken.None, cada: TimeSpan.Zero);
        Assert.Equal("c1", r);
        Assert.Equal(2, intentos);
    }

    [Fact]
    public async Task UnSlotAjenoSeDescartaYSigueConOtro()
    {
        var pedidos = new List<string>();
        var r = await Cualquiera.ConElPrimeroLibre(
            _ => Task.FromResult<IEnumerable<SlotVista>>([S("c1"), S("c2")]),
            slot => { pedidos.Add(slot); return slot == "c1" ? throw new UpstreamException("slot_ajeno") : Task.FromResult(slot); },
            null, CancellationToken.None, cada: TimeSpan.Zero);
        Assert.Equal("c2", r);
        Assert.Equal(["c1", "c2"], pedidos);
    }

    [Fact]
    public async Task OtroErrorDelTurnoSube()
    {
        await Assert.ThrowsAsync<UpstreamException>(() => Cualquiera.ConElPrimeroLibre<string>(
            _ => Task.FromResult<IEnumerable<SlotVista>>([S("c1")]),
            _ => throw new UpstreamException("git_failed"),
            null, CancellationToken.None, cada: TimeSpan.Zero));
    }

    [Fact]
    public async Task PasadoElTopeDaSinAgenteLibre()
    {
        var t = DateTimeOffset.UnixEpoch;
        var e = await Assert.ThrowsAsync<UpstreamException>(() => Cualquiera.ConElPrimeroLibre<string>(
            _ => { t += TimeSpan.FromMinutes(20); return Task.FromResult<IEnumerable<SlotVista>>([]); },
            Task.FromResult,
            null, CancellationToken.None, cada: TimeSpan.Zero, ahora: () => t));
        Assert.Equal("sin_agente_libre", e.Message);
    }
}
