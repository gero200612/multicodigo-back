using System.Collections.Concurrent;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace MultiCodigo.Panel;

/// <summary>
/// La GitHub App del sistema.
///
/// Reemplaza a la deploy key por repo pegada a mano. El usuario instala la App
/// una vez y elige los repos; el panel firma un token de instalación por turno y
/// se lo manda al gateway, que lo usa para el clone, el fetch y el push, y lo
/// olvida.
///
/// Lo que eso compra: <b>en la VM no queda ninguna credencial de GitHub</b>. Ni
/// deploy key ni token en disco. El token vence en una hora y está acotado a los
/// repos que el usuario marcó.
///
/// Son dos credenciales distintas y conviene no confundirlas:
///
/// <list type="bullet">
/// <item>El <b>JWT de la App</b> (este archivo, <see cref="JwtDeLaApp"/>): firmado
/// con la clave privada, dura 10 minutos, y sólo sirve para hablar de la App en
/// sí. No da acceso a ningún repo.</item>
/// <item>El <b>token de instalación</b> (<see cref="TokenDeInstalacionAsync"/>):
/// se pide con el JWT, dura una hora, y es el que puede tocar repos. Es el único
/// que sale de este servicio.</item>
/// </list>
///
/// La clave privada nunca sale de acá: no se loguea, no viaja en ninguna
/// respuesta y no llega al gateway. Si se filtra, no alcanza con rotar un token
/// — hay que regenerarla en GitHub.
/// </summary>
public sealed class GitHubApp
{
    private readonly string _appId;
    private readonly RSA _llave;
    private readonly Func<DateTimeOffset> _ahora;

    /// <summary>
    /// Los tokens vivos, por instalación.
    ///
    /// Cachear no es una optimización de lujo: sin esto, cada turno pide un token
    /// nuevo y GitHub limita esa llamada. Con varios agentes trabajando a la vez
    /// el rate limit llega antes de lo que uno esperaría.
    /// </summary>
    private readonly ConcurrentDictionary<long, (string Token, DateTimeOffset Vence)> _cache = new();

    public GitHubApp(string appId, string clavePrivadaPem, Func<DateTimeOffset> ahora)
    {
        _appId = appId;
        _ahora = ahora;
        _llave = RSA.Create();
        // Los `\n` escapados: la clave llega por una variable de entorno, y ahí el
        // PEM viene con los saltos escritos como dos caracteres más veces de las
        // que uno quisiera. Sin esto el panel no arranca y el error habla de
        // ASN.1, que no manda a mirar la variable.
        _llave.ImportFromPem(clavePrivadaPem.Replace("\\n", "\n"));
    }

    /// <summary>
    /// El JWT con el que el panel se identifica ante GitHub como la App.
    ///
    /// Público sólo para poder testear su forma sin llamar a GitHub: un JWT mal
    /// armado da un 401 que no dice cuál de las cinco reglas se violó.
    /// </summary>
    public string JwtDeLaApp()
    {
        var ahora = _ahora().ToUnixTimeSeconds();
        // `iat` un minuto atrás, que es lo que recomienda la documentación de
        // GitHub: si el reloj de esta máquina adelanta unos segundos respecto del
        // de ellos, un `iat` en el futuro invalida el token entero.
        var header = """{"alg":"RS256","typ":"JWT"}""";
        var payload = $$"""{"iat":{{ahora - 60}},"exp":{{ahora + 540}},"iss":"{{_appId}}"}""";

        var firmado = $"{Base64Url(Encoding.UTF8.GetBytes(header))}.{Base64Url(Encoding.UTF8.GetBytes(payload))}";
        var firma = _llave.SignData(
            Encoding.ASCII.GetBytes(firmado), HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);

        return $"{firmado}.{Base64Url(firma)}";
    }

    /// <summary>
    /// El token de instalación, del caché si sigue vivo.
    ///
    /// Se renueva cinco minutos antes de vencer y no al vencer: un turno puede
    /// durar diez minutos, y un token que expira en el medio deja el push
    /// fallando después de que el agente ya escribió el código.
    /// </summary>
    public async Task<string> TokenDeInstalacionAsync(
        long installationId, HttpClient http, CancellationToken ct = default)
    {
        if (_cache.TryGetValue(installationId, out var vivo) && vivo.Vence > _ahora().AddMinutes(5))
        {
            return vivo.Token;
        }

        using var pedido = new HttpRequestMessage(
            HttpMethod.Post, $"https://api.github.com/app/installations/{installationId}/access_tokens");
        pedido.Headers.Authorization = new AuthenticationHeaderValue("Bearer", JwtDeLaApp());
        pedido.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/vnd.github+json"));
        // GitHub rechaza los pedidos sin User-Agent con un 403 que no explica nada.
        pedido.Headers.UserAgent.Add(new ProductInfoHeaderValue("multicodigo-panel", "1.0"));

        using var res = await http.SendAsync(pedido, ct);
        if (!res.IsSuccessStatusCode)
        {
            // Sin el cuerpo de la respuesta: puede traer detalles de la App, y
            // este mensaje termina en los logs y en la pantalla del usuario. El
            // status alcanza para saber qué pasó (401 = clave o App id mal, 404 =
            // la instalación ya no existe).
            throw new UpstreamException($"github_{(int)res.StatusCode}");
        }

        var cuerpo = await res.Content.ReadFromJsonAsync<JsonElement>(ct);
        var token = cuerpo.GetProperty("token").GetString()
                    ?? throw new UpstreamException("github_sin_token");
        var vence = cuerpo.TryGetProperty("expires_at", out var e) && e.GetDateTimeOffset() is var v
            ? v
            : _ahora().AddHours(1);

        _cache[installationId] = (token, vence);
        return token;
    }

