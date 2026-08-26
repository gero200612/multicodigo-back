using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Claims;
using System.Text.Encodings.Web;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using MultiCodigo.Panel;

namespace MultiCodigo.Panel.Tests;

/// <summary>
/// Autenticación de prueba.
///
/// Reemplaza la verificación real del JWT de Supabase, que necesitaría un
/// proyecto y una clave. Lo que SÍ se prueba con esto es lo que depende del
/// panel: que las rutas de /api exijan sesión, que /health y /config.json no, y
/// que el token del usuario llegue al historial.
///
/// La verificación de la firma en sí la hace la librería de Microsoft, no
/// nosotros: no tiene sentido testear su implementación.
/// </summary>
internal sealed class AuthDePrueba(
    IOptionsMonitor<AuthenticationSchemeOptions> options,
    ILoggerFactory logger,
    UrlEncoder encoder)
    : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder)
{
    public const string Esquema = "Prueba";
    public const string TokenValido = "jwt-del-usuario";

    protected override Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        var header = Request.Headers.Authorization.ToString();
        if (!header.StartsWith("Bearer ", StringComparison.Ordinal))
        {
            return Task.FromResult(AuthenticateResult.NoResult());
        }

        var token = header["Bearer ".Length..];
        if (token != TokenValido)
        {
            return Task.FromResult(AuthenticateResult.Fail("token inválido"));
        }

        var id = new ClaimsIdentity([new Claim(ClaimTypes.NameIdentifier, "u1")], Esquema);
        var ticket = new AuthenticationTicket(new ClaimsPrincipal(id), Esquema);
        // Igual que SaveToken=true en producción: es de donde sale el JWT que se
        // reenvía a Supabase.
        ticket.Properties.StoreTokens([new AuthenticationToken { Name = "access_token", Value = token }]);
        return Task.FromResult(AuthenticateResult.Success(ticket));
    }
}

public sealed class PanelFactory : WebApplicationFactory<Program>
{
    public GatewayFalso Gateway { get; } = new();
    public LoginFalso Login { get; } = new();
    public BridgeFalso Bridge { get; } = new();
    public HistorialFalso Historial { get; } = new();

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        // La configuración que Program.cs exige para arrancar. Los tokens tienen
        // el largo mínimo real: si fueran cortos, el guard de arranque tiraría.
        builder.UseSetting("GATEWAY_URL", "http://gateway.test");
        builder.UseSetting("GATEWAY_TOKEN", "token-de-prueba-largo-1");
        builder.UseSetting("LOGIN_URL", "http://login.test");
        builder.UseSetting("LOGIN_TOKEN", "token-de-prueba-largo-2");
        builder.UseSetting("BRIDGE_URL", "http://bridge.test");
        builder.UseSetting("BRIDGE_API_TOKEN", "token-de-prueba-largo-3");
        builder.UseSetting("SUPABASE_URL", "https://proyecto.supabase.co");
        builder.UseSetting("SUPABASE_ANON_KEY", "anon-de-prueba");

        builder.ConfigureTestServices(s =>
        {
            s.AddSingleton<IGatewayClient>(Gateway);
            s.AddSingleton<ILoginClient>(Login);
            s.AddSingleton<IBridgeClient>(Bridge);
            s.AddSingleton<IHistorialClient>(Historial);

            s.AddAuthentication(AuthDePrueba.Esquema)
                .AddScheme<AuthenticationSchemeOptions, AuthDePrueba>(AuthDePrueba.Esquema, _ => { });
        });
    }
}

public class EndpointTests(PanelFactory f) : IClassFixture<PanelFactory>
{
    private HttpClient Cliente(bool conSesion = true)
    {
        var c = f.CreateClient();
        if (conSesion)
        {
            c.DefaultRequestHeaders.Authorization =
                new AuthenticationHeaderValue("Bearer", AuthDePrueba.TokenValido);
        }
        return c;
    }

    // --- rutas públicas ---

