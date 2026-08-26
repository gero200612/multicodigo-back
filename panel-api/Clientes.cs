using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace MultiCodigo.Panel;

/// <summary>
/// Las tres fuentes que el panel agrega. Son interfaces para poder testear el
/// servidor entero sin levantar el gateway, el servicio de login ni Supabase.
/// </summary>
public interface IGatewayClient
{
    Task<IReadOnlyList<Agente>> AgentesAsync(CancellationToken ct = default);
    Task<Cola> ColaAsync(CancellationToken ct = default);
    Task<ResultadoTest> ProbarAsync(string slot, CancellationToken ct = default);
}

public interface ILoginClient
{
    Task<EstadoCredencial> EstadoAsync(string slot, CancellationToken ct = default);
    Task<string> IniciarAsync(string slot, CancellationToken ct = default);
    Task CodigoAsync(string slot, string code, CancellationToken ct = default);
    Task TokenAsync(string slot, string token, string account, CancellationToken ct = default);
    Task BorrarAsync(string slot, CancellationToken ct = default);
}

public interface IBridgeClient
{
    Task<IReadOnlyList<JobResumen>> JobsAsync(int limite, CancellationToken ct = default);
}

public interface IHistorialClient
{
    /// <summary>Nunca lanza: sin historial el panel muestra "sin probar", que es cierto.</summary>
    Task<ResultadoTest?> UltimoAsync(string jwt, string slot, CancellationToken ct = default);

    /// <summary>
    /// Nunca lanza. El resultado del test ya se le mostró al usuario, y perder
    /// el registro no puede convertir un test exitoso en un error en pantalla.
    /// </summary>
    Task GuardarAsync(string jwt, string slot, ResultadoTest r, CancellationToken ct = default);
}

/// <summary>Lo que el llamador puede leer: nunca la excepción cruda.</summary>
public sealed class UpstreamException(string mensaje) : Exception(mensaje);

internal static class Json
{
    public static readonly JsonSerializerOptions Opciones = new(JsonSerializerDefaults.Web);
}

// --- gateway --------------------------------------------------------------

public sealed class GatewayClient(HttpClient http, string proyecto) : IGatewayClient
{
    private sealed record RespuestaAgentes(List<AgenteDto> Agents);
    private sealed record AgenteDto(string Id, bool Arriba);
    private sealed record RespuestaPrompt(string Text);

    public async Task<IReadOnlyList<Agente>> AgentesAsync(CancellationToken ct = default)
    {
        var r = await http.GetFromJsonAsync<RespuestaAgentes>("/agents", Json.Opciones, ct)
                ?? throw new UpstreamException("el gateway devolvió una respuesta vacía");
        return [.. r.Agents.Select(a => new Agente(a.Id, a.Arriba))];
    }

    public async Task<Cola> ColaAsync(CancellationToken ct = default)
        => await http.GetFromJsonAsync<Cola>("/queue", Json.Opciones, ct) ?? Cola.Vacia;

    /// <summary>
    /// Un turno trivial contra el agente.
    ///
    /// Es el mismo código que el health check diario del paso 8 del despliegue,
    /// que pasa a ser un cron llamando a este endpoint en vez de un script
    /// suelto. Un solo camino, testeado una vez.
    /// </summary>
    public async Task<ResultadoTest> ProbarAsync(string slot, CancellationToken ct = default)
    {
        var cuando = DateTimeOffset.UtcNow.ToString("O");
        try
        {
            var res = await http.PostAsJsonAsync(
                $"/agents/{slot}/prompt",
                new
                {
                    jobId = Guid.NewGuid().ToString(),
                    agent = slot,
                    project = proyecto,
                    prompt = "Contesta unicamente la palabra ok.",
                },
                Json.Opciones,
                ct);

            if (!res.IsSuccessStatusCode)
            {
                return new ResultadoTest(false, cuando, $"el agente respondió {(int)res.StatusCode}");
            }

            var cuerpo = await res.Content.ReadFromJsonAsync<RespuestaPrompt>(Json.Opciones, ct);
            var texto = cuerpo?.Text ?? "";
            return new ResultadoTest(true, cuando, texto[..Math.Min(200, texto.Length)]);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
        {
            // Un test que falla NO es un error del endpoint: el endpoint
            // funcionó y la respuesta es "este slot no anda".
            return new ResultadoTest(false, cuando, ex.Message);
        }
    }
}

// --- servicio de login ----------------------------------------------------

public sealed class LoginClient(HttpClient http) : ILoginClient
{
    private sealed record RespuestaEstado(bool Tiene, string? Account, string? LoadedAt, bool LoginAbierto);
    private sealed record RespuestaInicio(string Url);
    private sealed record ErrorUpstream(string? Code, string? Message);

    public async Task<EstadoCredencial> EstadoAsync(string slot, CancellationToken ct = default)
    {
        var r = await http.GetFromJsonAsync<RespuestaEstado>($"/login/{slot}/status", Json.Opciones, ct);
        return r is null
            ? new EstadoCredencial(false)
            : new EstadoCredencial(r.Tiene, r.Account, r.LoadedAt, r.LoginAbierto);
    }

    public async Task<string> IniciarAsync(string slot, CancellationToken ct = default)
    {
        var res = await http.PostAsync($"/login/{slot}/start", null, ct);
        await LanzarSiFallo(res, ct);
        var cuerpo = await res.Content.ReadFromJsonAsync<RespuestaInicio>(Json.Opciones, ct);
        return cuerpo?.Url ?? throw new UpstreamException("el login no devolvió ninguna URL");
    }

