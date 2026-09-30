using System.Net;
using System.Net.Http.Headers;
using System.Text;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using MultiCodigo.Panel;

namespace MultiCodigo.Panel.Tests;

public sealed class HomeroFalso : IHomeroClient
{
    public bool Configurado => true;
    public List<(string Metodo, string Ruta, string? Cuerpo)> Pedidos { get; } = [];
    public Exception? Falla { get; set; }

    public Task<RespuestaDeHomero> ReenviarAsync(
        HttpMethod metodo, string rutaYQuery, string? cuerpoJson, CancellationToken ct)
    {
        if (Falla is not null) throw Falla;
        Pedidos.Add((metodo.Method, rutaYQuery, cuerpoJson));
        return Task.FromResult(new RespuestaDeHomero(
            rutaYQuery.Contains("aprobar", StringComparison.Ordinal) ? 409 : 200, "{\"ok\":true}"));
    }
}

public class HomeroTests(PanelFactory f) : IClassFixture<PanelFactory>
{
    private (HttpClient Cliente, HomeroFalso Homero) Armar(string duenio = AuthDePrueba.Usuario)
    {
        var homero = new HomeroFalso();
        var app = f.WithWebHostBuilder(b =>
        {
            b.UseSetting("HOMERO_URL", "http://homero.test");
            b.UseSetting("HOMERO_API_TOKEN", "token-de-homero-largo");
            b.UseSetting("HOMERO_USUARIO_ID", duenio);
            b.ConfigureTestServices(s => s.AddSingleton<IHomeroClient>(homero));
        });
        var c = app.CreateClient();
        c.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", AuthDePrueba.TokenValido);
        return (c, homero);
    }

    [Fact]
    public async Task ElDuenioPasaConRutaQueryYCuerpo()
    {
        var (c, homero) = Armar();
        var r = await c.GetAsync("/api/homero/leads?estado=borrador&pagina=1");
        Assert.Equal(HttpStatusCode.OK, r.StatusCode);

        await c.PatchAsync("/api/homero/salientes/4",
            new StringContent("{\"cuerpo\":\"hola\"}", Encoding.UTF8, "application/json"));

        Assert.Equal(("GET", "/leads?estado=borrador&pagina=1", (string?)null), homero.Pedidos[0]);
        Assert.Equal(("PATCH", "/salientes/4", "{\"cuerpo\":\"hola\"}"), homero.Pedidos[1]);
    }

    [Fact]
    public async Task ElStatusDeHomeroLlegaTalCual()
    {
        var (c, _) = Armar();
        var r = await c.PostAsync("/api/homero/leads/3/aprobar", null);
        Assert.Equal(HttpStatusCode.Conflict, r.StatusCode);
    }

    [Fact]
    public async Task OtroUsuarioRecibe403YNoLlegaNada()
    {
        var (c, homero) = Armar(duenio: "22222222-2222-4222-8222-222222222222");
        var r = await c.GetAsync("/api/homero/estado");
        Assert.Equal(HttpStatusCode.Forbidden, r.StatusCode);
        Assert.Empty(homero.Pedidos);
    }

    [Fact]
    public async Task SinSesionEs401()
    {
        var (c, _) = Armar();
        c.DefaultRequestHeaders.Authorization = null;
        Assert.Equal(HttpStatusCode.Unauthorized, (await c.GetAsync("/api/homero/estado")).StatusCode);
    }

    [Fact]
    public async Task HomeroCaidoEs503()
    {
        var (c, homero) = Armar();
        homero.Falla = new HttpRequestException("connection refused");
        Assert.Equal(HttpStatusCode.ServiceUnavailable, (await c.GetAsync("/api/homero/estado")).StatusCode);
    }

    [Fact]
    public async Task SinConfigurarEs404()
    {
        var c = f.CreateClient();
        c.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", AuthDePrueba.TokenValido);
        Assert.Equal(HttpStatusCode.NotFound, (await c.GetAsync("/api/homero/estado")).StatusCode);
    }

    [Theory]
    [InlineData("leads/../../admin")]
    [InlineData("leads%2F..%2Fx")]
    public async Task UnaRutaRaraNoSeReenvia(string ruta)
    {
        var (c, homero) = Armar();
        var r = await c.GetAsync($"/api/homero/{ruta}");
        Assert.NotEqual(HttpStatusCode.OK, r.StatusCode);
        Assert.Empty(homero.Pedidos);
    }
}
