using System.Net;
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
    Task<string> CrearSlotAsync(string proyecto, CancellationToken ct = default);
}

/// <summary>
/// Los proyectos del usuario, en Supabase.
///
/// Igual que el historial y los nombres: se reenvía el JWT del usuario y decide
/// RLS. Eso es lo que convierte "¿es miembro de este proyecto?" en una pregunta
/// que no hace falta programar — un proyecto del que no sos miembro sencillamente
/// no aparece.
/// </summary>
public interface IProyectosClient
{
    /// <summary>El nombre del proyecto, o null si el usuario no es miembro.</summary>
    Task<string?> NombreSiEsMiembroAsync(string jwt, string proyectoId, CancellationToken ct = default);
}

public interface IAgentesClient
{
    Task RegistrarAsync(string jwt, string proyectoId, string slot, CancellationToken ct = default);
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
    /// <summary>
    /// Canjea un codigo de vinculacion a nombre del usuario. Lo llamamos desde
    /// el endpoint POST /api/telegram/vincular que le expone el panel al front.
    ///
    /// Devuelve 'ok' o lanza UpstreamException con el codigo de error (vencido,
    /// usado o desconocido).
    /// </summary>
    Task CanjearVinculoAsync(string codigo, string usuarioId, CancellationToken ct = default);
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

public interface INombresClient
{
    /// <summary>
    /// Nunca lanza: un slot sin nombre guardado cae en su id (c1, c2…), que es
    /// cierto y suficiente. Perder los nombres no puede voltear la página.
    /// </summary>
    Task<IReadOnlyDictionary<string, string>> TodosAsync(string jwt, CancellationToken ct = default);

    /// <summary>
    /// Lanza <see cref="UpstreamException"/> si no se pudo guardar.
    ///
    /// Al revés que el historial: acá el usuario apretó Guardar y espera que el
    /// nombre quede. Un fallo silencioso le haría creer que se guardó, y lo
    /// descubriría recién al recargar.
    /// </summary>
    Task GuardarAsync(string jwt, string slot, string nombre, CancellationToken ct = default);
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

    /// <summary>
    /// Le pide al gateway un slot nuevo para el proyecto.
    ///
    /// El gateway elige cuál: es el único que sabe qué contenedores existen. El
    /// panel no toca Docker ni de lejos.
    /// </summary>
    public async Task<string> CrearSlotAsync(string proyecto, CancellationToken ct = default)
    {
        var res = await http.PostAsJsonAsync("/slots", new { proyecto }, Json.Opciones, ct);
        // Un 409 no es "el gateway se rompió": es "no quedan slots", que el
        // usuario tiene que poder distinguir de una caída.
        if (res.StatusCode == HttpStatusCode.Conflict) throw new UpstreamException("sin_slots");
        if (!res.IsSuccessStatusCode) throw new UpstreamException("slot_failed");

        var cuerpo = await res.Content.ReadFromJsonAsync<RespuestaSlot>(Json.Opciones, ct);
        return cuerpo?.Slot ?? throw new UpstreamException("slot_failed");
    }

    private sealed record RespuestaSlot(string Slot);

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
        var res = await http.GetAsync($"/login/{slot}/start", ct);
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
    private sealed record ErrorVinculo(string Code, string Message);

    public async Task<IReadOnlyList<JobResumen>> JobsAsync(int limite, CancellationToken ct = default)
    {
        var r = await http.GetFromJsonAsync<RespuestaJobs>($"/jobs?limit={limite}", Json.Opciones, ct);
        return r is null
            ? []
            : [.. r.Jobs.Select(j => new JobResumen(
                j.Id, j.Agent, j.Project, j.Prompt, j.Status, j.CreatedAt, j.Error))];
    }

