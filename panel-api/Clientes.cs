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
    Task<ResultadoTest> ProbarAsync(
        string proyecto, string slot, IReadOnlyList<Repo> repos, string? githubToken,
        CancellationToken ct = default);
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
    /// <summary>Crea el proyecto y deja al usuario como dueño. Devuelve su id.</summary>
    Task<string> CrearAsync(string jwt, string nombre, CancellationToken ct = default);
    /// <summary>El rol del usuario en el proyecto, o null si no es miembro.</summary>
    Task<string?> RolDeAsync(string jwt, string proyectoId, CancellationToken ct = default);
    /// <summary>Invita por mail y devuelve el token. Solo para dueños.</summary>
    Task<string> InvitarAsync(
        string jwt, string proyectoId, string email, string rol, CancellationToken ct = default);
    /// <summary>Acepta una invitacion y devuelve el proyecto al que entro.</summary>
    Task<string> AceptarAsync(string jwt, string token, CancellationToken ct = default);
}

public interface IAgentesClient
{
    Task RegistrarAsync(string jwt, string proyectoId, string slot, CancellationToken ct = default);

    /// <summary>
    /// A qué proyecto pertenece cada slot, según la tabla `agentes`.
    ///
    /// Y no según el contenedor, que es lo que devuelve el gateway en /agents.
    /// Los dos pueden divergir: el contenedor lleva el proyecto con el que se
    /// creó, y esta tabla es la que el usuario cambia desde el panel. Cuando
    /// difieren, la que vale es ésta — es la que decide dónde se guarda el
    /// resultado de un test y la que el usuario puede corregir.
    /// </summary>
    Task<IReadOnlyDictionary<string, string>> ProyectosPorSlotAsync(
        string jwt, CancellationToken ct = default);

    /// <summary>
    /// Anota que este slot se quedó sin cuota, o que volvió a tenerla.
    ///
    /// `hasta` es el texto de Anthropic ("10:50pm"), no una fecha: ver Cuota.cs.
    /// Null lo limpia, que es lo que hace un test exitoso.
    /// </summary>
    Task MarcarCuotaAsync(string jwt, string slot, string? hasta, CancellationToken ct = default);

    /// <summary>Hasta cuándo está sin cuota cada slot. Sin entrada = tiene cuota.</summary>
    Task<IReadOnlyDictionary<string, string>> SinCuotaAsync(
        string jwt, CancellationToken ct = default);
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
    /// Cuánto gastó cada agente en las últimas 5 horas, indexado por slot.
    /// </summary>
    /// <remarks>
    /// No dice cuánto QUEDA: Anthropic no publica la cuota, así que no hay
    /// total contra el cual dividir y un porcentaje sería inventado. La ventana
    /// de 5 horas es la misma que usa su límite, y es lo que hace que el número
    /// se pueda comparar contra el momento en que el slot se agotó.
    /// </remarks>
    Task<IReadOnlyDictionary<string, Consumo>> ConsumoAsync(CancellationToken ct = default);
    /// <summary>
    /// Canjea un codigo de vinculacion a nombre del usuario. Lo llamamos desde
    /// el endpoint POST /api/telegram/vincular que le expone el panel al front.
    ///
    /// Devuelve 'ok' o lanza UpstreamException con el codigo de error (vencido,
    /// usado o desconocido).
    /// </summary>
    Task CanjearVinculoAsync(string codigo, string usuarioId, CancellationToken ct = default);
    /// <summary>
    /// Desata un chat de Telegram de esta cuenta. Devuelve si habia algo que
    /// desatar.
    /// </summary>
    /// <remarks>
    /// Pasa por el bridge y no por Supabase directo como el resto de las
    /// lecturas: la RLS de `telegram_vinculos` solo permite SELECT —la escribe
    /// el bridge, que es `postgres`— asi que un DELETE desde el front no
    /// borraria nada y fallaria en silencio.
    /// </remarks>
    Task<bool> DesvincularTelegramAsync(long chatId, string usuarioId, CancellationToken ct = default);
    /// <summary>
    /// Decide una aprobacion. Tira UpstreamException("ya_decidida") si alguien
    /// se adelanto.
    /// </summary>
    Task DecidirAsync(
        string aprobacionId, string decision, string? feedback, string usuarioId,
        CancellationToken ct = default);
    /// <summary>
    /// Le pide al bridge que corra un turno, y espera la respuesta.
    ///
    /// Los repos van en el pedido porque el gateway —que es quien prepara los
    /// worktrees— no le habla a Supabase, donde estan vinculados. Es el panel el
    /// unico que puede leerlos con el JWT del usuario y pasarlos.
    /// </summary>
    Task<RespuestaTurno> TurnoAsync(
        string proyectoId, string proyecto, string slot, string usuarioId, string prompt,
        IReadOnlyList<Repo> repos, string? githubToken,
        IReadOnlyList<DocumentoDelTurno> documentos, CancellationToken ct = default);
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

/// <summary>
/// Un tope de tiempo para UN request, sin tocar el del cliente.
///
/// Hace falta porque `HttpClient.Timeout` es de todo el cliente y un mismo
/// servicio tiene operaciones de escalas distintas: al gateway se le piden
/// listados que refrescan una pagina (segundos) y turnos de Claude (minutos).
/// Con un solo numero, o se corta el turno o se cuelga la pagina.
///
/// El token del llamador se encadena: si el navegador corta la conexion, el
/// pedido al servicio de abajo se cancela igual.
/// </summary>
internal static class Topes
{
    public static CancellationTokenSource De(CancellationToken ct, int segundos)
    {
        var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(TimeSpan.FromSeconds(segundos));
        return cts;
    }
}

internal static class Json
{
    public static readonly JsonSerializerOptions Opciones = new(JsonSerializerDefaults.Web);

