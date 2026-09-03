using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using MultiCodigo.Panel;

namespace MultiCodigo.Panel.Tests;

/// <summary>
/// El instructivo que rige TODOS los turnos de un proyecto.
///
/// Un <c>.md</c> que se le agrega al system prompt de cada turno, con
/// precedencia declarada sobre las reglas de estilo fijas del agente. Es lo que
/// hace que un proyecto pueda exigir una serie de pasos —redactar una
/// sentencia, por ejemplo— en vez de que el instructivo sea un documento que el
/// modelo abre si se acuerda.
///
/// Ver el diseño en
/// <c>multicodigo-vm/docs/superpowers/specs/2026-09-03-instrucciones-de-proyecto-design.md</c>.
///
/// En su propio archivo y no en <c>EndpointTests</c> porque son la feature
/// entera vista desde la API: la sección de documentos de aquel archivo es otra
/// cosa, y estas pruebas se leen juntas.
/// </summary>
public class InstruccionesTests(PanelFactory f) : IClassFixture<PanelFactory>
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

    private static MultipartFormDataContent Archivo(string nombre, string contenido)
    {
        var bytes = new ByteArrayContent(System.Text.Encoding.UTF8.GetBytes(contenido));
        bytes.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");
        var form = new MultipartFormDataContent();
        form.Add(bytes, "archivo", nombre);
        return form;
    }

    /// <summary>Deja el proyecto como mío y sin documentos.</summary>
    private void Limpio()
    {
        f.Proyectos.Mios[Proyecto] = "sentencias";
        f.Documentos.Filas.Clear();
        f.Documentos.Borrados.Clear();
        f.Documentos.Subidos.Clear();
    }

    /// <summary>
    /// Se guarda con su marca y con su texto, sin pasar por el conversor.
    /// </summary>
    /// <remarks>
    /// Sin conversor porque un <c>.md</c> YA es texto: mandarlo a convertir
    /// dejaría un error anotado sobre un archivo que está perfecto. Y la marca
    /// es lo que hace que el gateway lo LEA para el system prompt en vez de sólo
    /// copiarlo al worktree — sin ella, esto es un documento más y la feature no
    /// existe.
    /// </remarks>
    [Fact]
    public async Task SeGuardaMarcadoYConSuTexto()
    {
        Limpio();

        var r = await Cliente().PostAsync(
            $"/api/proyectos/{Proyecto}/instrucciones",
            Archivo("pasos.md", "# Pasos. 1. Leer el expediente."));

        Assert.Equal(HttpStatusCode.OK, r.StatusCode);
        var subido = f.Documentos.Subidos[^1];
        Assert.Equal("pasos.md", subido.Nombre);
        Assert.Contains("Leer el expediente", subido.Texto);
        Assert.Null(subido.Error);
        Assert.True(f.Documentos.Filas[^1].EsInstruccion);
    }

    /// <summary>
    /// Sólo <c>.md</c>: un PDF hay que convertirlo y la conversión puede fallar
    /// —un escaneo no tiene capa de texto—, y un instructivo obligatorio que a
    /// veces no está es peor que no tener la feature.
    /// </summary>
    [Fact]
    public async Task RechazaLoQueNoEsMd()
    {
        Limpio();

        var r = await Cliente().PostAsync(
            $"/api/proyectos/{Proyecto}/instrucciones", Archivo("pasos.pdf", "%PDF-1.4"));

        Assert.Equal(HttpStatusCode.BadRequest, r.StatusCode);
        Assert.Empty(f.Documentos.Subidos);
    }

    /// <summary>
    /// El tope es de 32 KB y no de 20 MB, porque esto entra en el system prompt
    /// de CADA turno. El mensaje lleva el número: "es muy grande" sin decir
    /// cuánto obliga a adivinar qué recortar.
    /// </summary>
    [Fact]
    public async Task RechazaLoQuePasaElTopeYDiceElTamano()
    {
        Limpio();
        var enorme = new string('x', (int)Documentos.MaximoBytesInstruccion + 1);

        var r = await Cliente().PostAsync(
            $"/api/proyectos/{Proyecto}/instrucciones", Archivo("pasos.md", enorme));

        Assert.Equal(HttpStatusCode.BadRequest, r.StatusCode);
        Assert.Contains("32", await r.Content.ReadAsStringAsync());
        // Y no se guardó nada: un instructivo a medias es peor que ninguno.
        Assert.Empty(f.Documentos.Subidos);
    }

    /// <summary>
    /// A LO SUMO uno por proyecto: subir otro con distinto nombre reemplaza al
    /// que estaba.
    /// </summary>
    /// <remarks>
    /// Sin el borrado previo, el índice único parcial de la base rechaza el
    /// insert con un 23505 y la persona lee "no se pudieron guardar las
    /// instrucciones" sin ninguna pista de por qué.
    /// </remarks>
    [Fact]
    public async Task SubirOtroReemplazaAlQueEstaba()
    {
        Limpio();

        await Cliente().PostAsync(
            $"/api/proyectos/{Proyecto}/instrucciones", Archivo("viejo.md", "1. viejo"));
        await Cliente().PostAsync(
            $"/api/proyectos/{Proyecto}/instrucciones", Archivo("nuevo.md", "1. nuevo"));

        Assert.Contains("viejo.md", f.Documentos.Borrados);
        Assert.Single(f.Documentos.Filas, x => x.EsInstruccion);
    }

    /// <summary>
    /// Sin instructivo: 204 y no un 404.
    /// </summary>
    /// <remarks>
    /// "Este proyecto no tiene instructivo" es el estado normal de casi todos,
    /// no algo que falta. Un 404 haría que la pantalla muestre un error justo
    /// donde tiene que mostrar la zona de subida.
    /// </remarks>
    [Fact]
    public async Task SinInstructivoDevuelve204()
    {
        Limpio();

        var r = await Cliente().GetAsync($"/api/proyectos/{Proyecto}/instrucciones");

        Assert.Equal(HttpStatusCode.NoContent, r.StatusCode);
    }

    /// <summary>
    /// No aparece en la lista de documentos: tiene su propia sección, y verlo
    /// dos veces haría creer que son dos archivos.
    /// </summary>
    [Fact]
    public async Task NoApareceEnLaListaDeDocumentos()
    {
        Limpio();
        await Cliente().PostAsync(
            $"/api/proyectos/{Proyecto}/instrucciones", Archivo("pasos.md", "1. leer"));

        var docs = await Cliente().GetFromJsonAsync<List<Documento>>(
            $"/api/proyectos/{Proyecto}/documentos");

        Assert.Empty(docs!);
    }

    /// <summary>Y sí aparece en el suyo, que es de donde lo lee la pantalla.</summary>
    [Fact]
    public async Task SiApareceEnSuPropioEndpoint()
    {
        Limpio();
        await Cliente().PostAsync(
            $"/api/proyectos/{Proyecto}/instrucciones", Archivo("pasos.md", "1. leer"));

        var doc = await Cliente().GetFromJsonAsync<Documento>(
            $"/api/proyectos/{Proyecto}/instrucciones");

        Assert.Equal("pasos.md", doc!.Nombre);
        Assert.True(doc.EsInstruccion);
    }

    /// <summary>Quitar dos veces no es un error: la segunda ya está hecho.</summary>
    [Fact]
    public async Task QuitarDosVecesNoEsUnError()
    {
        Limpio();
        await Cliente().PostAsync(
            $"/api/proyectos/{Proyecto}/instrucciones", Archivo("pasos.md", "1. leer"));

        var primera = await Cliente().DeleteAsync($"/api/proyectos/{Proyecto}/instrucciones");
        var segunda = await Cliente().DeleteAsync($"/api/proyectos/{Proyecto}/instrucciones");

        Assert.Equal(HttpStatusCode.NoContent, primera.StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, segunda.StatusCode);
    }

    /// <summary>
    /// El instructivo de un proyecto ajeno no se lee, ni se escribe, ni se
    /// borra. Es la misma puerta que los documentos y los repos: la membresía.
    /// </summary>
    [Fact]
    public async Task ElDeUnProyectoAjenoEstaProhibido()
    {
        var get = await Cliente().GetAsync($"/api/proyectos/{Ajeno}/instrucciones");
        var post = await Cliente().PostAsync(
            $"/api/proyectos/{Ajeno}/instrucciones", Archivo("pasos.md", "1. leer"));
        var del = await Cliente().DeleteAsync($"/api/proyectos/{Ajeno}/instrucciones");

        Assert.Equal(HttpStatusCode.Forbidden, get.StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, post.StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, del.StatusCode);
    }

    /// <summary>
    /// Y viaja al turno con su marca, que es el punto de todo esto: de ahí el
    /// bridge lo separa y el gateway lee su texto para el prompt.
    /// </summary>
    [Fact]
    public async Task ViajaAlTurnoConSuMarca()
    {
        Limpio();
        f.Documentos.ParaTurno.Clear();
        f.Documentos.ParaTurno.Add(
            new DocumentoDelTurno("pliego.pdf", "p/pliego.pdf", "p/pliego.pdf.md"));
        f.Documentos.ParaTurno.Add(
            new DocumentoDelTurno("pasos.md", "p/pasos.md", "p/pasos.md", true));

        var docs = await f.Documentos.ParaElTurnoAsync("jwt", Proyecto);

        var instructivo = Assert.Single(docs, d => d.EsInstruccion);
        Assert.Equal("pasos.md", instructivo.Nombre);
    }
}
