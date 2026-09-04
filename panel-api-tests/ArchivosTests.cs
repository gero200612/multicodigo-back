using System.IO.Compression;
using System.Net;
using System.Net.Http.Headers;
using MultiCodigo.Panel;

namespace MultiCodigo.Panel.Tests;

/// <summary>
/// Llevarse TODOS los documentos de un proyecto en un archivo.
///
/// Es la mitad de salida de la página de archivos: se genera, se descarga. Bajar
/// veinte documentos de a uno, cada uno con su clic, es la clase de tarea que
/// hace que la persona no los baje.
///
/// Ver el diseño en
/// <c>multicodigo-vm/docs/superpowers/specs/2026-09-04-documentos-generados-design.md</c>.
/// </summary>
public class ArchivosTests(PanelFactory f) : IClassFixture<PanelFactory>
{
    private const string Proyecto = "22222222-2222-4222-8222-222222222222";
    private const string Ajeno = "44444444-4444-4444-8444-444444444444";

    private HttpClient Cliente()
    {
        var c = f.CreateClient();
        c.DefaultRequestHeaders.Authorization =
            new AuthenticationHeaderValue("Bearer", AuthDePrueba.TokenValido);
        return c;
    }

    private void ConDocumentos(params Documento[] docs)
    {
        f.Proyectos.Mios[Proyecto] = "sentencias";
        f.Documentos.Filas.Clear();
        f.Documentos.Filas.AddRange(docs);
    }

    private static Documento Doc(string nombre, string tipo = "pdf", bool instructivo = false) =>
        new($"id-{nombre}", nombre, nombre, tipo, 100, null, instructivo);

    [Fact]
    public async Task TraeTodosLosDocumentosDelProyecto()
    {
        ConDocumentos(Doc("sentencia.pdf"), Doc("pliego.pdf"), Doc("precios.csv", "csv"));

        var r = await Cliente().GetAsync($"/api/proyectos/{Proyecto}/documentos.zip");

        Assert.Equal(HttpStatusCode.OK, r.StatusCode);
        using var zip = new ZipArchive(await r.Content.ReadAsStreamAsync(), ZipArchiveMode.Read);
        Assert.Equal(
            ["pliego.pdf", "precios.csv", "sentencia.pdf"],
            zip.Entries.Select(e => e.Name).OrderBy(n => n).ToArray());
    }

    /// <summary>
    /// El contenido de cada entrada es el del documento, no un archivo vacío.
    /// </summary>
    /// <remarks>
    /// Un ZIP con los nombres correctos y los archivos en blanco pasa cualquier
    /// chequeo de lista y se descubre recién al abrirlo.
    /// </remarks>
    [Fact]
    public async Task CadaEntradaTraeSuContenido()
    {
        ConDocumentos(Doc("sentencia.pdf"));

        var r = await Cliente().GetAsync($"/api/proyectos/{Proyecto}/documentos.zip");

        using var zip = new ZipArchive(await r.Content.ReadAsStreamAsync(), ZipArchiveMode.Read);
        using var lector = new StreamReader(zip.Entries[0].Open());
        // Es lo que devuelve el doble de `DescargarAsync`.
        Assert.Contains("sentencia.pdf", await lector.ReadToEndAsync());
    }

    /// <summary>
    /// EL test de este archivo: un proyecto ajeno no da nada.
    /// </summary>
    /// <remarks>
    /// Este endpoint junta VARIOS documentos en una respuesta, así que un error
    /// de membresía acá no filtra un archivo: filtra el proyecto entero.
    /// </remarks>
    [Fact]
    public async Task UnProyectoAjenoNoDaNada()
    {
        ConDocumentos(Doc("sentencia.pdf"));

        var r = await Cliente().GetAsync($"/api/proyectos/{Ajeno}/documentos.zip");

        Assert.Equal(HttpStatusCode.Forbidden, r.StatusCode);
    }

    [Fact]
    public async Task SinSesionNoDaNada()
    {
        ConDocumentos(Doc("sentencia.pdf"));

        var r = await f.CreateClient().GetAsync($"/api/proyectos/{Proyecto}/documentos.zip");

        Assert.Equal(HttpStatusCode.Unauthorized, r.StatusCode);
    }

    /// <summary>
    /// El instructivo NO entra: tiene su propia sección y su propio botón, y
    /// meterlo acá lo mostraría como un documento más de la lista.
    /// </summary>
    [Fact]
    public async Task ElInstructivoNoEntra()
    {
        ConDocumentos(Doc("sentencia.pdf"), Doc("pasos.md", "md", instructivo: true));

        var r = await Cliente().GetAsync($"/api/proyectos/{Proyecto}/documentos.zip");

        using var zip = new ZipArchive(await r.Content.ReadAsStreamAsync(), ZipArchiveMode.Read);
        Assert.Equal(["sentencia.pdf"], zip.Entries.Select(e => e.Name).ToArray());
    }

    /// <summary>
    /// Un proyecto sin documentos da un ZIP vacío y no un 404.
    /// </summary>
    /// <remarks>
    /// El botón se puede apretar antes de subir nada, y un error ahí haría
    /// pensar que algo se rompió en vez de que no hay nada que bajar.
    /// </remarks>
    [Fact]
    public async Task SinDocumentosDaUnZipVacio()
    {
        ConDocumentos();

        var r = await Cliente().GetAsync($"/api/proyectos/{Proyecto}/documentos.zip");

        Assert.Equal(HttpStatusCode.OK, r.StatusCode);
        using var zip = new ZipArchive(await r.Content.ReadAsStreamAsync(), ZipArchiveMode.Read);
        Assert.Empty(zip.Entries);
    }
}
