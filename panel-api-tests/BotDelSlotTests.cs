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