    /// <summary>
    /// Para leer lo que devuelve PostgREST, que usa los nombres de las COLUMNAS.
    ///
    /// `Opciones` es camelCase, asi que una columna con underscore no matchea
    /// nunca: buscando `installationId` contra un `installation_id` que llega,
    /// System.Text.Json no encuentra nada, **no avisa**, y deja la propiedad en
    /// su valor por defecto. Un `long` queda en 0 y un `string` en null.
    ///
    /// Asi se perdio el installation_id de la GitHub App: llegaba en 0, el panel
    /// pedia un token para la instalacion 0, GitHub contestaba 404 y la pantalla
    /// mostraba "ningun repo" — tres capas mas abajo de la causa.
    ///
    /// Peor todavia: las columnas de UNA palabra si funcionan (`cuenta`,
    /// `nombre`, `slot`), asi que el bug aparece solo en algunas y parece otra
    /// cosa.
    ///
    /// Del lado de la ESCRITURA no hace falta —los objetos anonimos ya nombran
    /// las columnas a mano— pero usarlas igual no molesta: `proyecto_id` ya esta
    /// en snake_case y la politica lo deja como esta.
    /// </summary>
    public static readonly JsonSerializerOptions Supabase = new(JsonSerializerDefaults.Web)
    {
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
    };
}

// --- gateway --------------------------------------------------------------

public sealed class GatewayClient(HttpClient http) : IGatewayClient
{
    private sealed record RespuestaAgentes(List<AgenteDto> Agents);
    private sealed record AgenteDto(string Id, bool Arriba, string? Proyecto);
    private sealed record RespuestaPrompt(string Text);

    public async Task<IReadOnlyList<Agente>> AgentesAsync(CancellationToken ct = default)
    {
        // Corto: lo pide una pagina que se refresca sola, y un gateway colgado
        // no puede hacerla esperar.
        using var cts = Topes.De(ct, 20);
        var r = await http.GetFromJsonAsync<RespuestaAgentes>("/agents", Json.Opciones, cts.Token)
                ?? throw new UpstreamException("el gateway devolvió una respuesta vacía");
        return [.. r.Agents.Select(a => new Agente(a.Id, a.Arriba, a.Proyecto))];
    }

    /// <summary>
    /// Le pide al gateway un slot nuevo para el proyecto.
    ///
    /// El gateway elige cuál: es el único que sabe qué contenedores existen. El
    /// panel no toca Docker ni de lejos.
    /// </summary>
    public async Task<string> CrearSlotAsync(string proyecto, CancellationToken ct = default)
    {
        // Crear un contenedor es rapido, pero no instantaneo como un listado.
        using var cts = Topes.De(ct, 60);
        var res = await http.PostAsJsonAsync("/slots", new { proyecto }, Json.Opciones, cts.Token);
        // Un 409 no es "el gateway se rompió": es "no quedan slots", que el
        // usuario tiene que poder distinguir de una caída.
        if (res.StatusCode == HttpStatusCode.Conflict) throw new UpstreamException("sin_slots");
        if (!res.IsSuccessStatusCode) throw new UpstreamException("slot_failed");

        var cuerpo = await res.Content.ReadFromJsonAsync<RespuestaSlot>(Json.Opciones, ct);
        return cuerpo?.Slot ?? throw new UpstreamException("slot_failed");
    }

