using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace MultiCodigo.Panel;

/// <summary>El último commit de una rama, para mostrar sin clonar nada.</summary>
/// <param name="Sha">Corto, 7 caracteres.</param>
/// <param name="Mensaje">La primera línea, sin el resto del cuerpo.</param>
/// <param name="Fecha">ISO 8601, tal como la da GitHub.</param>
/// <param name="Url">El link al commit en github.com.</param>
public sealed record CommitDeRepo(string Sha, string Mensaje, string Fecha, string Url);

/// <summary>Cuánto se desvió una rama en curso respecto de la rama por defecto.</summary>
/// <param name="BehindBy">Commits que tiene la rama por defecto y no la rama: ESTO es el desfase.</param>
public sealed record RamaComparada(
    string Nombre, int AheadBy, int BehindBy, bool Desfasada, string CompareUrl);

/// <summary>Lo que pinta el tab "Versión" para un repo.</summary>
public sealed record VersionDeRepo(string DefaultBranch, CommitDeRepo Commit, RamaComparada? Rama);

/// <summary>
/// Si una rama en curso quedó atrasada respecto de la rama por defecto del
/// repo.
///
/// Se lee en vivo de GitHub: commit y comparación de ramas no se guardan en
/// ninguna tabla, igual que el árbol de <see cref="IRepoArbolClient"/> y por la
/// misma razón — es un estado de git que cambia con cada push ajeno al panel.
/// </summary>
public interface IVersionClient
{
    /// <summary>
    /// El commit de la rama por defecto y, si se pide <paramref name="rama"/>,
    /// cuánto se desvió esa rama de la por defecto.
    /// </summary>
    Task<VersionDeRepo> VersionAsync(
        string jwt, string proyectoId, string fullName, string? rama,
        CancellationToken ct = default);
}

/// <remarks>
/// Mismo patrón que <see cref="RepoArbolClient"/>: el token de instalación lo
/// resuelve este cliente, no quien lo llama.
/// </remarks>
public sealed class VersionClient(
    HttpClient http,
    AppDeGitHub gh,
    IInstalacionesClient instalaciones,
    ILogger<VersionClient> log) : IVersionClient
{
    /// <summary>El patrón de nombre de rama que acepta el contrato.</summary>
    public static bool RamaValida(string rama) =>
        Regex.IsMatch(rama, "^[A-Za-z0-9/_.-]{1,200}$");

    private static HttpRequestMessage Pedido(string url, string token)
    {
        var req = new HttpRequestMessage(HttpMethod.Get, url);
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        req.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/vnd.github+json"));
        req.Headers.UserAgent.Add(new ProductInfoHeaderValue("multicodigo-panel", "1.0"));
        return req;
    }

    /// <summary>Igual que en <see cref="RepoArbolClient"/>: lanza en vez de devolver null.</summary>
    private async Task<string> TokenAsync(string jwt, string proyectoId, CancellationToken ct)
    {
        if (gh.App is null) throw new UpstreamException("sin_app");
        var inst = await instalaciones.DeProyectoAsync(jwt, proyectoId, ct);
        if (inst is null) throw new UpstreamException("sin_instalacion");
        return await gh.App.TokenDeInstalacionAsync(inst.InstallationId, http, ct);
    }

    private async Task<JsonElement> GetJsonAsync(string url, string token, CancellationToken ct)
    {
        using var pedido = Pedido(url, token);
        using var res = await http.SendAsync(pedido, ct);
        if (!res.IsSuccessStatusCode)
        {
            log.LogWarning("github respondio {Codigo} al pedir {Url}", (int)res.StatusCode, url);
            throw new UpstreamException($"github_{(int)res.StatusCode}");
        }
        return await res.Content.ReadFromJsonAsync<JsonElement>(ct);
    }

    private static CommitDeRepo CommitDeJson(JsonElement cuerpo)
    {
        var sha = cuerpo.GetProperty("sha").GetString() ?? "";
        var mensajeCompleto = cuerpo.TryGetProperty("commit", out var c)
            && c.TryGetProperty("message", out var m) ? m.GetString() ?? "" : "";
        var fecha = cuerpo.TryGetProperty("commit", out var c2)
            && c2.TryGetProperty("author", out var a) && a.TryGetProperty("date", out var d)
            ? d.GetString() ?? ""
            : "";
        var url = cuerpo.TryGetProperty("html_url", out var u) ? u.GetString() ?? "" : "";
        return new CommitDeRepo(
            sha.Length > 7 ? sha[..7] : sha,
            // La primera línea: el cuerpo de un commit puede traer varias, y acá
            // sólo hace falta el título.
            mensajeCompleto.Split('\n')[0],
            fecha,
            url);
    }

    public async Task<VersionDeRepo> VersionAsync(
        string jwt, string proyectoId, string fullName, string? rama,
        CancellationToken ct = default)
    {
        var token = await TokenAsync(jwt, proyectoId, ct);

        var repoJson = await GetJsonAsync($"https://api.github.com/repos/{fullName}", token, ct);
        var defaultBranch = repoJson.TryGetProperty("default_branch", out var db)
            ? db.GetString() ?? "main"
            : "main";

        var commitJson = await GetJsonAsync(
            $"https://api.github.com/repos/{fullName}/commits/{defaultBranch}", token, ct);
        var commit = CommitDeJson(commitJson);

        if (string.IsNullOrEmpty(rama))
        {
            return new VersionDeRepo(defaultBranch, commit, null);
        }

        var compareJson = await GetJsonAsync(
            $"https://api.github.com/repos/{fullName}/compare/{defaultBranch}...{rama}", token, ct);
        var aheadBy = compareJson.TryGetProperty("ahead_by", out var ab) ? ab.GetInt32() : 0;
        var behindBy = compareJson.TryGetProperty("behind_by", out var bb) ? bb.GetInt32() : 0;
        var compareUrl = $"https://github.com/{fullName}/compare/{defaultBranch}...{rama}";

        return new VersionDeRepo(
            defaultBranch, commit,
            new RamaComparada(rama, aheadBy, behindBy, behindBy > 0, compareUrl));
    }
}
