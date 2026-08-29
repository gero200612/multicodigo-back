using System.Text.Json.Serialization;

namespace MultiCodigo.Panel;

/// <summary>
/// Un slot de agente tal como lo ve el gateway: existe y responde, o no.
/// </summary>
public sealed record Agente(string Id, bool Arriba);

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
    ResultadoTest? UltimoTest = null);

/// <summary>Todo lo que la página muestra, en una sola respuesta.</summary>
public sealed record Panorama(
    IReadOnlyList<SlotVista> Slots,
    Cola Cola,
    IReadOnlyList<JobResumen> Jobs);

public sealed record ConfigFront(string SupabaseUrl, string SupabaseAnonKey);

// --- cuerpos de request ---------------------------------------------------

public sealed record CuerpoCodigo([property: JsonPropertyName("code")] string? Code);

public sealed record CuerpoToken(
    [property: JsonPropertyName("token")] string? Token,
    [property: JsonPropertyName("account")] string? Account);

public sealed record NuevoNombre(
    [property: JsonPropertyName("nombre")] string? Nombre);

public sealed record CuerpoVinculo(
    [property: JsonPropertyName("codigo")] string? Codigo);

public sealed record CuerpoProyecto(
    [property: JsonPropertyName("nombre")] string? Nombre);

public sealed record CuerpoInvitacion(
    [property: JsonPropertyName("email")] string? Email,
    [property: JsonPropertyName("rol")] string? Rol);

public sealed record CuerpoDecision(
    [property: JsonPropertyName("decision")] string? Decision,
    [property: JsonPropertyName("feedback")] string? Feedback);