    public async Task CodigoAsync(string slot, string code, CancellationToken ct = default)
        => await LanzarSiFallo(
            await http.PostAsJsonAsync($"/login/{slot}/code", new { code }, Json.Opciones, ct), ct);

    public async Task TokenAsync(string slot, string token, string account, CancellationToken ct = default)
        => await LanzarSiFallo(
            await http.PostAsJsonAsync($"/login/{slot}/token", new { token, account }, Json.Opciones, ct), ct);

    public async Task BorrarAsync(string slot, CancellationToken ct = default)
        => await LanzarSiFallo(await http.DeleteAsync($"/login/{slot}", ct), ct);

    /// <summary>
    /// El servicio de login manda un mensaje pensado para leer. Se propaga ese
    /// y no el status crudo: "el código no sirvió" le dice al usuario qué hacer,
    /// "400" no.
    /// </summary>
    private static async Task LanzarSiFallo(HttpResponseMessage res, CancellationToken ct)
    {
        if (res.IsSuccessStatusCode) return;
        ErrorUpstream? e = null;
        try { e = await res.Content.ReadFromJsonAsync<ErrorUpstream>(Json.Opciones, ct); }
        catch (JsonException) { /* sin cuerpo util; se usa el status */ }
        throw new UpstreamException(e?.Message ?? $"el servicio de login respondió {(int)res.StatusCode}");
    }
}

// --- bridge ---------------------------------------------------------------

public sealed class BridgeClient(HttpClient http) : IBridgeClient
{
    private sealed record RespuestaJobs(List<JobDto> Jobs);
    private sealed record JobDto(
        string Id, string Agent, string Project, string Prompt,
        string Status, string CreatedAt, string? Error);

    public async Task<IReadOnlyList<JobResumen>> JobsAsync(int limite, CancellationToken ct = default)
    {
        var r = await http.GetFromJsonAsync<RespuestaJobs>($"/jobs?limit={limite}", Json.Opciones, ct);
        return r is null
            ? []
            : [.. r.Jobs.Select(j => new JobResumen(
                j.Id, j.Agent, j.Project, j.Prompt, j.Status, j.CreatedAt, j.Error))];
    }
}

// --- historial en Supabase ------------------------------------------------

/// <summary>
/// El historial de tests.
///
/// Sobre la credencial que NO se usa: lo directo era darle al panel la
/// service_role key, que pasa por arriba de RLS. No se hace. Esa clave además de
/// dar acceso total a la base administra auth —crear usuarios, leer auth.users— y
/// el panel es el único servicio expuesto a internet.
///
/// En su lugar se reenvía el JWT del usuario que el panel ya verificó, junto con
/// la clave anon (que identifica al proyecto, no a nadie), y RLS decide. Lo que
/// el panel puede hacer en la base es exactamente lo que puede hacer el usuario
/// logueado.
/// </summary>
public sealed class HistorialClient(HttpClient http, string anonKey, ILogger<HistorialClient> log)
    : IHistorialClient
{
    private sealed record Fila(bool Ok, string Cuando, string? Detalle);

    private HttpRequestMessage Pedido(HttpMethod metodo, string url, string jwt)
    {
        var req = new HttpRequestMessage(metodo, url);
        req.Headers.TryAddWithoutValidation("apikey", anonKey);
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", jwt);
        return req;
    }

    public async Task<ResultadoTest?> UltimoAsync(string jwt, string slot, CancellationToken ct = default)
    {
        // El slot entra en un filtro de la query. Se valida acá porque ésta es
        // la función que lo pega en la URL, aunque arriba ya se haya validado.
        if (!Slot.EsValido(slot)) return null;

        // Orden y límite explícitos: sin esto PostgREST devuelve la tabla entera
        // y el "último" saldría de un orden que nadie garantizó.
        var url = $"/rest/v1/test_runs?slot=eq.{slot}&select=ok,cuando,detalle&order=cuando.desc&limit=1";
        try
        {
            var res = await http.SendAsync(Pedido(HttpMethod.Get, url, jwt), ct);
            if (!res.IsSuccessStatusCode) return null;
            var filas = await res.Content.ReadFromJsonAsync<List<Fila>>(Json.Opciones, ct);
            var f = filas?.FirstOrDefault();
            return f is null ? null : new ResultadoTest(f.Ok, f.Cuando, f.Detalle);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException)
        {
            log.LogError(ex, "no se pudo leer el historial de {Slot}", slot);
            return null;
        }
    }

    public async Task GuardarAsync(string jwt, string slot, ResultadoTest r, CancellationToken ct = default)
    {
        if (!Slot.EsValido(slot)) return;
        try
        {
            var req = Pedido(HttpMethod.Post, "/rest/v1/test_runs", jwt);
            req.Content = JsonContent.Create(
                new { slot, ok = r.Ok, cuando = r.Cuando, detalle = r.Detalle }, options: Json.Opciones);
            var res = await http.SendAsync(req, ct);
            if (!res.IsSuccessStatusCode)
            {
                log.LogError("no se pudo guardar el test de {Slot}: {Status}", slot, (int)res.StatusCode);
            }
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
        {
            log.LogError(ex, "no se pudo guardar el test de {Slot}", slot);
        }
    }
}
