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
    /// Las imágenes, que el agente VE en vez de leer.
    /// </summary>
    /// <remarks>
    /// No pasan por el conversor y no tienen <c>.md</c>: el agente las abre con
    /// <c>Read</c>, que se las pasa al modelo como imagen. Eso es mejor que un
    /// OCR — ve el diagrama o la captura entera, no sólo el texto que tenga.
    ///
    /// Espeja <c>TIPOS_IMAGEN</c> del bridge. Los dos tienen que moverse juntos:
    /// si acá se acepta algo que allá no, el mismo archivo entra por el panel y
    /// se rechaza por Telegram.
    /// </remarks>
    public static readonly string[] TiposImagen = ["png", "jpg", "jpeg", "webp", "gif"];

    /// <summary>Si este tipo se guarda tal cual, sin convertir.</summary>
    public static bool EsImagen(string tipo) => TiposImagen.Contains(tipo);

    /// <summary>
    /// 20 MB. Declarado también en el conversor, y en los dos lugares a
    /// propósito: éste rechaza antes de leer el cuerpo, y aquél no puede confiar
    /// en que su único llamador valide.
    /// </summary>
    public const long MaximoBytes = 20 * 1024 * 1024;

    /// <summary>
    /// Cuánto puede pesar el instructivo de un proyecto: 32 KB.
    /// </summary>
    /// <remarks>
    /// Mucho menos que los 20 MB de un documento, y por una razón de fondo: un
    /// documento se copia al worktree y el agente lo abre si lo necesita, pero
    /// el instructivo entra en el system prompt de CADA turno. Cada KB se paga
    /// en tokens en todos los mensajes y empuja el contexto útil afuera.
    ///
    /// 32 KB son unas 8.000 palabras, así que un instructivo de pasos largo
    /// entra de sobra.
    ///
    /// Tiene que moverse junto con `TOPE_DE_INSTRUCCIONES` del gateway, que es
    /// la última capa antes del prompt y lo revalida.
    /// </remarks>
    public const long MaximoBytesInstruccion = 32 * 1024;

    /// <summary>
    /// El único tipo que se acepta como instructivo.
    /// </summary>
    /// <remarks>
    /// Sólo `.md` y no cualquier tipo que el conversor sepa leer: un PDF hay
    /// que convertirlo y la conversión puede fallar —un escaneo no tiene capa de
    /// texto—, y un instructivo obligatorio que a veces no está es peor que no
    /// tener la feature: el turno corre igual y nadie se entera de que faltaron
    /// los pasos. Un `.md` es texto y no hay conversión que pueda fallar.
    /// </remarks>
    public const string TipoDeInstruccion = "md";

    /// <summary>El tipo según la extensión, o null si no se sabe leer.</summary>
    public static string? TipoDe(string? nombreOriginal)
    {
        if (string.IsNullOrWhiteSpace(nombreOriginal)) return null;
        var ext = Path.GetExtension(nombreOriginal).TrimStart('.').ToLowerInvariant();
        return Tipos.Contains(ext) || TiposImagen.Contains(ext) ? ext : null;
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
    /// <summary>
    /// Una carpeta de Archivos: `a/b`, con letras (acentos incluidos),
    /// números, espacios y `._-()`. Sin `..`, sin barra al principio ni al
    /// final, hasta 150 caracteres. Vacía es la raíz.
    /// </summary>
    public static bool CarpetaValida(string? carpeta)
    {
        if (string.IsNullOrEmpty(carpeta)) return true;
        if (carpeta.Length > 150) return false;
        foreach (var seg in carpeta.Split('/'))
        {
            if (seg.Trim().Length == 0 || seg is "." or "..") return false;
            if (!seg.All(c => char.IsLetterOrDigit(c) || c is ' ' or '.' or '_' or '-' or '(' or ')')) return false;
        }
        return true;
    }

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
        //
        // El mapeo manual de abajo es la parte que de verdad hace el trabajo:
        // `Normalize(NormalizationForm.FormD)` depende de que el runtime tenga
        // datos de globalización (ICU) para descomponer "ó" en "o" + marca
        // combinante, y en un runtime sin ICU (modo invariante) la descomposición
        // no pasa y la letra acentuada llega intacta. El chequeo de
        // `NonSpacingMark` se deja como capa extra para cuando sí hay ICU.
        var limpio = new StringBuilder();
        foreach (var c in sinExt.Normalize(NormalizationForm.FormD))
        {
            if (CharUnicodeInfo.GetUnicodeCategory(c) == UnicodeCategory.NonSpacingMark) continue;
            var sinAcento = QuitarAcento(c);
            // LISTA BLANCA, no negra: lo que no está acá se convierte en guión.
            // Una lista negra deja pasar lo que nadie pensó, y esto arma una ruta.
            limpio.Append(char.IsAsciiLetterOrDigit(sinAcento) || sinAcento is '.' or '_' or '-' ? sinAcento : '-');
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

    /// <summary>
    /// La letra base de una vocal acentuada, ñ o ü en castellano. Cualquier
    /// otro carácter se devuelve igual.
    /// </summary>
    private static char QuitarAcento(char c) => c switch
    {
        'á' or 'à' or 'â' or 'ä' => 'a',
        'Á' or 'À' or 'Â' or 'Ä' => 'A',
        'é' or 'è' or 'ê' or 'ë' => 'e',
        'É' or 'È' or 'Ê' or 'Ë' => 'E',
        'í' or 'ì' or 'î' or 'ï' => 'i',
        'Í' or 'Ì' or 'Î' or 'Ï' => 'I',
        'ó' or 'ò' or 'ô' or 'ö' => 'o',
        'Ó' or 'Ò' or 'Ô' or 'Ö' => 'O',
        'ú' or 'ù' or 'û' or 'ü' => 'u',
        'Ú' or 'Ù' or 'Û' or 'Ü' => 'U',
        'ñ' => 'n',
        'Ñ' => 'N',
        _ => c,
    };

    [GeneratedRegex(@"^[A-Za-z0-9._-]+$")]
    private static partial Regex FormaDeNombre();

    [GeneratedRegex(@"-{2,}")]
    private static partial Regex GuionesRepetidos();
}
