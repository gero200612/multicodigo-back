using System.Text.RegularExpressions;

namespace MultiCodigo.Panel;

/// <summary>
/// La forma de un identificador de slot.
///
/// El gateway construye <c>claude/{agente}/</c> para la rama y hace
/// <c>agentUrls[agente]</c>; acá el id entra en una URL. Un string libre en
/// cualquiera de esos lugares es inyección de path. Es la misma forma que valida
/// <c>AgentId</c> del lado de TypeScript: dos implementaciones de la MISMA regla,
/// y por eso el test las compara contra la misma lista de casos.
/// </summary>
public static partial class Slot
{
    /// <summary>
    /// Anclado con <c>\A</c> y <c>\z</c>, no con <c>^</c> y <c>$</c>.
    ///
    /// En .NET, <c>$</c> hace match TAMBIÉN antes de un salto de línea final, así
    /// que <c>"c1\n"</c> pasaba con <c>^c[1-9][0-9]?$</c>. En JavaScript no, y
    /// entonces zod lo rechazaba: el mismo string era válido para este servicio e
    /// inválido para el resto del sistema. <c>\z</c> es el fin absoluto.
    ///
    /// Lo encontró el test que corre la misma lista de casos que el de
    /// TypeScript. Es exactamente el motivo por el que esa lista está duplicada.
    /// </summary>
    [GeneratedRegex(@"\Ac[1-9][0-9]?\z")]
    private static partial Regex Forma();

    public static bool EsValido(string? id) => id is not null && Forma().IsMatch(id);
}