    private sealed record RespuestaSlot(string Slot);

    public async Task<Cola> ColaAsync(CancellationToken ct = default)
    {
        using var cts = Topes.De(ct, 20);
        return await http.GetFromJsonAsync<Cola>("/queue", Json.Opciones, cts.Token) ?? Cola.Vacia;
    }

    /// <summary>
    /// Un turno trivial contra el agente.
    ///
    /// Es el mismo código que el health check diario del paso 8 del despliegue,
    /// que pasa a ser un cron llamando a este endpoint en vez de un script
    /// suelto. Un solo camino, testeado una vez.
    /// </summary>
    public async Task<ResultadoTest> ProbarAsync(
        string proyecto, string slot, IReadOnlyList<Repo> repos, string? githubToken,
        CancellationToken ct = default)
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
                    // Los repos, igual que en un turno de verdad. Sin esto el
                    // gateway cae a su catalogo local (`config/projects.json`),
                    // que solo conoce `demo`, y todo proyecto creado desde el
                    // panel se comia un 404 unknown_project — que la pantalla
                    // mostraba como "no responde", culpando al agente.
                    //
                    // Y ademas seria una prueba que no prueba lo que importa: si
                    // el test corre sobre otros repos que un turno real, un
                    // problema de clonado no aparece hasta el primer turno.
                    repos = repos.Select(r => new { nombre = r.Nombre, github_repo = r.GithubRepo }),
                    // El token, igual que en un turno de verdad. Sin el, el
                    // gateway clona el espejo por SSH con la deploy key: si el
                    // repo solo es accesible con la App, git falla con "Host key
                    // verification failed" y el worktree nunca se crea.
                    githubToken,
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
        // Corto: es parte del refresco de la pagina.
        using var cts = Topes.De(ct, 20);
        var r = await http.GetFromJsonAsync<RespuestaEstado>($"/login/{slot}/status", Json.Opciones, cts.Token);
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
    {
        using var cts = Topes.De(ct, 30);
        await LanzarSiFallo(await http.DeleteAsync($"/login/{slot}", cts.Token), cts.Token);
    }

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

    private sealed record RespuestaConsumo(Dictionary<string, Consumo>? Consumo);

    public async Task<IReadOnlyDictionary<string, Consumo>> ConsumoAsync(
        CancellationToken ct = default)
    {
        var r = await http.GetFromJsonAsync<RespuestaConsumo>("/consumo", Json.Opciones, ct);
        return r?.Consumo ?? [];
    }

    /// <summary>
    /// Le pide al bridge que decida una aprobacion.
    ///
    /// Va al bridge y NO al gateway: si el panel decidiera contra el gateway,
    /// el bridge no se enteraria y el mensaje de Telegram quedaria con los
    /// botones vivos sobre algo ya decidido.
    /// </summary>
    public async Task DecidirAsync(
        string aprobacionId, string decision, string? feedback, string usuarioId,
        CancellationToken ct = default)
    {
        var res = await http.PostAsJsonAsync(
            $"/aprobaciones/{aprobacionId}/decision",
            new { decision = new { decision, feedback }, usuarioId },
            Json.Opciones,
            ct);

        // 409 no es una falla: alguien la decidio desde Telegram mientras la
        // pantalla estaba abierta. El panel lo muestra distinto.
        if (res.StatusCode == HttpStatusCode.Conflict) throw new UpstreamException("ya_decidida");
        if (res.StatusCode == HttpStatusCode.NotFound) throw new UpstreamException("desconocida");
        if (!res.IsSuccessStatusCode) throw new UpstreamException("decision_fallo");
    }