    public async Task CanjearVinculoAsync(string codigo, string usuarioId, CancellationToken ct = default)
    {
        var res = await http.PostAsJsonAsync(
            "/vinculos",
            new { codigo, usuarioId },
            Json.Opciones,
            ct);

        if (res.IsSuccessStatusCode) return;

        ErrorVinculo? e = null;
        try { e = await res.Content.ReadFromJsonAsync<ErrorVinculo>(Json.Opciones, ct); }
        catch (JsonException) { /* sin cuerpo util; se usa el status */ }

        throw new UpstreamException(e?.Message ?? $"el bridge respondió {(int)res.StatusCode}");
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

// --- nombres de slot ------------------------------------------------------

/// <summary>
/// Los nombres que el usuario le pone a cada slot, en Supabase.
///
/// Mismo trato que el historial: se reenvía el JWT del usuario y decide RLS. El
/// panel no tiene credencial de escritura propia, así que no puede escribir
/// nombres de nadie más aunque quisiera.
/// </summary>
public sealed class NombresClient(HttpClient http, string anonKey, ILogger<NombresClient> log)
    : INombresClient
{
    private sealed record Fila(string Slot, string Nombre);

    private HttpRequestMessage Pedido(HttpMethod metodo, string url, string jwt)
    {
        var req = new HttpRequestMessage(metodo, url);
        req.Headers.TryAddWithoutValidation("apikey", anonKey);
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", jwt);
        return req;
    }

    public async Task<IReadOnlyDictionary<string, string>> TodosAsync(
        string jwt, CancellationToken ct = default)
    {
        try
        {
            var req = Pedido(HttpMethod.Get, "/rest/v1/slot_nombres?select=slot,nombre", jwt);
            var res = await http.SendAsync(req, ct);
            if (!res.IsSuccessStatusCode)
            {
                log.LogError("no se pudieron leer los nombres: {Status}", (int)res.StatusCode);
                return new Dictionary<string, string>();
            }

            var filas = await res.Content.ReadFromJsonAsync<List<Fila>>(Json.Opciones, ct) ?? [];
            // Se filtra por forma de slot ACÁ y no sólo al escribir: la tabla es
            // de otro proceso y una fila con un slot raro no puede meterse en el
            // mapa que el front usa para indexar.
            return filas
                .Where(f => Slot.EsValido(f.Slot) && !string.IsNullOrWhiteSpace(f.Nombre))
                .GroupBy(f => f.Slot)
                .ToDictionary(g => g.Key, g => g.First().Nombre);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException)
        {
            log.LogError(ex, "no se pudieron leer los nombres");
            return new Dictionary<string, string>();
        }
    }

    public async Task GuardarAsync(
        string jwt, string slot, string nombre, CancellationToken ct = default)
    {
        if (!Slot.EsValido(slot)) throw new UpstreamException($"slot desconocido: {slot}");

        try
        {
            // upsert: el slot es la clave primaria y renombrar es lo normal, no
            // la excepción. Sin `resolution=merge-duplicates` el segundo rename
            // del mismo slot daría 409.
            var req = Pedido(HttpMethod.Post, "/rest/v1/slot_nombres", jwt);
            req.Headers.TryAddWithoutValidation("Prefer", "resolution=merge-duplicates");
            req.Content = JsonContent.Create(new { slot, nombre }, options: Json.Opciones);

            var res = await http.SendAsync(req, ct);
            if (!res.IsSuccessStatusCode)
            {
                log.LogError("no se pudo guardar el nombre de {Slot}: {Status}", slot, (int)res.StatusCode);
                throw new UpstreamException("no se pudo guardar el nombre");
            }
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
        {
            log.LogError(ex, "no se pudo guardar el nombre de {Slot}", slot);
            throw new UpstreamException("no se pudo guardar el nombre");
        }
    }
}


// --- proyectos y agentes --------------------------------------------------

/// <summary>
/// Los proyectos del usuario. Mismo trato que el historial: se reenvía su JWT y
/// decide RLS.
/// </summary>
public sealed class ProyectosClient(HttpClient http, string anonKey, ILogger<ProyectosClient> log)
    : IProyectosClient
{
    private sealed record Fila(string Nombre);

    public async Task<string?> NombreSiEsMiembroAsync(
        string jwt, string proyectoId, CancellationToken ct = default)
    {
        // El id entra en un filtro de la URL. Si no es un UUID, no se consulta:
        // PostgREST devolvería un 400 con su propio mensaje adentro, y este
        // método contestaría "no es miembro" por la razón equivocada.
        if (!Guid.TryParse(proyectoId, out _)) return null;

        // La membresía NO se chequea acá: la chequea RLS. La policy "proyectos:
        // leer los mios" hace que un proyecto ajeno devuelva cero filas, que es
        // exactamente la respuesta que este método necesita.
        var url = $"/rest/v1/proyectos?id=eq.{proyectoId}&select=nombre&limit=1";
        try
        {
            var req = new HttpRequestMessage(HttpMethod.Get, url);
            req.Headers.TryAddWithoutValidation("apikey", anonKey);
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", jwt);
            var res = await http.SendAsync(req, ct);
            if (!res.IsSuccessStatusCode) return null;
            var filas = await res.Content.ReadFromJsonAsync<List<Fila>>(Json.Opciones, ct);
            return filas?.FirstOrDefault()?.Nombre;
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException)
        {
            log.LogError(ex, "no se pudo leer el proyecto {Proyecto}", proyectoId);
            return null;
        }
    }
}

/// <summary>
/// Anota en Supabase el agente que el gateway acaba de crear.
///
/// La tabla NO es el registro de qué agentes existen —eso lo contesta Docker—:
/// guarda lo que Docker no sabe, que es de qué proyecto es el slot.
/// </summary>
public sealed class AgentesClient(HttpClient http, string anonKey, ILogger<AgentesClient> log)
    : IAgentesClient
{
    public async Task RegistrarAsync(
        string jwt, string proyectoId, string slot, CancellationToken ct = default)
    {
        if (!Slot.EsValido(slot)) throw new UpstreamException("slot invalido");
        try
        {
            var req = new HttpRequestMessage(HttpMethod.Post, "/rest/v1/agentes");
            req.Headers.TryAddWithoutValidation("apikey", anonKey);
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", jwt);
            req.Content = JsonContent.Create(
                new { slot, proyecto_id = proyectoId }, options: Json.Opciones);
            var res = await http.SendAsync(req, ct);
            if (!res.IsSuccessStatusCode)
            {
                log.LogError("no se pudo anotar el agente {Slot}: {Status}", slot, (int)res.StatusCode);
                throw new UpstreamException("no se pudo anotar el agente");
            }
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
        {
            log.LogError(ex, "no se pudo anotar el agente {Slot}", slot);
            throw new UpstreamException("no se pudo anotar el agente");
        }
    }
}