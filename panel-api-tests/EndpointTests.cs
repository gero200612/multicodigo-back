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
    public const string Usuario = "11111111-1111-4111-8111-111111111111";

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

        // `sub` ademas de NameIdentifier: en produccion el JWT de Supabase lo
        // trae, `MapInboundClaims = false` lo deja con ese nombre, y los
        // endpoints que necesitan saber QUIEN es lo leen de ahi.
        var id = new ClaimsIdentity(
            [new Claim(ClaimTypes.NameIdentifier, "u1"), new Claim("sub", Usuario)],
            Esquema);
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
    public NombresFalso Nombres { get; } = new();
    public ProyectosFalso Proyectos { get; } = new();
    public AgentesFalso Agentes { get; } = new();

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
            s.AddSingleton<INombresClient>(Nombres);
            s.AddSingleton<IProyectosClient>(Proyectos);
            s.AddSingleton<IAgentesClient>(Agentes);

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
        var r = await Cliente().GetAsync("/api/slots/c1/login/start");
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
        Assert.Equal(HttpStatusCode.NotFound, (await c.GetAsync($"/api/slots/{slot}/login/start")).StatusCode);
        Assert.Equal(
            HttpStatusCode.NotFound,
            (await c.PostAsJsonAsync($"/api/slots/{slot}/login/code", new { code = "x" })).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await c.DeleteAsync($"/api/slots/{slot}/login")).StatusCode);
        Assert.Equal(
            HttpStatusCode.NotFound,
            (await c.PutAsJsonAsync($"/api/slots/{slot}/nombre", new { nombre = "x" })).StatusCode);
    }

    // --- nombres de slot ---

    [Fact]
    public async Task NombresPideSesion()
    {
        var r = await Cliente(conSesion: false).GetAsync("/api/slots/nombres");
        Assert.Equal(HttpStatusCode.Unauthorized, r.StatusCode);

        var p = await Cliente(conSesion: false).PutAsJsonAsync("/api/slots/c1/nombre", new { nombre = "x" });
        Assert.Equal(HttpStatusCode.Unauthorized, p.StatusCode);
    }

    [Fact]
    public async Task GuardaYDevuelveElNombre()
    {
        var c = Cliente();
        var r = await c.PutAsJsonAsync("/api/slots/c3/nombre", new { nombre = "Revisión mobile" });
        Assert.Equal(HttpStatusCode.OK, r.StatusCode);

        var mapa = await c.GetFromJsonAsync<Dictionary<string, string>>("/api/slots/nombres");
        Assert.Equal("Revisión mobile", mapa!["c3"]);
    }

    /// <summary>
    /// El panel no tiene credencial de escritura contra Supabase: escribe con el
    /// JWT del usuario para que decida RLS. Si esto dejara de pasar, el panel
    /// podría renombrar slots de cualquiera.
    /// </summary>
    [Fact]
    public async Task ReenviaElJwtDelUsuarioAlLeerNombres()
    {
        await Cliente().GetAsync("/api/slots/nombres");
        Assert.Contains(AuthDePrueba.TokenValido, f.Nombres.JwtsLeidos);
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public async Task RechazaNombreVacio(string nombre)
    {
        var r = await Cliente().PutAsJsonAsync("/api/slots/c1/nombre", new { nombre });
        Assert.Equal(HttpStatusCode.BadRequest, r.StatusCode);
    }

    [Fact]
    public async Task RechazaNombreDeMasDe60()
    {
        var r = await Cliente().PutAsJsonAsync("/api/slots/c1/nombre", new { nombre = new string('a', 61) });
        Assert.Equal(HttpStatusCode.BadRequest, r.StatusCode);

        var ok = await Cliente().PutAsJsonAsync("/api/slots/c1/nombre", new { nombre = new string('a', 60) });
        Assert.Equal(HttpStatusCode.OK, ok.StatusCode);
    }

    [Fact]
    public async Task RecortaLosEspaciosDelNombre()
    {
        await Cliente().PutAsJsonAsync("/api/slots/c2/nombre", new { nombre = "  Backend y APIs  " });
        Assert.Equal("Backend y APIs", f.Nombres.Guardados["c2"]);
    }

    /// <summary>
    /// Al revés que el historial: si el nombre no se guardó, el usuario tiene que
    /// enterarse. Un 200 acá le haría creer que quedó.
    /// </summary>
    [Fact]
    public async Task AvisaCuandoNoSePudoGuardarElNombre()
    {
        f.Nombres.Falla = true;
        try
        {
            var r = await Cliente().PutAsJsonAsync("/api/slots/c1/nombre", new { nombre = "Algo" });
            Assert.Equal(HttpStatusCode.ServiceUnavailable, r.StatusCode);
        }
        finally
        {
            f.Nombres.Falla = false;
        }
    }

    // --- crear agentes ---

    private const string ProyectoDePrueba = "22222222-2222-4222-8222-222222222222";
    private const string ProyectoAjeno = "00000000-0000-4000-8000-0000000000ff";

    private sealed record RespuestaSlot(string Slot);

    [Fact]
    public async Task Crear_agente_sin_sesion_da_401()
    {
        var r = await Cliente(conSesion: false)
            .PostAsync($"/api/proyectos/{ProyectoDePrueba}/agentes", null);
        Assert.Equal(HttpStatusCode.Unauthorized, r.StatusCode);
    }

    /// <summary>
    /// La membresía se valida en el panel: el gateway no sabe qué es un
    /// proyecto, así que si esto no chequea, no chequea nadie.
    /// </summary>
    [Fact]
    public async Task Crear_agente_en_un_proyecto_ajeno_da_403()
    {
        var r = await Cliente().PostAsync($"/api/proyectos/{ProyectoAjeno}/agentes", null);

        Assert.Equal(HttpStatusCode.Forbidden, r.StatusCode);
        // Y no llego a pedirle nada al gateway: un proyecto ajeno no gasta un slot.
        Assert.DoesNotContain("ajeno", f.Gateway.SlotsCreados);
    }

    [Fact]
    public async Task Crear_agente_devuelve_el_slot_asignado()
    {
        f.Proyectos.Mios[ProyectoDePrueba] = "demo";
        f.Gateway.SlotQueDevuelve = "c1";

        var r = await Cliente().PostAsync($"/api/proyectos/{ProyectoDePrueba}/agentes", null);

        Assert.Equal(HttpStatusCode.Created, r.StatusCode);
        var cuerpo = await r.Content.ReadFromJsonAsync<RespuestaSlot>();
        Assert.Equal("c1", cuerpo!.Slot);
        // Al gateway le va el NOMBRE del proyecto, no el id: es lo que termina
        // en la etiqueta del contenedor y en la ruta del worktree.
        Assert.Contains("demo", f.Gateway.SlotsCreados);
        Assert.Contains(f.Agentes.Registrados, a => a.ProyectoId == ProyectoDePrueba && a.Slot == "c1");
    }

    /// <summary>
    /// "No quedan slots" no es una caída: el usuario tiene que poder
    /// distinguirlo de un gateway que no contesta.
    /// </summary>
    [Fact]
    public async Task Crear_agente_sin_slots_libres_da_409()
    {
        f.Proyectos.Mios[ProyectoDePrueba] = "demo";
        f.Gateway.SinSlots = true;
        try
        {
            var r = await Cliente().PostAsync($"/api/proyectos/{ProyectoDePrueba}/agentes", null);
            Assert.Equal(HttpStatusCode.Conflict, r.StatusCode);
        }
        finally
        {
            f.Gateway.SinSlots = false;
        }
    }

    // --- proyectos e invitaciones ---

    private sealed record RespuestaProyecto(string Id, string Nombre);
    private sealed record RespuestaToken(string Token);

    [Fact]
    public async Task Crear_proyecto_devuelve_el_id()
    {
        var r = await Cliente().PostAsJsonAsync("/api/proyectos", new { nombre = "nuevo" });

        Assert.Equal(HttpStatusCode.Created, r.StatusCode);
        var cuerpo = await r.Content.ReadFromJsonAsync<RespuestaProyecto>();
        Assert.Equal("nuevo", cuerpo!.Nombre);
        // Y se creo a nombre del usuario de la sesion: el JWT que llega a la
        // base es el suyo, y la funcion lo usa para dejarlo como dueño.
        Assert.Contains(f.Proyectos.Creados, c => c.Nombre == "nuevo" && c.Jwt == AuthDePrueba.TokenValido);
    }

    /// <summary>
    /// El nombre termina en /srv/work/&lt;agente&gt;/&lt;proyecto&gt;: una barra lo
    /// sacaría del directorio.
    /// </summary>
    [Fact]
    public async Task Crear_proyecto_rechaza_un_nombre_con_barra()
    {
        var r = await Cliente().PostAsJsonAsync("/api/proyectos", new { nombre = "con/barra" });

        Assert.Equal(HttpStatusCode.BadRequest, r.StatusCode);
        Assert.DoesNotContain(f.Proyectos.Creados, c => c.Nombre.Contains('/'));
    }

    [Fact]
    public async Task Crear_proyecto_sin_sesion_da_401()
    {
        var r = await Cliente(conSesion: false).PostAsJsonAsync("/api/proyectos", new { nombre = "nuevo" });
        Assert.Equal(HttpStatusCode.Unauthorized, r.StatusCode);
    }

    /// <summary>
    /// Con rol 'miembro', invitar da 403: si no, cualquiera suma gente al
    /// proyecto de otro.
    /// </summary>
    [Fact]
    public async Task Invitar_requiere_ser_dueño()
    {
        f.Proyectos.Roles[ProyectoDePrueba] = "miembro";
        try
        {
            var r = await Cliente().PostAsJsonAsync(
                $"/api/proyectos/{ProyectoDePrueba}/invitaciones",
                new { email = "alguien@ejemplo.test", rol = "miembro" });

            Assert.Equal(HttpStatusCode.Forbidden, r.StatusCode);
            Assert.Empty(f.Proyectos.Invitados);
        }
        finally
        {
            f.Proyectos.Roles.Remove(ProyectoDePrueba);
        }
    }

    [Fact]
    public async Task Invitar_como_dueño_devuelve_el_token()
    {
        f.Proyectos.Roles[ProyectoDePrueba] = "dueño";
        try
        {
            var r = await Cliente().PostAsJsonAsync(
                $"/api/proyectos/{ProyectoDePrueba}/invitaciones",
                new { email = "alguien@ejemplo.test", rol = "miembro" });

            Assert.Equal(HttpStatusCode.OK, r.StatusCode);
            var cuerpo = await r.Content.ReadFromJsonAsync<RespuestaToken>();
            Assert.False(string.IsNullOrEmpty(cuerpo!.Token));
        }
        finally
        {
            f.Proyectos.Roles.Remove(ProyectoDePrueba);
            f.Proyectos.Invitados.Clear();
        }
    }

    [Fact]
    public async Task Invitar_con_un_rol_que_no_existe_da_400()
    {
        f.Proyectos.Roles[ProyectoDePrueba] = "dueño";
        try
        {
            var r = await Cliente().PostAsJsonAsync(
                $"/api/proyectos/{ProyectoDePrueba}/invitaciones",
                new { email = "alguien@ejemplo.test", rol = "administrador" });

            Assert.Equal(HttpStatusCode.BadRequest, r.StatusCode);
        }
        finally
        {
            f.Proyectos.Roles.Remove(ProyectoDePrueba);
        }
    }

    /// <summary>
    /// Vencida, usada o inexistente se contestan igual: distinguirlas le diría
    /// a alguien con un token al azar si existe o no.
    /// </summary>
    [Fact]
    public async Task Aceptar_una_invitacion_que_no_sirve_da_400()
    {
        f.Proyectos.InvitacionNoSirve = true;
        try
        {
            var r = await Cliente().PostAsync("/api/invitaciones/lo-que-sea/aceptar", null);
            Assert.Equal(HttpStatusCode.BadRequest, r.StatusCode);
        }
        finally
        {
            f.Proyectos.InvitacionNoSirve = false;
        }
    }

    [Fact]
    public async Task Aceptar_una_invitacion_valida_devuelve_el_proyecto()
    {
        var r = await Cliente().PostAsync("/api/invitaciones/un-token/aceptar", null);

        Assert.Equal(HttpStatusCode.OK, r.StatusCode);
        Assert.Contains("un-token", f.Proyectos.Aceptados);
    }
}