    [Fact]
    public async Task HealthNoPideSesion()
    {
        var r = await Cliente(conSesion: false).GetAsync("/health");
        Assert.Equal(HttpStatusCode.OK, r.StatusCode);
    }

    /// <summary>
    /// El navegador necesita estos dos valores ANTES de poder autenticarse, así
    /// que la ruta es pública. La clave anon es pública por diseño.
    /// </summary>
    [Fact]
    public async Task ConfigJsonNoPideSesion()
    {
        var r = await Cliente(conSesion: false).GetFromJsonAsync<ConfigFront>("/config.json");
        Assert.Equal("https://proyecto.supabase.co", r!.SupabaseUrl);
        Assert.Equal("anon-de-prueba", r.SupabaseAnonKey);
    }

    /// <summary>
    /// Los bearers del gateway, del login y del bridge viven en el mismo proceso.
    /// Este test existe para que nadie los agregue a config.json por comodidad.
    /// </summary>
    [Fact]
    public async Task ConfigJsonNoFiltraNingunOtroSecreto()
    {
        var texto = await Cliente(conSesion: false).GetStringAsync("/config.json");
        Assert.DoesNotContain("token-de-prueba-largo", texto, StringComparison.Ordinal);
    }

    // --- auth ---

    [Fact]
    public async Task SinSesionElPanoramaDaUnauthorized()
    {
        var r = await Cliente(conSesion: false).GetAsync("/api/panorama");
        Assert.Equal(HttpStatusCode.Unauthorized, r.StatusCode);
    }

    [Fact]
    public async Task ConUnTokenQueNoVerificaDaUnauthorized()
    {
        var c = f.CreateClient();
        c.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", "token-falso");
        Assert.Equal(HttpStatusCode.Unauthorized, (await c.GetAsync("/api/panorama")).StatusCode);
    }

    // --- panorama ---

    [Fact]
    public async Task DevuelveElPanoramaEnCamelCase()
    {
        f.Login.Estados["c1"] = new EstadoCredencial(true, "yo@ejemplo.com");
        var texto = await Cliente().GetStringAsync("/api/panorama");

        // El front lee `tieneCredencial`, no `TieneCredencial`.
        Assert.Contains("\"tieneCredencial\"", texto, StringComparison.Ordinal);
        Assert.Contains("\"slots\"", texto, StringComparison.Ordinal);
        Assert.Contains("\"cola\"", texto, StringComparison.Ordinal);
        Assert.Contains("\"jobs\"", texto, StringComparison.Ordinal);
    }

    [Fact]
    public async Task SiElGatewayNoRespondeDa503()
    {
        f.Gateway.AgentesFalla = true;
        try
        {
            var r = await Cliente().GetAsync("/api/panorama");
            Assert.Equal(HttpStatusCode.ServiceUnavailable, r.StatusCode);
            // El detalle va al log, no al navegador.
            Assert.DoesNotContain("gateway caído", await r.Content.ReadAsStringAsync(), StringComparison.Ordinal);
        }
        finally
        {
            f.Gateway.AgentesFalla = false;
        }
    }

    // --- probar ---

    [Fact]
    public async Task ProbarDevuelve200YGuardaEnElHistorial()
    {
        var antes = f.Historial.Guardados.Count;
        var r = await Cliente().PostAsync("/api/slots/c1/test", null);

        Assert.Equal(HttpStatusCode.OK, r.StatusCode);
        Assert.Contains("c1", f.Gateway.Probados);
        var guardado = f.Historial.Guardados[^1];
        Assert.Equal("c1", guardado.Slot);
        // El JWT que llega a Supabase es el del USUARIO, no una credencial del panel.
        Assert.Equal(AuthDePrueba.TokenValido, guardado.Jwt);
        Assert.True(f.Historial.Guardados.Count > antes);
    }

