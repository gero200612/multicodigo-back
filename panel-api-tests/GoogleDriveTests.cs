using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using MultiCodigo.Panel;

namespace MultiCodigo.Panel.Tests;

/// <summary>
/// Drive en vivo, del lado del panel.
///
/// El panel es un pasamanos hacia el bridge y lo que se prueba es exactamente
/// eso: que el `usuarioId` salga del JWT y no del cuerpo, que el refresh token
/// no aparezca nunca, y que el motivo que escribió el bridge llegue tal cual.
///
/// Ver `multicodigo-vm/docs/superpowers/specs/2026-09-04-drive-en-vivo-design.md`.
/// </summary>
public class GoogleDriveTests(PanelFactory f) : IClassFixture<PanelFactory>
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

    /// <summary>El redirect que el front usó en el primer paso del OAuth.</summary>
    private const string Redirect = "http://localhost/configuracion/google";

    // --- estado ---

    [Fact]
    public async Task SinCuentaElEstadoLoDice()
    {
        f.Bridge.EmailDeGoogle = null;
        var res = await Cliente().GetAsync("/api/google/estado");

        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var cuerpo = await res.Content.ReadFromJsonAsync<EstadoRespuesta>();
        Assert.False(cuerpo!.Conectada);
        Assert.Null(cuerpo.Email);
    }

    [Fact]
    public async Task ConCuentaElEstadoDiceCual()
    {
        f.Bridge.EmailDeGoogle = "yo@ejemplo.com";
        var res = await Cliente().GetAsync("/api/google/estado");

        var cuerpo = await res.Content.ReadFromJsonAsync<EstadoRespuesta>();
        Assert.True(cuerpo!.Conectada);
        Assert.Equal("yo@ejemplo.com", cuerpo.Email);
    }

    [Fact]
    public async Task ElEstadoPideSesion()
    {
        var res = await Cliente(conSesion: false).GetAsync("/api/google/estado");
        Assert.Equal(HttpStatusCode.Unauthorized, res.StatusCode);
    }

    // --- conectar ---

    [Fact]
    public async Task ConectarCanjeaElCodigoYDevuelveLaCuenta()
    {
        f.Bridge.ConexionesDeGoogle.Clear();
        f.Bridge.ConectarFalla = null;

        var res = await Cliente().PostAsJsonAsync(
            "/api/google/conectar",
            new { code = "codigo-de-google", redirectUri = Redirect });

        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var conexion = Assert.Single(f.Bridge.ConexionesDeGoogle);
        // El usuarioId sale del JWT. Si viniera del cuerpo, cualquiera con
        // sesion conectaria una cuenta de Google a la cuenta de otro.
        Assert.Equal(AuthDePrueba.Usuario, conexion.UsuarioId);
        Assert.Equal("codigo-de-google", conexion.Code);
    }

    /// <summary>
    /// El refresh token es la credencial permanente de una cuenta personal. La
    /// regla del spec es que no sale por la API del panel, nunca — y este es el
    /// único endpoint por el que podría llegar a salir.
    /// </summary>
    [Fact]
    public async Task ElRefreshTokenNoSaleNuncaPorLaApi()
    {
        var res = await Cliente().PostAsJsonAsync(
            "/api/google/conectar",
            new { code = "codigo-de-google", redirectUri = Redirect });

        var texto = await res.Content.ReadAsStringAsync();
        Assert.DoesNotContain("refresh", texto, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("1//", texto, StringComparison.Ordinal);
    }

    /// <summary>
    /// Google exige que el redirect del canje sea idéntico al del primer paso, y
    /// quien lo eligió fue el front. Sin este chequeo, un pedido armado a mano
    /// canjearía el código contra un redirect ajeno.
    /// </summary>
    [Fact]
    public async Task UnRedirectDeOtroDominioSeRechaza()
    {
        f.Bridge.ConexionesDeGoogle.Clear();

        var res = await Cliente().PostAsJsonAsync(
            "/api/google/conectar",
            new { code = "codigo", redirectUri = "https://ajeno.example/callback" });

        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        // Y no llegó al bridge: rechazar después de canjear no serviría de nada.
        Assert.Empty(f.Bridge.ConexionesDeGoogle);
    }

    [Fact]
    public async Task SinCodigoNoSeLlamaAlBridge()
    {
        f.Bridge.ConexionesDeGoogle.Clear();

        var res = await Cliente().PostAsJsonAsync(
            "/api/google/conectar",
            new { code = "", redirectUri = Redirect });

        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        Assert.Empty(f.Bridge.ConexionesDeGoogle);
    }

    [Fact]
    public async Task ConectarPideSesion()
    {
        var res = await Cliente(conSesion: false).PostAsJsonAsync(
            "/api/google/conectar",
            new { code = "codigo", redirectUri = Redirect });

        Assert.Equal(HttpStatusCode.Unauthorized, res.StatusCode);
    }

    /// <summary>
    /// El mensaje del bridge está escrito para una persona ("Google no devolvió
    /// un permiso permanente"). Traducirlo a "el bridge respondió 502" le saca
    /// justo la parte que dice qué hacer.
    /// </summary>
    [Fact]
    public async Task ElMotivoDelBridgeLlegaTalCual()
    {
        f.Bridge.ConectarFalla = "Google no devolvio un permiso permanente";

        var res = await Cliente().PostAsJsonAsync(
            "/api/google/conectar",
            new { code = "codigo", redirectUri = Redirect });

        var texto = await res.Content.ReadAsStringAsync();
        Assert.Contains("permiso permanente", texto);

        f.Bridge.ConectarFalla = null;
    }

    // --- desconectar ---

    [Fact]
    public async Task DesconectarBorraLaCuenta()
    {
        f.Bridge.EmailDeGoogle = "yo@ejemplo.com";

        var res = await Cliente().DeleteAsync("/api/google/conectar");

        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.Null(f.Bridge.EmailDeGoogle);
    }

    /// <summary>
    /// 404 y no 200: contestar "listo" a algo que no se hizo haría creer que se
    /// desconectó una cuenta que en realidad nunca estuvo conectada.
    /// </summary>
    [Fact]
    public async Task DesconectarSinCuentaEs404()
    {
        f.Bridge.EmailDeGoogle = null;
        var res = await Cliente().DeleteAsync("/api/google/conectar");
        Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
    }

    // --- el link de pedir acceso ---

    [Fact]
    public async Task AutorizarQuemaElLinkYDiceQueArchivoEra()
    {
        f.Bridge.PedidosCanjeados.Clear();
        f.Bridge.LinkNoSirve = null;

        var res = await Cliente().PostAsJsonAsync(
            "/api/drive/autorizado",
            new { codigo = "el-codigo-del-link", id = "1bHla5" });

        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var canje = Assert.Single(f.Bridge.PedidosCanjeados);
        Assert.Equal("el-codigo-del-link", canje.Codigo);
        Assert.Equal("1bHla5", canje.Id);
        Assert.Contains("Balance 2026", await res.Content.ReadAsStringAsync());
    }

    /// <summary>
    /// "Ese link ya se usó" y "ese link venció" llevan a acciones distintas, así
    /// que el motivo del bridge se propaga en vez de aplanarse a "no anduvo".
    /// </summary>
    [Fact]
    public async Task UnLinkUsadoDiceQueEstaUsado()
    {
        f.Bridge.LinkNoSirve = "ese link ya se uso. Pedile al agente uno nuevo.";

        var res = await Cliente().PostAsJsonAsync(
            "/api/drive/autorizado",
            new { codigo = "viejo", id = "x" });

        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        Assert.Contains("ya se uso", await res.Content.ReadAsStringAsync());

        f.Bridge.LinkNoSirve = null;
    }

    [Fact]
    public async Task AutorizarPideSesion()
    {
        var res = await Cliente(conSesion: false).PostAsJsonAsync(
            "/api/drive/autorizado",
            new { codigo = "c", id = "x" });

        Assert.Equal(HttpStatusCode.Unauthorized, res.StatusCode);
    }

    private sealed record EstadoRespuesta(bool Conectada, string? Email);
}
