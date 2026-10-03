using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;

namespace MultiCodigo.Panel.Tests;

/// <summary>
/// "Esta cuenta de Claude es de Homero": solo el dueño del proyecto del slot,
/// y solo a uno de los tres bots.
/// </summary>
public class BotDelSlotTests(PanelFactory f) : IClassFixture<PanelFactory>
{
    private const string ProyectoDeC1 = "11111111-1111-4111-8111-111111111111";

    private HttpClient Cliente()
    {
        var c = f.CreateClient();
        c.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", AuthDePrueba.TokenValido);
        return c;
    }

    [Fact]
    public async Task ElDuenioAsignaLaCuentaAHomero()
    {
        f.Proyectos.Roles[ProyectoDeC1] = "dueño";
        f.Agentes.Bots.Clear();
        var r = await Cliente().PutAsJsonAsync("/api/slots/c1/bot", new { bot = "homero" });
        Assert.Equal(HttpStatusCode.OK, r.StatusCode);
        Assert.Equal("homero", f.Agentes.Bots["c1"]);

        var todos = await Cliente().GetFromJsonAsync<Dictionary<string, string>>("/api/slots/bots");
        Assert.Equal("homero", todos!["c1"]);
    }

    [Fact]
    public async Task AsignarAHomeroCedeLaCredencial()
    {
        f.Proyectos.Roles[ProyectoDeC1] = "dueño";
        f.Agentes.Bots.Clear();
        f.Login.Cesiones.Clear();
        f.Login.FallaCeder = null;
        await Cliente().PutAsJsonAsync("/api/slots/c1/bot", new { bot = "homero" });
        Assert.Equal([("ceder", "c1", "homero")], f.Login.Cesiones);
    }

    [Fact]
    public async Task DePatanAHomeroPrimeroDevuelveYDespuesCede()
    {
        f.Proyectos.Roles[ProyectoDeC1] = "dueño";
        f.Agentes.Bots.Clear();
        f.Agentes.Bots["c1"] = "patan";
        f.Login.Cesiones.Clear();
        f.Login.FallaCeder = null;
        await Cliente().PutAsJsonAsync("/api/slots/c1/bot", new { bot = "homero" });
        Assert.Equal([("recuperar", "c1", "patan"), ("ceder", "c1", "homero")], f.Login.Cesiones);
        Assert.Equal("homero", f.Agentes.Bots["c1"]);
    }

    [Fact]
    public async Task SiElLoginNoPuedeMoverlaNoSeAnota()
    {
        f.Proyectos.Roles[ProyectoDeC1] = "dueño";
        f.Agentes.Bots.Clear();
        f.Login.Cesiones.Clear();
        f.Login.FallaCeder = "homero ya tiene la cuenta de c2";
        var r = await Cliente().PutAsJsonAsync("/api/slots/c1/bot", new { bot = "homero" });
        Assert.Equal(HttpStatusCode.Conflict, r.StatusCode);
        Assert.False(f.Agentes.Bots.ContainsKey("c1"));
        f.Login.FallaCeder = null;
    }

    [Fact]
    public async Task UnMiembroNoCambiaElBot()
    {
        f.Proyectos.Roles[ProyectoDeC1] = "miembro";
        f.Agentes.Bots.Clear();
        var r = await Cliente().PutAsJsonAsync("/api/slots/c1/bot", new { bot = "homero" });
        Assert.Equal(HttpStatusCode.Forbidden, r.StatusCode);
        Assert.Empty(f.Agentes.Bots);
    }

    [Theory]
    [InlineData("otro")]
    [InlineData("")]
    public async Task SoloLosTresBots(string bot)
    {
        f.Proyectos.Roles[ProyectoDeC1] = "dueño";
        var r = await Cliente().PutAsJsonAsync("/api/slots/c1/bot", new { bot });
        Assert.Equal(HttpStatusCode.BadRequest, r.StatusCode);
    }
}
