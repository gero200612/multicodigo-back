using MultiCodigo.Panel;

namespace MultiCodigo.Panel.Tests;

/// <summary>
/// Las reglas de nombre y tipo de un documento.
///
/// Esto es lo que protege el disco del servidor: el nombre que sale de acá arma
/// una ruta en <c>/srv/work/&lt;slot&gt;/&lt;proyecto&gt;/_docs/</c>, y el nombre
/// que entra lo eligió quien subió el archivo.
/// </summary>
public class DocumentosTests
{
    // --- el nombre para el disco --------------------------------------------

    [Theory]
    [InlineData("pliego.pdf", "pliego.pdf")]
    [InlineData("Precios 2026.xlsx", "Precios-2026.xlsx")]
    [InlineData("especificación técnica.docx", "especificacion-tecnica.docx")]
    [InlineData("informe (final).pdf", "informe-final.pdf")]
    public void DerivaUnNombreUsableDelOriginal(string original, string esperado)
    {
        Assert.Equal(esperado, Documentos.NombreDeArchivo(original, Documentos.TipoDe(original)!));
    }

    /// <summary>
    /// EL test de este archivo.
    ///
    /// El nombre arma una ruta en disco. Un <c>../</c> escribe fuera de
    /// <c>/srv/work</c>, y el nombre lo eligió quien subió el archivo — que
    /// puede no ser quien administra el servidor.
    /// </summary>
    [Theory]
    [InlineData("../../etc/passwd.pdf")]
    [InlineData("..\\..\\windows\\system32.pdf")]
    [InlineData("/etc/shadow.pdf")]
    [InlineData("....//....//x.pdf")]
    [InlineData("a/b/c.pdf")]
    public void NuncaDejaSalirDelDirectorio(string malicioso)
    {
        var nombre = Documentos.NombreDeArchivo(malicioso, "pdf");

        Assert.DoesNotContain("/", nombre);
        Assert.DoesNotContain("\\", nombre);
        Assert.DoesNotContain("..", nombre);
        // Y lo que sale tiene que pasar la validación que usan los endpoints:
        // las dos reglas no pueden divergir.
        Assert.True(Documentos.NombreValido(nombre), $"'{nombre}' no pasa NombreValido");
    }

    [Fact]
    public void UnNombreQueQuedaVacioNoRompe()
    {
        // "…" son todos caracteres que se descartan: el resultado no puede ser
        // una cadena vacía, que armaría la ruta del directorio en vez de un
        // archivo.
        var nombre = Documentos.NombreDeArchivo("…….pdf", "pdf");

        Assert.True(nombre.Length > 4);
        Assert.EndsWith(".pdf", nombre);
        Assert.True(Documentos.NombreValido(nombre));
    }

    [Fact]
    public void ConservaLaExtensionAunqueElOriginalNoLaTenga()
    {
        // El gateway y el agente usan la extensión para saber qué es. Un archivo
        // sin ella se ve como texto y el agente intenta leer el binario.
        Assert.EndsWith(".pdf", Documentos.NombreDeArchivo("pliego", "pdf"));
    }

    [Fact]
    public void NoDuplicaLaExtensionSiYaEstaba()
    {
        Assert.Equal("pliego.pdf", Documentos.NombreDeArchivo("pliego.pdf", "pdf"));
    }

    // --- la validación de los endpoints -------------------------------------

    [Theory]
    [InlineData("pliego.pdf")]
    [InlineData("precios-2026.xlsx")]
    [InlineData("a_b.c.md")]
    public void AceptaNombresBienFormados(string nombre)
    {
        Assert.True(Documentos.NombreValido(nombre));
    }

    [Theory]
    [InlineData("../x.pdf")]
    [InlineData("a/b.pdf")]
    [InlineData("a\\b.pdf")]
    [InlineData("..")]
    [InlineData(".")]
    [InlineData("")]
    [InlineData(null)]
    [InlineData("con espacio.pdf")]
    public void RechazaNombresQueNoPuedeManejar(string? nombre)
    {
        Assert.False(Documentos.NombreValido(nombre));
    }

    // --- el tipo ------------------------------------------------------------

    [Theory]
    [InlineData("x.pdf", "pdf")]
    [InlineData("x.PDF", "pdf")]
    [InlineData("x.xlsx", "xlsx")]
    [InlineData("x.docx", "docx")]
    [InlineData("x.csv", "csv")]
    [InlineData("x.md", "md")]
    [InlineData("x.txt", "txt")]
    public void ReconoceLosTiposQueSabeLeer(string archivo, string esperado)
    {
        Assert.Equal(esperado, Documentos.TipoDe(archivo));
    }

    [Theory]
    [InlineData("x.zip")]
    [InlineData("x.exe")]
    [InlineData("x.doc")]   // el viejo de Word, que es otro formato
    [InlineData("x.xls")]   // idem Excel
    [InlineData("sin-extension")]
    [InlineData("")]
    public void NoInventaUnTipoQueNoSabeLeer(string archivo)
    {
        // Null y no un tipo por defecto: el endpoint contesta "no sé leer ese
        // tipo" con la lista, y eso es mejor que aceptar el archivo y guardarlo
        // sin poder convertirlo nunca.
        Assert.Null(Documentos.TipoDe(archivo));
    }
}
