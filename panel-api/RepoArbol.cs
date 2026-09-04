using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;

namespace MultiCodigo.Panel;

/// <summary>Un archivo o una carpeta de un repo.</summary>
/// <param name="Ruta">La ruta completa desde la raíz, con barras.</param>
/// <param name="EsCarpeta">Para que la pantalla sepa qué se puede abrir.</param>
/// <param name="Bytes">0 en una carpeta: GitHub no le da tamaño.</param>
public sealed record EntradaDeRepo(string Ruta, bool EsCarpeta, long Bytes);

/// <summary>
/// Los archivos de un repo vinculado a un proyecto.
///
/// Se leen de la API de GitHub y NO del worktree, que sería lo más directo: el
/// worktree es efímero —se recrea por turno— y vive en la máquina de los
/// agentes, que el panel no monta. Además un proyecto puede no tener ningún
/// slot prendido, y ahí no hay worktree que mirar.
///
/// Sólo lectura. Escribir en un repo es trabajo del agente, con aprobación y
/// commit; un botón de guardar acá sería un camino que se saltea todo eso.
///
/// Ver el diseño en
/// <c>multicodigo-vm/docs/superpowers/specs/2026-09-04-documentos-generados-design.md</c>.
/// </summary>
public interface IRepoArbolClient
{
    /// <summary>
    /// Todo el árbol del repo, de una.
    /// </summary>
    /// <remarks>
    /// Recursivo y en un pedido en vez de uno por carpeta al abrirla: un repo
    /// mediano son cientos de archivos y unos pocos kB de JSON, y pedir carpeta
    /// por carpeta gasta el rate limit de la instalación en navegar.
    /// </remarks>
    Task<IReadOnlyList<EntradaDeRepo>> ArbolAsync(
        string jwt, string proyectoId, string fullName, CancellationToken ct = default);

    /// <summary>El contenido de un archivo, o null si no está o es muy grande.</summary>
    Task<byte[]?> ArchivoAsync(
        string jwt, string proyectoId, string fullName, string ruta,
        CancellationToken ct = default);
}