    /// <summary>
    /// Corre un turno.
    ///
    /// Va al bridge y no al gateway aunque el gateway sea quien tiene al agente:
    /// el bridge es el que sabe crear el job, colgar el poller de aprobaciones y
    /// guardar la sesion del hilo. Un turno del panel que salteara todo eso
    /// seria una conversacion distinta de la de Telegram.
    ///
    /// El timeout es el del cliente entero (20 s) y NO alcanza para un turno de
    /// verdad: por eso Program.cs le arma su propio HttpClient con uno largo.
    /// </summary>
    public async Task<RespuestaTurno> TurnoAsync(
        string proyectoId, string proyecto, string slot, string usuarioId, string prompt,
        IReadOnlyList<Repo> repos, string? githubToken,
        IReadOnlyList<DocumentoDelTurno> documentos, CancellationToken ct = default)
    {
        var res = await http.PostAsJsonAsync(
            "/turnos",
            new
            {
                proyectoId,
                proyecto,
                agente = slot,
                usuarioId,
                prompt,
                // `github_repo` y no `githubRepo`: el schema del bridge sale del
                // contrato compartido, que usa el nombre de la columna. Con la
                // convencion camelCase de Json.Opciones no coincidiria y el
                // bridge contestaria cuerpo_invalido.
                repos = repos.Select(r => new { nombre = r.Nombre, github_repo = r.GithubRepo }),
                // El token de instalacion del turno. El bridge lo reenvia al
                // gateway sin mirarlo, y el gateway NO se lo pasa al agente.
                // Null cuando el proyecto no instalo la App: ahi se va por SSH.
                githubToken,
                // Los documentos, como RUTAS en el disco del servidor. El
                // gateway monta el mismo directorio, los copia a `_docs` del
                // worktree y el agente los lee como un archivo mas.
                documentos = documentos.Select(d => new
                {
                    nombre = d.Nombre,
                    ruta = d.Ruta,
                    ruta_texto = d.RutaTexto,
                }),
            },
            Json.Opciones,
            ct);

        if (!res.IsSuccessStatusCode)
        {
            // El `code` del bridge es el del agente (agent_unavailable,
            // sin_credencial…). Se propaga tal cual: es lo que le dice al
            // usuario que hacer.
            var cuerpoError = await res.Content.ReadFromJsonAsync<ErrorUpstream>(Json.Opciones, ct);
            throw new UpstreamException(cuerpoError?.Code ?? "turno_fallo");
        }

        return await res.Content.ReadFromJsonAsync<RespuestaTurno>(Json.Opciones, ct)
               ?? throw new UpstreamException("turno_fallo");
    }

    private sealed record ErrorUpstream(string? Code);

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

    private sealed record RespuestaDesvinculo(bool Desvinculado);

