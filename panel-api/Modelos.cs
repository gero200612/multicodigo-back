using System.Text.Json.Serialization;

namespace MultiCodigo.Panel;

/// <summary>
/// Un slot de agente tal como lo ve el gateway: existe y responde, o no.
/// </summary>
/// <summary>
/// Un slot segun el gateway.
///
/// `Proyecto` es el NOMBRE, no el id: es lo que el gateway maneja, porque es lo
/// que va en la ruta del worktree. El gateway no sabe que existe Supabase.
/// </summary>
public sealed record Agente(string Id, bool Arriba, string? Proyecto = null);

/// <summary>
/// Metadata de la credencial de un slot. NUNCA incluye el token: el panel no
/// monta /srv/creds y el servicio de login sólo devuelve esto.
/// </summary>
public sealed record EstadoCredencial(
    bool Tiene,
    string? Account = null,
    string? LoadedAt = null,
    bool LoginAbierto = false);

public sealed record ResultadoTest(bool Ok, string Cuando, string? Detalle = null);

/// <summary>La cola de builds del gateway. Un solo slot para toda la máquina.</summary>
public sealed record Cola(IReadOnlyList<string> Corriendo, IReadOnlyList<string> Esperando)
{
    public static Cola Vacia { get; } = new([], []);
}

/// <summary>Una petición del historial del bridge, con el prompt ya recortado.</summary>
public sealed record JobResumen(
    string Id,
    string Agent,
    string Project,
    string Prompt,
    string Status,
    string CreatedAt,
    string? Error = null);

/// <summary>
/// La vista de un slot que consume el front.
///
/// Los tres estados van separados a propósito (spec §9): <see cref="Funcionando"/>
/// NO se deduce de <see cref="Arriba"/> + <see cref="TieneCredencial"/>. Un slot
/// puede estar arriba, con credencial y roto — que es exactamente lo que pasa
/// cuando vence un token, el modo de falla más frecuente del sistema. Derivarlo
/// haría que el panel diga que está todo bien justo en el caso que hay que
/// detectar.
/// </summary>
public sealed record SlotVista(
    string Slot,
    bool Arriba,
    bool TieneCredencial,
    bool LoginAbierto,
    bool Funcionando,
    string? Account = null,
    string? LoadedAt = null,
    ResultadoTest? UltimoTest = null,
    /// <summary>
    /// El nombre del proyecto del slot SEGUN EL CONTENEDOR, o null.
    ///
    /// Solo para mostrar. Puede estar desactualizado: el contenedor lleva el
    /// proyecto con el que se creo, y el usuario puede haber cambiado la
    /// asignacion despues.
    /// </summary>
    string? Proyecto = null,
    /// <summary>
    /// El id del proyecto del slot segun la tabla `agentes`, o null si el slot no
    /// esta anotado en ninguno.
    ///
    /// Este es el que sirve para ACTUAR: probar un slot corre un turno en el
    /// worktree de un proyecto, y la ruta pide el id. Sale de la tabla y no del
    /// contenedor porque los dos pueden divergir —el contenedor lleva una foto
    /// del momento en que se creo— y la tabla es la que el usuario controla.
    ///
    /// Antes el front cruzaba el NOMBRE con su lista de proyectos para sacar el
    /// id. Eso se rompia en silencio cuando el nombre del contenedor era viejo:
    /// el boton quedaba deshabilitado sin decir por que.
    /// </summary>
    string? ProyectoId = null,
    /// <summary>
    /// Hasta cuándo este slot no tiene cuota, como lo escribió Anthropic
    /// ("10:50pm"), o null si tiene.
    ///
    /// Es un estado propio y no un test fallido más: sobrevive a que nadie
    /// vuelva a probar —sigue siendo cierto hasta esa hora— y dice qué hacer,
    /// que es esperar o cargar otra cuenta. Ver Cuota.cs.
    /// </summary>
    string? SinCuotaHasta = null,
    /// <summary>
    /// Lo que este agente gastó en las últimas 5 horas, o null si no trabajó.
    /// </summary>
    /// <remarks>
    /// NO es "cuánto le queda": Anthropic no publica la cuota, así que no hay
    /// total contra el cual dividir y un porcentaje sería un número inventado
    /// por nosotros. La ventana de 5 horas es la misma que usa su límite, y eso
    /// es lo que hace comparable el número: se puede mirar contra lo que había
    /// gastado la vez que se quedó sin cuota.
    /// </remarks>
    Consumo? Consumo = null);

