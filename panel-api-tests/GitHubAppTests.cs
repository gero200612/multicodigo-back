using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using MultiCodigo.Panel;

namespace MultiCodigo.Panel.Tests;

/// <summary>
/// El JWT con el que el panel se identifica ante GitHub para pedir tokens de
/// instalación.
///
/// Se testea la construcción y no la llamada HTTP: lo que puede salir mal acá es
/// el formato del JWT —que GitHub rechaza con un 401 que no explica cuál de las
/// cinco reglas se violó— y eso se puede verificar entero sin red.
/// </summary>
public class GitHubAppTests
{
    private const string AppId = "123456";

    private static (GitHubApp App, RSA Llave) Armar(Func<DateTimeOffset>? reloj = null)
    {
        var rsa = RSA.Create(2048);
        var pem = rsa.ExportPkcs8PrivateKeyPem();
        return (new GitHubApp(AppId, pem, reloj ?? (() => DateTimeOffset.UtcNow)), rsa);
    }

    private static (JsonElement Header, JsonElement Payload, byte[] Firma, string Firmado) Partir(string jwt)
    {
        var partes = jwt.Split('.');
        Assert.Equal(3, partes.Length);
        return (
            JsonDocument.Parse(DeBase64Url(partes[0])).RootElement.Clone(),
            JsonDocument.Parse(DeBase64Url(partes[1])).RootElement.Clone(),
            DeBase64Url(partes[2]),
            $"{partes[0]}.{partes[1]}");
    }

    private static byte[] DeBase64Url(string s)
    {
        var b64 = s.Replace('-', '+').Replace('_', '/');
        return Convert.FromBase64String(b64.PadRight(b64.Length + (4 - b64.Length % 4) % 4, '='));
    }

    [Fact]
    public void ElHeaderDiceRS256()
    {
        var (app, _) = Armar();
        var (header, _, _, _) = Partir(app.JwtDeLaApp());

        // GitHub sólo acepta RS256 para el JWT de la App.
        Assert.Equal("RS256", header.GetProperty("alg").GetString());
        Assert.Equal("JWT", header.GetProperty("typ").GetString());
    }

    [Fact]
    public void ElIssuerEsElAppId()
    {
        var (app, _) = Armar();
        var (_, payload, _, _) = Partir(app.JwtDeLaApp());

        Assert.Equal(AppId, payload.GetProperty("iss").GetString());
    }

    /// <summary>
    /// GitHub rechaza un JWT que dure más de 10 minutos, y también uno cuyo
    /// `iat` esté en el futuro por el reloj del servidor. Los 60 segundos para
    /// atrás son la recomendación de su propia documentación.
    /// </summary>
    [Fact]
    public void ElIatVaUnMinutoAtrasYElExpNoLlegaADiezMinutos()
    {
        var ahora = DateTimeOffset.FromUnixTimeSeconds(1_800_000_000);
        var (app, _) = Armar(() => ahora);
        var (_, payload, _, _) = Partir(app.JwtDeLaApp());

        var iat = payload.GetProperty("iat").GetInt64();
        var exp = payload.GetProperty("exp").GetInt64();

        Assert.Equal(ahora.ToUnixTimeSeconds() - 60, iat);
        Assert.True(exp - ahora.ToUnixTimeSeconds() <= 600, "no puede durar más de 10 minutos");
        Assert.True(exp > ahora.ToUnixTimeSeconds(), "tiene que estar vivo ahora");
    }

    /// <summary>
    /// El test que de verdad importa: que la firma sea válida con la clave
    /// pública. Un JWT bien formado pero mal firmado da el mismo 401 que uno mal
    /// formado, y sin esto no habría forma de distinguirlos sin llamar a GitHub.
    /// </summary>
    [Fact]
    public void LaFirmaVerificaConLaClavePublica()
    {
        var (app, llave) = Armar();
        var (_, _, firma, firmado) = Partir(app.JwtDeLaApp());

        var ok = llave.VerifyData(
            Encoding.ASCII.GetBytes(firmado), firma, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);

        Assert.True(ok, "la firma tiene que verificar con la clave de la App");
    }