    /// <summary>
    /// De quién es una instalación, según GitHub.
    ///
    /// Se le pregunta a GitHub en vez de creerle al cliente: este valor se
    /// muestra como "instalada en X", y un dato que llega del navegador puede
    /// decir cualquier cosa. Además sirve de verificación — sólo la App puede
    /// consultar sus propias instalaciones.
    /// </summary>
    public async Task<string> CuentaDeInstalacionAsync(
        long installationId, HttpClient http, CancellationToken ct = default)
    {
        using var pedido = new HttpRequestMessage(
            HttpMethod.Get, $"https://api.github.com/app/installations/{installationId}");
        pedido.Headers.Authorization = new AuthenticationHeaderValue("Bearer", JwtDeLaApp());
        pedido.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/vnd.github+json"));
        pedido.Headers.UserAgent.Add(new ProductInfoHeaderValue("multicodigo-panel", "1.0"));

        using var res = await http.SendAsync(pedido, ct);
        if (!res.IsSuccessStatusCode) throw new UpstreamException($"github_{(int)res.StatusCode}");

        var cuerpo = await res.Content.ReadFromJsonAsync<JsonElement>(ct);
        return cuerpo.TryGetProperty("account", out var cuenta)
               && cuenta.TryGetProperty("login", out var login)
               && login.GetString() is { } nombre
            ? nombre
            // Sin romper: el nombre es para mostrar, y una instalación válida sin
            // login legible es raro pero no es motivo para rechazarla.
            : "(desconocida)";
    }

    /// <summary>
    /// Los repos a los que la instalación tiene acceso.
    ///
    /// Es lo que el usuario marcó al instalar la App, y lo que el panel le ofrece
    /// para vincular. Sin esto el único camino es tipear `owner/nombre` a mano —
    /// que es exactamente el paso que la App venía a eliminar.
    ///
    /// Devuelve el `full_name` (owner/nombre) y el nombre corto, que es el que
    /// termina siendo la carpeta del worktree.
    /// </summary>
    public async Task<IReadOnlyList<RepoDeGitHub>> ReposDeInstalacionAsync(
        long installationId, HttpClient http, CancellationToken ct = default)
    {
        var token = await TokenDeInstalacionAsync(installationId, http, ct);

        // 100 por página: una instalación con más repos que eso es posible, pero
        // una lista de 100 checkboxes ya no se puede usar. Paginar sería resolver
        // un problema de usabilidad con más scroll.
        using var pedido = new HttpRequestMessage(
            HttpMethod.Get, "https://api.github.com/installation/repositories?per_page=100");
        pedido.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        pedido.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/vnd.github+json"));
        pedido.Headers.UserAgent.Add(new ProductInfoHeaderValue("multicodigo-panel", "1.0"));

        using var res = await http.SendAsync(pedido, ct);
        if (!res.IsSuccessStatusCode) throw new UpstreamException($"github_{(int)res.StatusCode}");

        var cuerpo = await res.Content.ReadFromJsonAsync<JsonElement>(ct);
        if (!cuerpo.TryGetProperty("repositories", out var lista)) return [];

        var salida = new List<RepoDeGitHub>();
        foreach (var r in lista.EnumerateArray())
        {
            var full = r.TryGetProperty("full_name", out var f) ? f.GetString() : null;
            var nombre = r.TryGetProperty("name", out var n) ? n.GetString() : null;
            if (full is null || nombre is null) continue;
            salida.Add(new RepoDeGitHub(
                full,
                nombre,
                r.TryGetProperty("private", out var pv) && pv.GetBoolean()));
        }
        // Ordenados: GitHub los devuelve por fecha de push y la lista se
        // reordena sola entre recargas, que es desconcertante en una pantalla
        // donde vas tildando cosas.
        return [.. salida.OrderBy(x => x.FullName, StringComparer.OrdinalIgnoreCase)];
    }

    /// <summary>Olvida el token de una instalación. Para cuando GitHub contesta 401.</summary>
    public void Olvidar(long installationId) => _cache.TryRemove(installationId, out _);

    /// <summary>
    /// base64url y no base64: un '+', un '/' o un '=' hacen inválido un JWT.
    /// </summary>
    private static string Base64Url(byte[] bytes) =>
        Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
}

/// <summary>
/// Un repo al que la instalación tiene acceso.
///
/// `Nombre` es el corto, que es el que termina siendo la carpeta del worktree;
/// `FullName` es `owner/nombre`, que es de donde el gateway arma la URL.
/// </summary>
public sealed record RepoDeGitHub(string FullName, string Nombre, bool Privado);

/// <summary>
/// La App configurada, o la ausencia de App.
///
/// Envuelve a <see cref="GitHubApp"/> porque el contenedor de dependencias no
/// acepta un servicio nulo, y porque "no hay App configurada" es un estado
/// NORMAL de este sistema y no un error: sin ella los turnos van por SSH con la
/// deploy key, que es el camino de `demo` y del smoke test.
///
/// El <paramref name="Slug"/> es el nombre de la App en su URL
/// (github.com/apps/&lt;slug&gt;), lo unico que hace falta para mandar al usuario a
/// instalarla.
/// </summary>
public sealed record AppDeGitHub(GitHubApp? App, string? Slug)
{
    public bool EstaConfigurada => App is not null && !string.IsNullOrWhiteSpace(Slug);
}