    public async Task<bool> DesvincularTelegramAsync(
        long chatId, string usuarioId, CancellationToken ct = default)
    {
        // El usuarioId viaja y el bridge lo exige: sin eso, cualquiera con
        // sesion podria desatar el chat de otro pasando su chatId.
        var res = await http.PostAsJsonAsync(
            "/vinculos/borrar",
            new { chatId, usuarioId },
            Json.Opciones,
            ct);

        if (!res.IsSuccessStatusCode)
        {
            throw new UpstreamException($"el bridge respondió {(int)res.StatusCode}");
        }

        var cuerpo = await res.Content.ReadFromJsonAsync<RespuestaDesvinculo>(Json.Opciones, ct);
        return cuerpo?.Desvinculado ?? false;
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
/// <summary>Un repo vinculado a un proyecto.</summary>
public sealed record Repo(string Nombre, string GithubRepo);

/// <summary>
/// Los repos de cada proyecto, en Supabase.
///
/// Se reenvía el JWT del usuario y decide RLS, igual que el historial y los
/// nombres: un repo de un proyecto del que no sos miembro no aparece, y eso
/// convierte "¿puede ver esto?" en una pregunta que no hay que programar.
/// </summary>
public interface IReposClient
{
    Task<IReadOnlyList<Repo>> DeProyectoAsync(string jwt, string proyectoId, CancellationToken ct = default);
    Task VincularAsync(string jwt, string proyectoId, Repo repo, CancellationToken ct = default);
    Task DesvincularAsync(string jwt, string proyectoId, string nombre, CancellationToken ct = default);
}

/// <summary>La instalacion de la GitHub App de un proyecto.</summary>
public sealed record Instalacion(long InstallationId, string Cuenta);

/// <summary>
/// La instalación de la GitHub App de cada proyecto, en Supabase.
///
/// Mismo patrón que los repos: se reenvía el JWT del usuario y decide RLS. Con
/// una diferencia que vive en las policies y no acá — leer es de cualquier
/// miembro, ESCRIBIR es sólo del dueño. Ver `docs/supabase-github-instalaciones.sql`:
/// esta fila decide con qué credencial pushean todos los agentes del proyecto.
/// </summary>
public interface IInstalacionesClient
{
    /// <summary>La instalación del proyecto, o null si todavía no instaló la App.</summary>
    Task<Instalacion?> DeProyectoAsync(string jwt, string proyectoId, CancellationToken ct = default);
    Task GuardarAsync(string jwt, string proyectoId, Instalacion inst, CancellationToken ct = default);

    /// <summary>
    /// Desvincula la instalación del proyecto.
    /// </summary>
    /// <remarks>
    /// Borra la fila y nada más: la App sigue instalada del lado de GitHub. Es
    /// deliberado — desinstalarla desde acá afectaría a los OTROS proyectos que
    /// comparten esa instalación, y esa decisión es del dueño de la cuenta de
    /// GitHub, no de este panel. Lo que se corta es que ESTE proyecto la use.
    /// </remarks>
    Task BorrarAsync(string jwt, string proyectoId, CancellationToken ct = default);
}

public sealed class InstalacionesClient(
    HttpClient http, string anonKey, ILogger<InstalacionesClient> log) : IInstalacionesClient
{
    private sealed record Fila(long InstallationId, string Cuenta);

    private HttpRequestMessage Pedido(HttpMethod metodo, string url, string jwt)
    {
        var req = new HttpRequestMessage(metodo, url);
        req.Headers.TryAddWithoutValidation("apikey", anonKey);
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", jwt);
        return req;
    }

    public async Task<Instalacion?> DeProyectoAsync(
        string jwt, string proyectoId, CancellationToken ct = default)
    {
        var url = $"/rest/v1/github_instalaciones?proyecto_id=eq.{proyectoId}"
                + "&select=installation_id,cuenta";
        var res = await http.SendAsync(Pedido(HttpMethod.Get, url, jwt), ct);
        if (!res.IsSuccessStatusCode)
        {
            // Sin instalación el turno igual corre: cae al camino SSH, que es el
            // de `demo`. Una caída de Supabase no puede voltear todos los turnos.
            log.LogWarning("no se pudo leer la instalacion de {Proyecto}", proyectoId);
            return null;
        }
        var filas = await res.Content.ReadFromJsonAsync<List<Fila>>(Json.Supabase, ct);
        var f = (filas ?? []).FirstOrDefault();
        return f is null ? null : new Instalacion(f.InstallationId, f.Cuenta);
    }

    public async Task GuardarAsync(
        string jwt, string proyectoId, Instalacion inst, CancellationToken ct = default)
    {
        var req = Pedido(HttpMethod.Post, "/rest/v1/github_instalaciones", jwt);
        // UPSERT: reinstalar la App en GitHub emite un installation_id nuevo, y
        // el proyecto tiene que quedarse con el último. Sin `resolution=merge`
        // el segundo intento choca contra la PK y el usuario ve un error después
        // de haber hecho todo bien.
        req.Headers.TryAddWithoutValidation("Prefer", "return=minimal,resolution=merge-duplicates");
        req.Content = JsonContent.Create(
            new
            {
                proyecto_id = proyectoId,
                installation_id = inst.InstallationId,
                cuenta = inst.Cuenta,
            },
            options: Json.Opciones);

        var res = await http.SendAsync(req, ct);
        if (!res.IsSuccessStatusCode)
        {
            var detalle = await res.Content.ReadAsStringAsync(ct);
            log.LogError("no se pudo guardar la instalacion de {Proyecto}: {Detalle}", proyectoId, detalle);
            // 403 es RLS: no sos dueño. Es un caso del usuario y no una caída.
            throw new UpstreamException(
                res.StatusCode == HttpStatusCode.Forbidden ? "no_sos_dueño" : "instalacion_no_guardada");
        }
    }

    public async Task BorrarAsync(string jwt, string proyectoId, CancellationToken ct = default)
    {
        var url = $"/rest/v1/github_instalaciones?proyecto_id=eq.{proyectoId}";
        var res = await http.SendAsync(Pedido(HttpMethod.Delete, url, jwt), ct);
        if (!res.IsSuccessStatusCode)
        {
            var detalle = await res.Content.ReadAsStringAsync(ct);
            log.LogError("no se pudo desvincular la instalacion de {Proyecto}: {Detalle}", proyectoId, detalle);
            throw new UpstreamException(
                res.StatusCode == HttpStatusCode.Forbidden ? "no_sos_dueño" : "instalacion_no_borrada");
        }
    }
}

public sealed class ReposClient(HttpClient http, string anonKey, ILogger<ReposClient> log)
    : IReposClient
{
    private sealed record Fila(string Nombre, string GithubRepo);

    private HttpRequestMessage Pedido(HttpMethod metodo, string url, string jwt)
    {
        var req = new HttpRequestMessage(metodo, url);
        req.Headers.TryAddWithoutValidation("apikey", anonKey);
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", jwt);
        return req;
    }

    public async Task<IReadOnlyList<Repo>> DeProyectoAsync(
        string jwt, string proyectoId, CancellationToken ct = default)
    {
        // Orden explícito: sin esto PostgREST devuelve las filas en el orden que
        // le convenga y la lista de la pantalla salta de lugar entre recargas.
        var url = $"/rest/v1/repos?proyecto_id=eq.{proyectoId}"
                + "&select=nombre,github_repo&order=nombre";
        var res = await http.SendAsync(Pedido(HttpMethod.Get, url, jwt), ct);
        if (!res.IsSuccessStatusCode)
        {
            log.LogWarning("no se pudieron leer los repos de {Proyecto}", proyectoId);
            return [];
        }
        var filas = await res.Content.ReadFromJsonAsync<List<Fila>>(Json.Supabase, ct);
        return [.. (filas ?? []).Select(f => new Repo(f.Nombre, f.GithubRepo))];
    }

    public async Task VincularAsync(
        string jwt, string proyectoId, Repo repo, CancellationToken ct = default)
    {
        var req = Pedido(HttpMethod.Post, "/rest/v1/repos", jwt);
        // `return=minimal` porque no se usa la fila que vuelve, y así PostgREST
        // no necesita permiso de SELECT sobre lo recién insertado.
        req.Headers.TryAddWithoutValidation("Prefer", "return=minimal");
        req.Content = JsonContent.Create(
            new { proyecto_id = proyectoId, nombre = repo.Nombre, github_repo = repo.GithubRepo },
            options: Json.Opciones);

        var res = await http.SendAsync(req, ct);
        // 409 es el UNIQUE (proyecto_id, nombre): ese repo ya estaba vinculado.
        // Es un caso del usuario, no una caída, y la pantalla lo dice distinto.
        if (res.StatusCode == HttpStatusCode.Conflict) throw new UpstreamException("repo_duplicado");
        if (!res.IsSuccessStatusCode)
        {
            var detalle = await res.Content.ReadAsStringAsync(ct);
            log.LogError("no se pudo vincular {Repo}: {Detalle}", repo.Nombre, detalle);
            throw new UpstreamException("repo_no_vinculado");
        }
    }

    public async Task DesvincularAsync(
        string jwt, string proyectoId, string nombre, CancellationToken ct = default)
    {
        // Los DOS filtros y no sólo el nombre: sin el proyecto, un nombre
        // repetido en otro proyecto del que TAMBIÉN sos miembro se borraría de
        // los dos lados. RLS no lo impide, porque en los dos sos miembro.
        var url = $"/rest/v1/repos?proyecto_id=eq.{proyectoId}"
                + $"&nombre=eq.{Uri.EscapeDataString(nombre)}";
        var res = await http.SendAsync(Pedido(HttpMethod.Delete, url, jwt), ct);
        if (!res.IsSuccessStatusCode) throw new UpstreamException("repo_no_desvinculado");
    }
}

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
            var filas = await res.Content.ReadFromJsonAsync<List<Fila>>(Json.Supabase, ct);
            var f = filas?.FirstOrDefault();
            return f is null ? null : new ResultadoTest(f.Ok, f.Cuando, f.Detalle);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException)
        {
            log.LogError(ex, "no se pudo leer el historial de {Slot}", slot);
            return null;
        }
    }

