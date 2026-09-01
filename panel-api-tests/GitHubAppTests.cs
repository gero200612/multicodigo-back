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