/// <remarks>
/// El token de instalación lo resuelve ESTE cliente y no quien lo llama. Es lo
/// que deja el endpoint fino —membresía, que el repo sea del proyecto, y
/// delegar— y lo que hace que se pueda testear sin firmar un JWT de GitHub ni
/// salir a la red.
/// </remarks>
public sealed class RepoArbolClient(
    HttpClient http,
    AppDeGitHub gh,
    IInstalacionesClient instalaciones,
    ILogger<RepoArbolClient> log) : IRepoArbolClient
{
    /// <summary>
    /// Cuántas entradas se devuelven como máximo.
    ///
    /// Un repo con más archivos que esto existe, y una lista de cinco mil en una
    /// pantalla no se puede usar. Se corta acá y la pantalla lo dice: es mejor
    /// que mandarle 4 MB de JSON al navegador para que muestre un scroll
    /// infinito.
    /// </summary>
    public const int MaximoEntradas = 2000;

    /// <summary>
    /// El tope de un archivo que se puede abrir: 2 MB.
    ///
    /// Es código y texto lo que se viene a leer acá. Más que eso es un binario o
    /// un dump, y este proceso hace de proxy: cada pedido se carga en su
    /// memoria.
    /// </summary>
    public const int MaximoBytesDeArchivo = 2 * 1024 * 1024;

    /// <summary>
    /// Las entradas de un árbol de GitHub, ya filtradas y ordenadas.
    /// </summary>
    /// <remarks>
    /// Aparte de la llamada HTTP a propósito: lo que puede salir mal acá es el
    /// filtrado y el orden, y eso se verifica entero sin red — el mismo criterio
    /// con el que se testea el JWT de <see cref="GitHubApp"/>.
    /// </remarks>
    public static IReadOnlyList<EntradaDeRepo> DeJson(JsonElement cuerpo)
    {
        if (!cuerpo.TryGetProperty("tree", out var arbol)) return [];

        var salida = new List<EntradaDeRepo>();
        foreach (var e in arbol.EnumerateArray())
        {
            var ruta = e.TryGetProperty("path", out var p) ? p.GetString() : null;
            var tipo = e.TryGetProperty("type", out var t) ? t.GetString() : null;
            if (ruta is null || tipo is null) continue;

            // `blob` y `tree` y nada más. Un `commit` es un submódulo: apunta a
            // otro repo, y mostrarlo como carpeta daría una carpeta que al
            // abrirla está vacía para siempre.
            if (tipo is not ("blob" or "tree")) continue;

            salida.Add(new EntradaDeRepo(
                ruta,
                tipo == "tree",
                e.TryGetProperty("size", out var s) && s.TryGetInt64(out var bytes) ? bytes : 0));
        }

        // Ordenado por ruta: GitHub los devuelve en orden de árbol, que mezcla
        // niveles y hace que la pantalla no pueda armar la jerarquía sin
        // reordenar igual.
        return [.. salida
            .OrderBy(x => x.Ruta, StringComparer.OrdinalIgnoreCase)
            .Take(MaximoEntradas)];
    }

    /// <summary>
    /// Si esta ruta se puede pedir.
    /// </summary>
    /// <remarks>
    /// La ruta viene del cliente y entra en una URL de la API de GitHub. GitHub
    /// probablemente la normalice, y este chequeo existe igual por lo mismo que
    /// <c>RutaSegura</c> en los documentos: no depender de que el otro lado lo
    /// haga bien. Sin barra al principio y sin ningún segmento <c>..</c>.
    /// </remarks>
    public static bool RutaValida(string? ruta) =>
        !string.IsNullOrWhiteSpace(ruta)
        && !ruta.StartsWith('/')
        && !ruta.Contains('\\')
        && !ruta.Split('/').Any(seg => seg is ".." or "." or "");

    private static HttpRequestMessage Pedido(HttpMethod metodo, string url, string token)
    {
        var req = new HttpRequestMessage(metodo, url);
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        req.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/vnd.github+json"));
        req.Headers.UserAgent.Add(new ProductInfoHeaderValue("multicodigo-panel", "1.0"));
        return req;
    }

    /// <summary>
    /// El token de instalación del proyecto.
    /// </summary>
    /// <remarks>
    /// Lanza en vez de devolver null: sin token no hay nada que mostrar, y el
    /// motivo —no hay App en este despliegue, o el proyecto no la instaló— es lo
    /// que la pantalla tiene que decir. Un árbol vacío se leería como "el repo
    /// no tiene archivos", que es falso.
    /// </remarks>
    private async Task<string> TokenAsync(string jwt, string proyectoId, CancellationToken ct)
    {
        if (gh.App is null) throw new UpstreamException("sin_app");
        var inst = await instalaciones.DeProyectoAsync(jwt, proyectoId, ct);
        if (inst is null) throw new UpstreamException("sin_instalacion");
        return await gh.App.TokenDeInstalacionAsync(
            inst.InstallationId, http, ct);
    }

    public async Task<IReadOnlyList<EntradaDeRepo>> ArbolAsync(
        string jwt, string proyectoId, string fullName, CancellationToken ct = default)
    {
        var token = await TokenAsync(jwt, proyectoId, ct);
        // `HEAD` y no `main`: no todos los repos usan esa rama, y pedir una que
        // no existe da un 404 que se lee como "el repo no está".
        using var pedido = Pedido(
            HttpMethod.Get,
            $"https://api.github.com/repos/{fullName}/git/trees/HEAD?recursive=1",
            token);

        using var res = await http.SendAsync(pedido, ct);
        if (!res.IsSuccessStatusCode)
        {
            log.LogWarning("github respondio {Codigo} al pedir el arbol de {Repo}",
                (int)res.StatusCode, fullName);
            throw new UpstreamException($"github_{(int)res.StatusCode}");
        }

        return DeJson(await res.Content.ReadFromJsonAsync<JsonElement>(ct));
    }

    public async Task<byte[]?> ArchivoAsync(
        string jwt, string proyectoId, string fullName, string ruta,
        CancellationToken ct = default)
    {
        if (!RutaValida(ruta)) return null;
        var token = await TokenAsync(jwt, proyectoId, ct);

        // `Accept: raw` para que GitHub devuelva los bytes y no un JSON con el
        // contenido en base64: así no hay que decodificar ni cargar una copia
        // 33% más grande en memoria.
        using var pedido = Pedido(
            HttpMethod.Get,
            $"https://api.github.com/repos/{fullName}/contents/{Uri.EscapeDataString(ruta).Replace("%2F", "/")}",
            token);
        pedido.Headers.Accept.Clear();
        pedido.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/vnd.github.raw"));
        pedido.Headers.UserAgent.Add(new ProductInfoHeaderValue("multicodigo-panel", "1.0"));

        using var res = await http.SendAsync(pedido, ct);
        if (res.StatusCode == HttpStatusCode.NotFound) return null;
        if (!res.IsSuccessStatusCode) throw new UpstreamException($"github_{(int)res.StatusCode}");

        // El tope se mira ANTES de leer: `Content-Length` viene en la respuesta,
        // así que un archivo de 300 MB se rechaza sin bajarlo.
        if (res.Content.Headers.ContentLength > MaximoBytesDeArchivo) return null;

        return await res.Content.ReadAsByteArrayAsync(ct);
    }
}
