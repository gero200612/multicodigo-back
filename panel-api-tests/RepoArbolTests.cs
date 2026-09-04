using System.Text.Json;
using MultiCodigo.Panel;

namespace MultiCodigo.Panel.Tests;

/// <summary>
/// Los archivos de un repo, como los ve la pantalla.
///
/// Se testea el filtrado, el orden y la validación de rutas, y no la llamada
/// HTTP: es el mismo criterio con el que se testea el JWT de
/// <see cref="GitHubApp"/> — lo que puede salir mal acá se verifica entero sin
/// red.
/// </summary>
public class RepoArbolTests
{
    private static JsonElement Json(string texto) =>
        JsonDocument.Parse(texto).RootElement.Clone();

    [Fact]
    public void SeparaArchivosDeCarpetas()
    {
        var arbol = RepoArbolClient.DeJson(Json("""
        { "tree": [
            { "path": "src", "type": "tree" },
            { "path": "src/lote.ts", "type": "blob", "size": 420 },
            { "path": "README.md", "type": "blob", "size": 100 }
        ] }
        """));

        Assert.Equal(3, arbol.Count);
        var carpeta = arbol.Single(e => e.Ruta == "src");
        Assert.True(carpeta.EsCarpeta);
        var archivo = arbol.Single(e => e.Ruta == "src/lote.ts");
        Assert.False(archivo.EsCarpeta);
        Assert.Equal(420, archivo.Bytes);
    }

    /// <summary>
    /// Un submódulo no entra.
    /// </summary>
    /// <remarks>
    /// Un <c>commit</c> apunta a OTRO repo. Mostrarlo como carpeta daría una que
    /// al abrirla está vacía para siempre, sin ninguna explicación.
    /// </remarks>
    [Fact]
    public void UnSubmoduloNoEntra()
    {
        var arbol = RepoArbolClient.DeJson(Json("""
        { "tree": [
            { "path": "vendor/libreria", "type": "commit" },
            { "path": "README.md", "type": "blob", "size": 1 }
        ] }
        """));

        Assert.Equal(["README.md"], arbol.Select(e => e.Ruta).ToArray());
    }

    /// <summary>
    /// Ordenado por ruta, porque GitHub los devuelve en orden de árbol.
    /// </summary>
    /// <remarks>
    /// Ese orden mezcla niveles, así que la pantalla no puede armar la jerarquía
    /// sin reordenar igual.
    /// </remarks>
    [Fact]
    public void VieneOrdenadoPorRuta()
    {
        var arbol = RepoArbolClient.DeJson(Json("""
        { "tree": [
            { "path": "z.md", "type": "blob" },
            { "path": "a/b.ts", "type": "blob" },
            { "path": "a", "type": "tree" }
        ] }
        """));

        Assert.Equal(["a", "a/b.ts", "z.md"], arbol.Select(e => e.Ruta).ToArray());
    }

    [Fact]
    public void UnArbolSinNadaNoExplota()
    {
        Assert.Empty(RepoArbolClient.DeJson(Json("{}")));
        Assert.Empty(RepoArbolClient.DeJson(Json("""{ "tree": [] }""")));
    }

    /// <summary>
    /// Un repo enorme se corta.
    /// </summary>
    /// <remarks>
    /// Una lista de cinco mil archivos en una pantalla no se puede usar, y
    /// mandarle megas de JSON al navegador para que muestre un scroll infinito
    /// es peor que decir que hay más.
    /// </remarks>
    [Fact]
    public void CortaUnRepoEnorme()
    {
        var entradas = string.Join(",", Enumerable.Range(0, 3000)
            .Select(i => $"{{ \"path\": \"f{i:D5}.ts\", \"type\": \"blob\" }}"));

        var arbol = RepoArbolClient.DeJson(Json($"{{ \"tree\": [{entradas}] }}"));

        Assert.Equal(RepoArbolClient.MaximoEntradas, arbol.Count);
    }

    // --- la ruta que pide el cliente ----------------------------------------

    [Theory]
    [InlineData("src/lote.ts")]
    [InlineData("README.md")]
    [InlineData("docs/superpowers/specs/a-b.md")]
    public void AceptaUnaRutaNormal(string ruta)
    {
        Assert.True(RepoArbolClient.RutaValida(ruta));
    }

    /// <summary>
    /// EL test de este archivo.
    /// </summary>
    /// <remarks>
    /// La ruta viene del cliente y entra en una URL de la API de GitHub. GitHub
    /// probablemente la normalice; este chequeo existe igual por lo mismo que
    /// <c>RutaSegura</c> en los documentos — no depender de que el otro lado lo
    /// haga bien.
    /// </remarks>
    [Theory]
    [InlineData("../otro-repo/secreto.env")]
    [InlineData("src/../../etc/passwd")]
    [InlineData("/etc/shadow")]
    [InlineData("..")]
    [InlineData("src\\lote.ts")]
    [InlineData("src//lote.ts")]
    [InlineData("./oculto")]
    [InlineData("")]
    [InlineData(null)]
    public void RechazaUnaRutaQueSeEscapa(string? ruta)
    {
        Assert.False(RepoArbolClient.RutaValida(ruta));
    }
}