    [Fact]
    public void NoLlevaPaddingNiCaracteresQueRompanUnaURL()
    {
        var (app, _) = Armar();
        var jwt = app.JwtDeLaApp();

        // base64url, no base64: un '+' o un '/' en un JWT lo hacen inválido.
        Assert.DoesNotContain('=', jwt);
        Assert.DoesNotContain('+', jwt);
        Assert.DoesNotContain('/', jwt);
    }

    /// <summary>
    /// La clave llega desde una variable de entorno, y ahí los saltos de línea
    /// del PEM se escriben como `\n` literales más de una vez de las que uno
    /// quisiera. Sin esto el panel no arranca y el error habla de ASN.1.
    /// </summary>
    [Fact]
    public void AceptaUnPemConLosSaltosEscapados()
    {
        var rsa = RSA.Create(2048);
        var pemEscapado = rsa.ExportPkcs8PrivateKeyPem().Replace("\n", "\\n");

        var app = new GitHubApp(AppId, pemEscapado, () => DateTimeOffset.UtcNow);

        var (_, _, firma, firmado) = Partir(app.JwtDeLaApp());
        Assert.True(rsa.VerifyData(
            Encoding.ASCII.GetBytes(firmado), firma, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1));
    }

    [Fact]
    public void SinClaveNoArranca()
    {
        // Fallar al construirlo y no en el primer push: un panel que levanta y
        // recién falla cuando alguien pushea esconde el problema hasta el peor
        // momento.
        Assert.ThrowsAny<Exception>(() => new GitHubApp(AppId, "no soy un PEM", () => DateTimeOffset.UtcNow));
    }
}

/// <summary>
/// Crear un repo en la organización.
///
/// Lo que se prueba es lo que decide si el repo nace bien o nace inservible: a
/// qué URL va, que salga PRIVADO, que traiga commit inicial, y que los errores
/// de GitHub lleguen como algo que una persona puede resolver.
///
/// Se testea con un handler falso porque la alternativa es crear repos de
/// verdad en una org de verdad, y esos no se pueden borrar con los permisos que
/// la App tiene.
/// </summary>
public class CrearRepoTests
{
    private const string AppId = "123456";

