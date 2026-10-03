using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using MultiCodigo.Panel;

namespace MultiCodigo.Panel.Tests;

/// <summary>
/// La cuenta de Claude de Homero y de Patán: el mismo login que un slot, con
/// el bot como destino, y solo para el dueño de Homero.
/// </summary>
public class CuentaDeBotTests(PanelFactory f) : IClassFixture<PanelFactory>
{
    private (HttpClient Cliente, LoginFalso Login) Armar(string duenio = AuthDePrueba.Usuario)
    {
        var login = new LoginFalso();
        var app = f.WithWebHostBuilder(b =>
        {
            b.UseSetting("HOMERO_USUARIO_ID", duenio);
            b.ConfigureTestServices(s => s.AddSingleton<ILoginClient>(login));
        });
        var c = app.CreateClient();
        c.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", AuthDePrueba.TokenValido);
        return (c, login);
    }

    [Theory]
    [InlineData("homero")]
    [InlineData("patan")]
    public async Task ElDuenioDeHomeroConectaLaCuentaDelBot(string bot)
    {
        var (c, login) = Armar();
        var r = await c.GetAsync($"/api/bots/{bot}/login/start");
        Assert.Equal(HttpStatusCode.OK, r.StatusCode);
        var codigo = await c.PostAsJsonAsync($"/api/bots/{bot}/login/code", new { code = "abc" });
        Assert.Equal(HttpStatusCode.OK, codigo.StatusCode);
        Assert.Contains(login.Codigos, x => x.Slot == bot && x.Code == "abc");
    }

    [Fact]
    public async Task UnBotDesconocidoDa404()
    {
        var (c, _) = Armar();
        var r = await c.GetAsync("/api/bots/punchi/login/start");
        Assert.Equal(HttpStatusCode.NotFound, r.StatusCode);
    }

    [Fact]
    public async Task QuienNoEsElDuenioDeHomeroNoPuede()
    {
        var (c, login) = Armar(duenio: "99999999-9999-4999-8999-999999999999");
        var r = await c.GetAsync("/api/bots/homero/login/start");
        Assert.Equal(HttpStatusCode.Forbidden, r.StatusCode);
        var b = await c.DeleteAsync("/api/bots/homero/login");
        Assert.Equal(HttpStatusCode.Forbidden, b.StatusCode);
        Assert.Empty(login.Borrados);
    }
}