/// <summary>Lo gastado por un agente: tokens de entrada y salida, y dólares.</summary>
public sealed record Consumo(long Tokens, decimal CostoUsd);

/// <summary>Todo lo que la página muestra, en una sola respuesta.</summary>
public sealed record Panorama(
    IReadOnlyList<SlotVista> Slots,
    Cola Cola,
    IReadOnlyList<JobResumen> Jobs);

/// <param name="GoogleClientId">
/// El client ID de OAuth para elegir archivos de Google Drive, o null si no está
/// configurado (y entonces el botón queda apagado).
/// </param>
/// <param name="GoogleApiKey">
/// La API key del Google Picker, o null.
/// </param>
/// <remarks>
/// Los dos valores de Google son PÚBLICOS por diseño, igual que la clave anon de
/// Supabase: el navegador los necesita antes de poder pedirle nada a Google, así
/// que no hay forma de tenerlos del lado del servidor. Lo que los protege no es
/// el secreto: el client ID sólo funciona desde los orígenes JavaScript que se
/// dan de alta en Google Cloud, y la API key hay que restringirla por referrer
/// HTTP en la misma consola. Sin esas dos restricciones, cualquiera puede usar
/// la cuota del proyecto desde otro sitio.
///
/// Ambos son nullable a propósito: sin ellos el panel funciona igual y el botón
/// de Drive se muestra apagado, que es como está hoy. Ver el diseño en
/// <c>multicodigo-vm/docs/superpowers/specs/2026-09-03-google-drive-design.md</c>.
/// </remarks>
public sealed record ConfigFront(
    string SupabaseUrl,
    string SupabaseAnonKey,
    string? GoogleClientId = null,
    string? GoogleApiKey = null);

// --- cuerpos de request ---------------------------------------------------

public sealed record CuerpoCodigo([property: JsonPropertyName("code")] string? Code);

public sealed record CuerpoToken(
    [property: JsonPropertyName("token")] string? Token,
    [property: JsonPropertyName("account")] string? Account);

public sealed record NuevoNombre(
    [property: JsonPropertyName("nombre")] string? Nombre);

public sealed record CuerpoVinculo(
    [property: JsonPropertyName("codigo")] string? Codigo);

/// <summary>El código que devolvió Google, más el redirect con el que se pidió.</summary>
/// <remarks>
/// El `usuarioId` NO está acá a propósito: sale del JWT. Si viajara en el
/// cuerpo, cualquiera con sesión conectaría una cuenta de Google a la cuenta de
/// otro.
/// </remarks>
public sealed record CuerpoGoogle(
    [property: JsonPropertyName("code")] string? Code,
    [property: JsonPropertyName("redirectUri")] string? RedirectUri);

/// <summary>El archivo que la persona eligió en el Picker, y el link que lo pedía.</summary>
public sealed record CuerpoAutorizado(
    [property: JsonPropertyName("codigo")] string? Codigo,
    [property: JsonPropertyName("id")] string? Id);

public sealed record CuerpoProyecto(
    [property: JsonPropertyName("nombre")] string? Nombre);

public sealed record CuerpoInvitacion(
    [property: JsonPropertyName("email")] string? Email,
    [property: JsonPropertyName("rol")] string? Rol);

public sealed record CuerpoDecision(
    [property: JsonPropertyName("decision")] string? Decision,
    [property: JsonPropertyName("feedback")] string? Feedback);

public sealed record CuerpoRepo(
    [property: JsonPropertyName("nombre")] string? Nombre,
    [property: JsonPropertyName("github_repo")] string? GithubRepo);

/// <summary>Lo que el bridge le manda al panel para que le firme un token.</summary>
public sealed record CuerpoTokenInterno(
    [property: JsonPropertyName("installation_id")] long InstallationId);

/// <summary>
/// Lo que el front manda al volver de GitHub. Solo el id: la cuenta se le
/// pregunta a GitHub, no se le cree al navegador.
/// </summary>
public sealed record CuerpoInstalacion(
    [property: JsonPropertyName("installation_id")] long InstallationId);

public sealed record CuerpoTurno(
    [property: JsonPropertyName("prompt")] string? Prompt);

public sealed record RespuestaTurno(
    [property: JsonPropertyName("jobId")] string JobId,
    [property: JsonPropertyName("texto")] string Texto);