    /// <summary>Guarda lo que se pidió y contesta lo que se le diga.</summary>
    private sealed class HandlerFalso(
        System.Net.HttpStatusCode estado, string json) : HttpMessageHandler
    {
        public string? UltimaUrl { get; private set; }
        public string? UltimoCuerpo { get; private set; }
        public int Llamadas { get; private set; }

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request, CancellationToken ct)
        {
            Llamadas++;
            // El token de instalación se pide primero y no es lo que se está
            // probando: se contesta uno cualquiera y se sigue.
            if (request.RequestUri!.AbsolutePath.EndsWith("/access_tokens"))
            {
                return new HttpResponseMessage(System.Net.HttpStatusCode.Created)
                {
                    Content = new StringContent(
                        """{"token":"ghs_falso","expires_at":"2099-01-01T00:00:00Z"}""",
                        Encoding.UTF8, "application/json"),
                };
            }
            UltimaUrl = request.RequestUri.ToString();
            UltimoCuerpo = request.Content is null ? null : await request.Content.ReadAsStringAsync(ct);
            return new HttpResponseMessage(estado)
            {
                Content = new StringContent(json, Encoding.UTF8, "application/json"),
            };
        }
    }

    private static (GitHubApp App, HandlerFalso H, HttpClient C) Armar(
        System.Net.HttpStatusCode estado = System.Net.HttpStatusCode.Created,
        string json = """{"full_name":"Sincro-arg/stock","name":"stock","private":true}""")
    {
        var rsa = RSA.Create(2048);
        var app = new GitHubApp(AppId, rsa.ExportPkcs8PrivateKeyPem(), () => DateTimeOffset.UtcNow);
        var h = new HandlerFalso(estado, json);
        return (app, h, new HttpClient(h));
    }

    [Fact]
    public async Task VaALaRutaDeLaOrganizacion()
    {
        var (app, h, c) = Armar();
        await app.CrearRepoAsync(159882934, "Sincro-arg", "stock", null, c);

        // `/orgs/...` y no `/user/repos`: es la única de las dos que un token de
        // instalación puede usar.
        Assert.Equal("https://api.github.com/orgs/Sincro-arg/repos", h.UltimaUrl);
    }

    [Fact]
    public async Task NacePrivadoYConCommitInicial()
    {
        var (app, h, c) = Armar();
        await app.CrearRepoAsync(159882934, "Sincro-arg", "stock", "el sistema de stock", c);

        var cuerpo = JsonDocument.Parse(h.UltimoCuerpo!).RootElement;
        // Privado: lo que se puede deshacer con un click. Un repo público que
        // tenía que ser privado ya se indexó y se clonó.
        Assert.True(cuerpo.GetProperty("private").GetBoolean());
        // Con commit inicial: sin esto el repo nace sin ninguna rama, y un push
        // a `claude/c1/algo` lo deja sin rama por defecto para siempre.
        Assert.True(cuerpo.GetProperty("auto_init").GetBoolean());
        Assert.Equal("stock", cuerpo.GetProperty("name").GetString());
        Assert.Equal("el sistema de stock", cuerpo.GetProperty("description").GetString());
    }

    [Fact]
    public async Task DevuelveElNombreQueContestoGitHub()
    {
        var (app, _, c) = Armar();
        var r = await app.CrearRepoAsync(159882934, "Sincro-arg", "stock", null, c);

        // El full_name sale de GITHUB y no se arma acá: es lo que el gateway usa
        // para clonar, y GitHub puede normalizar el nombre que se le pidió.
        Assert.Equal("Sincro-arg/stock", r.FullName);
        Assert.Equal("stock", r.Nombre);
    }

    [Fact]
    public async Task UnNombreRepetidoSeDistingueDeLosDemasErrores()
    {
        var (app, _, c) = Armar(
            System.Net.HttpStatusCode.UnprocessableEntity,
            """{"message":"Repository creation failed."}""");

        var ex = await Assert.ThrowsAsync<UpstreamException>(
            () => app.CrearRepoAsync(159882934, "Sincro-arg", "stock", null, c));

        // Es el único error que la persona puede resolver sola, así que no puede
        // llegar como un `github_422` que manda a revisar permisos.
        Assert.Equal("repo_ya_existe", ex.Message);
    }

    [Fact]
    public async Task SinPermisoElErrorDiceElStatus()
    {
        var (app, _, c) = Armar(System.Net.HttpStatusCode.Forbidden, "{}");

        var ex = await Assert.ThrowsAsync<UpstreamException>(
            () => app.CrearRepoAsync(159882934, "Sincro-arg", "stock", null, c));
        Assert.Equal("github_403", ex.Message);
    }

    /// <summary>
    /// El token cacheado se tira después de crear.
    ///
    /// Con `repository_selection: selected`, un token firmado ANTES de que el
    /// repo existiera no lo alcanza: su lista quedó fija al emitirlo, y el push
    /// siguiente falla con un 404 que se lee como "el repo no existe".
    /// </summary>
    [Fact]
    public async Task ElTokenSeRenuevaDespuesDeCrear()
    {
        var (app, h, c) = Armar();
        await app.CrearRepoAsync(159882934, "Sincro-arg", "stock", null, c);
        var antes = h.Llamadas;

        // Un token pedido después tiene que volver a salir a la red.
        await app.TokenDeInstalacionAsync(159882934, c);
        Assert.True(h.Llamadas > antes, "el token se sirvió del caché viejo");
    }

    [Fact]
    public async Task UnaOrganizacionSeReconoce()
    {
        var (app, _, c) = Armar(
            System.Net.HttpStatusCode.OK,
            """{"account":{"login":"Sincro-arg","type":"Organization"}}""");
        Assert.True(await app.EsOrganizacionAsync(159882934, c));
    }

    [Fact]
    public async Task UnaCuentaPersonalNoEsOrganizacion()
    {
        var (app, _, c) = Armar(
            System.Net.HttpStatusCode.OK,
            """{"account":{"login":"gero200612","type":"User"}}""");
        // El caso real: `sincrosns` parece una org por el nombre y es un User.
        Assert.False(await app.EsOrganizacionAsync(159882934, c));
    }
}