    private sealed record FilaAgente(string ProyectoId);

    /// <summary>
    /// De que proyecto es el slot.
    ///
    /// Hace falta para GUARDAR: la policy de INSERT de `test_runs` exige
    /// `proyecto_id IS NOT NULL AND es_miembro(proyecto_id)`, asi que una fila
    /// sin proyecto la rechaza RLS. Para LEER no se pasa: ahi filtra la policy
    /// sola, que es el punto de tenerla.
    ///
    /// Devuelve null si el slot no esta anotado —un contenedor que existe en
    /// Docker pero que nadie registro en un proyecto—: ahi el test corre igual,
    /// solo que no queda en el historial.
    /// </summary>
    private async Task<string?> ProyectoDelSlotAsync(string jwt, string slot, CancellationToken ct)
    {
        try
        {
            var url = $"/rest/v1/agentes?slot=eq.{slot}&select=proyecto_id&limit=1";
            var res = await http.SendAsync(Pedido(HttpMethod.Get, url, jwt), ct);
            if (!res.IsSuccessStatusCode) return null;
            var filas = await res.Content.ReadFromJsonAsync<List<FilaAgente>>(Json.Supabase, ct);
            return filas?.FirstOrDefault()?.ProyectoId;
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException)
        {
            log.LogError(ex, "no se pudo resolver el proyecto de {Slot}", slot);
            return null;
        }
    }

