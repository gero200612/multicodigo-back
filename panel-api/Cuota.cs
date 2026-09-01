using System.Text.RegularExpressions;

namespace MultiCodigo.Panel;

/// <summary>
/// Cuándo un slot se quedó sin cuota de Claude, y hasta cuándo.
///
/// El aviso no es un campo estructurado: Anthropic lo escribe en el texto de la
/// respuesta ("You've hit your limit · resets 10:50pm (UTC)"), el agente lo
/// convierte en un error con código <c>usage_limit</c>, y llega hasta acá como
/// el detalle de un test fallido.
///
/// Sacarle la hora es lo que permite decir "vuelve a las 19:50" en vez de un
/// "sin cuota" pelado — que no dice si son diez minutos o seis horas, y esa es
/// justamente la diferencia entre esperar y cargar otra cuenta.
/// </summary>
public static partial class Cuota
{
    /// <summary>
    /// Reconoce el fallo por cuota, que NO es lo mismo que la credencial vencida.
    ///
    /// Se mira el prefijo del código y no palabras sueltas del texto: el detalle
    /// puede traer cualquier cosa que haya escrito el modelo, y una respuesta
    /// sobre rate limits no puede marcar el slot como agotado.
    /// </summary>
    public static bool EsSinCuota(string? detalle) =>
        detalle?.StartsWith("usage_limit", StringComparison.OrdinalIgnoreCase) == true;

    /// <summary>
    /// La hora de reset tal como la escribió Anthropic, o null si no la trae.
    ///
    /// Se devuelve el TEXTO ("10:50pm") y no un DateTime a propósito. Convertirlo
    /// pide saber la zona horaria del aviso —que dice UTC pero podría cambiar— y
    /// una hora mal convertida es peor que la original: le diría al usuario que
    /// espere hasta un momento que no es. El texto de Anthropic es exacto y ya
    /// está en la forma en que se va a mostrar.
    /// </summary>
    public static string? HoraDeReset(string? detalle)
    {
        if (string.IsNullOrWhiteSpace(detalle)) return null;
        var m = FormaDeHora().Match(detalle);
        return m.Success ? m.Groups[1].Value : null;
    }

    // `resets 10:50pm` o `Resets 5pm`. Los minutos son opcionales: el aviso los
    // omite cuando la hora es en punto.
    [GeneratedRegex(@"resets?\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm))", RegexOptions.IgnoreCase)]
    private static partial Regex FormaDeHora();
}
