using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace MultiCodigo.Panel;

/// <summary>
/// Las reglas de nombre y tipo de un documento.
///
/// Esto es lo que protege el disco del servidor. El nombre que sale de acá arma
/// una ruta en <c>/srv/work/&lt;slot&gt;/&lt;proyecto&gt;/_docs/</c>, y el nombre
/// que entra lo eligió quien subió el archivo — que puede no ser quien
/// administra el servidor.
/// </summary>
public static partial class Documentos
{
    /// <summary>
    /// Lo que el conversor sabe leer. Tiene que coincidir con `TIPOS` de
    /// <c>src/conversor/convertir.py</c>: si acá se acepta algo que allá no, el
    /// documento se guarda y nunca se puede convertir.
    /// </summary>
    public static readonly string[] Tipos = ["pdf", "xlsx", "docx", "csv", "md", "txt"];

    /// <summary>
    /// 20 MB. Declarado también en el conversor, y en los dos lugares a
    /// propósito: éste rechaza antes de leer el cuerpo, y aquél no puede confiar
    /// en que su único llamador valide.
    /// </summary>
    public const long MaximoBytes = 20 * 1024 * 1024;

    /// <summary>El tipo según la extensión, o null si no se sabe leer.</summary>
    public static string? TipoDe(string? nombreOriginal)
    {
        if (string.IsNullOrWhiteSpace(nombreOriginal)) return null;
        var ext = Path.GetExtension(nombreOriginal).TrimStart('.').ToLowerInvariant();
        return Tipos.Contains(ext) ? ext : null;
    }

    /// <summary>
    /// La forma que puede tener un nombre en el disco.
    ///
    /// La misma que el CHECK de la tabla y que <c>NombreDeRepo</c> del contrato
    /// compartido. Duplicada a propósito: acá da un mensaje legible, y el
    /// constraint impide que una fila mal formada entre por otro camino (el SQL
    /// editor, un script).
    /// </summary>
    public static bool NombreValido(string? nombre) =>
        !string.IsNullOrEmpty(nombre)
        && nombre != "."
        && nombre != ".."
        && FormaDeNombre().IsMatch(nombre);

    /// <summary>
    /// El nombre para el disco, derivado del que subió el usuario.
    ///
    /// Se DERIVA y no se recibe: es lo único que impide que un
    /// <c>../../etc/passwd</c> escriba fuera de <c>/srv/work</c>. El nombre
    /// original se guarda aparte, con sus espacios y acentos, para mostrarlo y
    /// para que la descarga conserve lo que la persona reconoce.
    /// </summary>
    public static string NombreDeArchivo(string nombreOriginal, string tipo)
    {
        // `GetFileName` descarta cualquier ruta. Es REDUNDANTE con la lista blanca
        // de abajo —verificado por mutacion: sacando esta linea los tests siguen
        // pasando, sacando la lista blanca fallan cuatro— y se deja igual porque
        // esto arma una ruta en disco y dos capas cuestan una linea.
        //
        // Lo que NO hay que hacer es confiar en esta: es la lista blanca la que
        // protege.
        var baseNombre = Path.GetFileName(nombreOriginal ?? "");
        var sinExt = Path.GetFileNameWithoutExtension(baseNombre);

        // Los acentos a su letra base en vez de descartarlos: "especificación"
        // tiene que quedar "especificacion" y no "especificacin".
        var limpio = new StringBuilder();
        foreach (var c in sinExt.Normalize(NormalizationForm.FormD))
        {
            if (CharUnicodeInfo.GetUnicodeCategory(c) == UnicodeCategory.NonSpacingMark) continue;
            // LISTA BLANCA, no negra: lo que no está acá se convierte en guión.
            // Una lista negra deja pasar lo que nadie pensó, y esto arma una ruta.
            limpio.Append(char.IsAsciiLetterOrDigit(c) || c is '.' or '_' or '-' ? c : '-');
        }

        // Los guiones repetidos se colapsan y los de los extremos se van: salen
        // de reemplazar espacios y paréntesis, y "informe--final-" es feo sin
        // ninguna razón.
        var nombre = GuionesRepetidos().Replace(limpio.ToString(), "-").Trim('-', '.');

        // Si no quedó nada usable, un nombre igual: una cadena vacía armaría la
        // ruta del directorio en vez de un archivo.
        if (nombre.Length == 0) nombre = "documento";

        // La extensión SIEMPRE: el gateway y el agente la usan para saber qué es,
        // y un archivo sin ella se ve como texto —el agente intentaría leer el
        // binario—.
        return nombre.EndsWith($".{tipo}", StringComparison.OrdinalIgnoreCase)
            ? nombre
            : $"{nombre}.{tipo}";
    }

    [GeneratedRegex(@"^[A-Za-z0-9._-]+$")]
    private static partial Regex FormaDeNombre();

    [GeneratedRegex(@"-{2,}")]
    private static partial Regex GuionesRepetidos();
}