    /// <summary>
    /// Un test que falla NO es un error del endpoint: el endpoint funcionó y la
    /// respuesta es "este slot no anda".
    /// </summary>
    [Fact]
    public async Task UnSlotRotoDevuelve200ConOkFalse()
    {
        f.Gateway.Resultado = new ResultadoTest(false, "hoy", "auth_expired");
        try
        {
            var r = await Cliente().PostAsync("/api/slots/c2/test", null);
            Assert.Equal(HttpStatusCode.OK, r.StatusCode);
            var cuerpo = await r.Content.ReadFromJsonAsync<ResultadoTest>(
                new System.Text.Json.JsonSerializerOptions(System.Text.Json.JsonSerializerDefaults.Web));
            Assert.False(cuerpo!.Ok);
        }
        finally
        {
            f.Gateway.Resultado = new ResultadoTest(true, "hoy", "ok");
        }
    }

    // --- login ---

    [Fact]
    public async Task IniciarLoginDevuelveLaUrl()
    {
        var r = await Cliente().PostAsync("/api/slots/c1/login/start", null);
        Assert.Equal(HttpStatusCode.OK, r.StatusCode);
        Assert.Contains("claude.ai", await r.Content.ReadAsStringAsync(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task MandarCodigoLoPasaAlServicioDeLogin()
    {
        var r = await Cliente().PostAsJsonAsync("/api/slots/c1/login/code", new { code = "abc-123" });
        Assert.Equal(HttpStatusCode.OK, r.StatusCode);
        Assert.Contains(("c1", "abc-123"), f.Login.Codigos);
    }

    /// <summary>
    /// El código es de un solo uso y es material de autenticación: que aparezca
    /// en la respuesta es una forma de que termine en un log del navegador.
    /// </summary>
    [Fact]
    public async Task NoDevuelveElCodigo()
    {
        var r = await Cliente().PostAsJsonAsync(
            "/api/slots/c1/login/code", new { code = "codigo-secreto-123" });
        Assert.DoesNotContain("codigo-secreto-123", await r.Content.ReadAsStringAsync(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task SinCodigoDa400()
    {
        var r = await Cliente().PostAsJsonAsync("/api/slots/c1/login/code", new { });
        Assert.Equal(HttpStatusCode.BadRequest, r.StatusCode);
    }

    [Fact]
    public async Task GuardarTokenNoLoDevuelve()
    {
        const string token = "sk-ant-oat01-4f3a9c2b8e1d7a6f5c0b3e9d2a8f1c4b";
        var r = await Cliente().PostAsJsonAsync(
            "/api/slots/c1/login/token", new { token, account = "yo@ejemplo.com" });

        Assert.Equal(HttpStatusCode.OK, r.StatusCode);
        Assert.Contains(("c1", token, "yo@ejemplo.com"), f.Login.Tokens);
        // El campo es de sólo escritura: una vez guardado, la API nunca lo devuelve.
        Assert.DoesNotContain(token, await r.Content.ReadAsStringAsync(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task SinAccountDa400()
    {
        var r = await Cliente().PostAsJsonAsync(
            "/api/slots/c1/login/token", new { token = "sk-ant-oat01-xxxxxxxxxxxx" });
        Assert.Equal(HttpStatusCode.BadRequest, r.StatusCode);
    }

    [Fact]
    public async Task BorrarLaCuenta()
    {
        var r = await Cliente().DeleteAsync("/api/slots/c4/login");
        Assert.Equal(HttpStatusCode.OK, r.StatusCode);
        Assert.Contains("c4", f.Login.Borrados);
    }

    // --- forma del slot ---

    [Theory]
    [InlineData("c0")]
    [InlineData("C1")]
    [InlineData("c100")]
    public async Task RechazaSlotsInvalidosEnTodasLasRutas(string slot)
    {
        var c = Cliente();
        Assert.Equal(HttpStatusCode.NotFound, (await c.PostAsync($"/api/slots/{slot}/test", null)).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await c.PostAsync($"/api/slots/{slot}/login/start", null)).StatusCode);
        Assert.Equal(
            HttpStatusCode.NotFound,
            (await c.PostAsJsonAsync($"/api/slots/{slot}/login/code", new { code = "x" })).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await c.DeleteAsync($"/api/slots/{slot}/login")).StatusCode);
    }
}