    public async Task GuardarAsync(string jwt, string slot, ResultadoTest r, CancellationToken ct = default)
    {
        if (!Slot.EsValido(slot)) return;

        var proyectoId = await ProyectoDelSlotAsync(jwt, slot, ct);
        if (proyectoId is null)
        {
            // Sin proyecto no se puede guardar, y no es un error del test: el
            // agente contesto igual. Se avisa, porque el sintoma que ve el
            // usuario es una tarjeta que dice "Sin probar" despues de probar.
            log.LogWarning(
                "el test de {Slot} no se guarda: el slot no esta anotado en ningun proyecto", slot);
            return;
        }

        try
        {
            var req = Pedido(HttpMethod.Post, "/rest/v1/test_runs", jwt);
            req.Content = JsonContent.Create(
                new { slot, ok = r.Ok, cuando = r.Cuando, detalle = r.Detalle, proyecto_id = proyectoId },
                options: Json.Opciones);
            var res = await http.SendAsync(req, ct);
            if (!res.IsSuccessStatusCode)
            {
                var detalle = await res.Content.ReadAsStringAsync(ct);
                log.LogError("no se pudo guardar el test de {Slot}: {Status} {Detalle}",
                    slot, (int)res.StatusCode, detalle);
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

            var filas = await res.Content.ReadFromJsonAsync<List<Fila>>(Json.Supabase, ct) ?? [];
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
            var filas = await res.Content.ReadFromJsonAsync<List<Fila>>(Json.Supabase, ct);
            return filas?.FirstOrDefault()?.Nombre;
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException)
        {
            log.LogError(ex, "no se pudo leer el proyecto {Proyecto}", proyectoId);
            return null;
        }
    }

    /// <summary>
    /// Llama a una funcion de la base reenviando el JWT del usuario.
    ///
    /// Las escrituras que dependen de un rol —crear, invitar, aceptar— viven
    /// como funciones SECURITY DEFINER: hacen su propio chequeo contra
    /// `auth.uid()` y escriben solo lo suyo. Asi el panel no necesita una
    /// service_role, que podria todo sobre todas las tablas.
    /// </summary>
    private async Task<HttpResponseMessage> RpcAsync(
        string jwt, string funcion, object cuerpo, CancellationToken ct)
    {
        var req = new HttpRequestMessage(HttpMethod.Post, $"/rest/v1/rpc/{funcion}");
        req.Headers.TryAddWithoutValidation("apikey", anonKey);
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", jwt);
        req.Content = JsonContent.Create(cuerpo, options: Json.Opciones);
        return await http.SendAsync(req, ct);
    }

    public async Task<string> CrearAsync(string jwt, string nombre, CancellationToken ct = default)
    {
        var res = await RpcAsync(jwt, "crear_proyecto", new { p_nombre = nombre }, ct);
        if (!res.IsSuccessStatusCode)
        {
            var detalle = await res.Content.ReadAsStringAsync(ct);
            log.LogError("no se pudo crear el proyecto {Nombre}: {Status} {Detalle}",
                nombre, (int)res.StatusCode, detalle);
            // Un nombre repetido choca con el UNIQUE de la tabla. Es lo unico
            // que el usuario puede arreglar solo, asi que se distingue.
            throw new UpstreamException(detalle.Contains("proyectos_nombre_key", StringComparison.Ordinal)
                ? "nombre_repetido"
                : "proyecto_no_creado");
        }
        // Una funcion que devuelve un escalar vuelve como JSON pelado: "uuid".
        return (await res.Content.ReadFromJsonAsync<string>(Json.Opciones, ct))
               ?? throw new UpstreamException("proyecto_no_creado");
    }

    public async Task<string?> RolDeAsync(string jwt, string proyectoId, CancellationToken ct = default)
    {
        if (!Guid.TryParse(proyectoId, out _)) return null;
        var res = await RpcAsync(jwt, "mi_rol", new { p_proyecto = proyectoId }, ct);
        if (!res.IsSuccessStatusCode) return null;
        return await res.Content.ReadFromJsonAsync<string>(Json.Opciones, ct);
    }

    public async Task<string> InvitarAsync(
        string jwt, string proyectoId, string email, string rol, CancellationToken ct = default)
    {
        var res = await RpcAsync(
            jwt, "invitar", new { p_proyecto = proyectoId, p_email = email, p_rol = rol }, ct);
        if (!res.IsSuccessStatusCode)
        {
            // 403 del RPC = no sos dueño. La funcion es la que decide, no el
            // panel: es el chequeo que no se puede saltear llamando al RPC.
            if (res.StatusCode is HttpStatusCode.Forbidden or HttpStatusCode.Unauthorized)
            {
                throw new UpstreamException("no_sos_dueño");
            }
            log.LogError("no se pudo invitar a {Proyecto}: {Status}", proyectoId, (int)res.StatusCode);
            throw new UpstreamException("invitacion_fallo");
        }
        return (await res.Content.ReadFromJsonAsync<string>(Json.Opciones, ct))
               ?? throw new UpstreamException("invitacion_fallo");
    }

    public async Task<string> AceptarAsync(string jwt, string token, CancellationToken ct = default)
    {
        var res = await RpcAsync(jwt, "aceptar_invitacion", new { p_token = token }, ct);
        if (!res.IsSuccessStatusCode) throw new UpstreamException("invitacion_no_sirve");
        return (await res.Content.ReadFromJsonAsync<string>(Json.Opciones, ct))
               ?? throw new UpstreamException("invitacion_no_sirve");
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
    private sealed record FilaSlot(string Slot, string ProyectoId);
    private sealed record FilaCuota(string Slot, string? SinCuotaHasta);

    public async Task MarcarCuotaAsync(
        string jwt, string slot, string? hasta, CancellationToken ct = default)
    {
        if (!Slot.EsValido(slot)) return;
        try
        {
            var req = new HttpRequestMessage(HttpMethod.Patch, $"/rest/v1/agentes?slot=eq.{slot}");
            req.Headers.TryAddWithoutValidation("apikey", anonKey);
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", jwt);
            req.Headers.TryAddWithoutValidation("Prefer", "return=minimal");
            req.Content = JsonContent.Create(new { sin_cuota_hasta = hasta }, options: Json.Opciones);
            var res = await http.SendAsync(req, ct);
            if (!res.IsSuccessStatusCode)
            {
                // No se propaga: el test ya corrió y su resultado es lo que
                // importa. Perder la anotación degrada el cartel, no el turno.
                log.LogWarning("no se pudo anotar la cuota de {Slot}: {Status}", slot, (int)res.StatusCode);
            }
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
        {
            log.LogWarning(ex, "no se pudo anotar la cuota de {Slot}", slot);
        }
    }

    public async Task<IReadOnlyDictionary<string, string>> SinCuotaAsync(
        string jwt, CancellationToken ct = default)
    {
        try
        {
            var req = new HttpRequestMessage(
                HttpMethod.Get, "/rest/v1/agentes?select=slot,sin_cuota_hasta&sin_cuota_hasta=not.is.null");
            req.Headers.TryAddWithoutValidation("apikey", anonKey);
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", jwt);
            var res = await http.SendAsync(req, ct);
            if (!res.IsSuccessStatusCode) return new Dictionary<string, string>();

            var filas = await res.Content.ReadFromJsonAsync<List<FilaCuota>>(Json.Supabase, ct);
            return (filas ?? [])
                .Where(f => !string.IsNullOrWhiteSpace(f.SinCuotaHasta))
                .ToDictionary(f => f.Slot, f => f.SinCuotaHasta!);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException)
        {
            log.LogWarning(ex, "no se pudo leer que slots estan sin cuota");
            return new Dictionary<string, string>();
        }
    }

    public async Task<IReadOnlyDictionary<string, string>> ProyectosPorSlotAsync(
        string jwt, CancellationToken ct = default)
    {
        try
        {
            var req = new HttpRequestMessage(HttpMethod.Get, "/rest/v1/agentes?select=slot,proyecto_id");
            req.Headers.TryAddWithoutValidation("apikey", anonKey);
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", jwt);
            var res = await http.SendAsync(req, ct);
            if (!res.IsSuccessStatusCode) return new Dictionary<string, string>();

            var filas = await res.Content.ReadFromJsonAsync<List<FilaSlot>>(Json.Supabase, ct);
            // RLS ya filtra por membresía, así que lo que vuelve son los slots de
            // los proyectos del usuario y nada más.
            return (filas ?? []).ToDictionary(f => f.Slot, f => f.ProyectoId);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException)
        {
            // Sin esto el botón de probar queda deshabilitado, y eso es mejor que
            // habilitarlo apuntando a un proyecto equivocado.
            log.LogWarning(ex, "no se pudieron leer los proyectos de los slots");
            return new Dictionary<string, string>();
        }
    }

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