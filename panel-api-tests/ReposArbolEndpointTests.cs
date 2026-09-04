using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using MultiCodigo.Panel;

namespace MultiCodigo.Panel.Tests;

/// <summary>
/// Ver los archivos de un repo desde el panel.
///
/// Sólo lectura: escribir en un repo es trabajo del agente, con aprobación y
/// commit, y un botón de guardar acá sería un camino que se saltea todo eso.
/// </summary>
public class ReposArbolEndpointTests(PanelFactory f) : IClassFixture<PanelFactory>
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

    /// <summary>Un proyecto mío con un repo vinculado.</summary>
    private void Limpio()
    {
        f.Proyectos.Mios[Proyecto] = "sincroresto";
        f.Repos.Filas.Clear();
        f.Repos.Filas.Add(new Repo("SincroResto-frontend", "sincrosns/SincroResto-frontend"));
        f.Arbol.Entradas.Clear();
        f.Arbol.Entradas.AddRange([
            new EntradaDeRepo("src", true, 0),
            new EntradaDeRepo("src/lote.ts", false, 420),
            new EntradaDeRepo("CLAUDE.md", false, 900),
        ]);
        f.Arbol.Pedidos.Clear();
    }

    [Fact]
    public async Task TraeElArbolDelRepoVinculado()
    {
        Limpio();

        var r = await Cliente().GetAsync(
            $"/api/proyectos/{Proyecto}/repos/SincroResto-frontend/arbol");

        Assert.Equal(HttpStatusCode.OK, r.StatusCode);
        var arbol = await r.Content.ReadFromJsonAsync<List<EntradaDeRepo>>();
        Assert.Equal(["src", "src/lote.ts", "CLAUDE.md"], arbol!.Select(e => e.Ruta).ToArray());
    }

    /// <summary>
    /// El repo se pide por su NOMBRE corto y el panel resuelve el full_name.
    /// </summary>
    /// <remarks>
    /// Es lo que impide pedir un repo por <c>owner/otro</c>: el nombre se busca
    /// en los repos del proyecto, y el <c>full_name</c> sale de esa fila.
    /// </remarks>
    [Fact]
    public async Task ResuelveElFullNameDeLaFilaDelProyecto()
    {
        Limpio();

        await Cliente().GetAsync($"/api/proyectos/{Proyecto}/repos/SincroResto-frontend/arbol");

        Assert.Equal("sincrosns/SincroResto-frontend", f.Arbol.Pedidos[^1]);
    }

    /// <summary>
    /// EL test de este archivo: un repo que no es de este proyecto no se lee.
    /// </summary>
    /// <remarks>
    /// La instalación de la App puede dar acceso a muchos repos —los de OTROS
    /// proyectos incluidos— así que si el nombre no se valida contra los repos
    /// de ESTE proyecto, cualquier miembro lee cualquier repo de la instalación.
    /// </remarks>
    [Fact]
    public async Task UnRepoQueNoEsDelProyectoNoSeLee()
    {
        Limpio();

        var r = await Cliente().GetAsync($"/api/proyectos/{Proyecto}/repos/otro-repo/arbol");

        Assert.Equal(HttpStatusCode.NotFound, r.StatusCode);
        // Y no llegó a pedirle nada a GitHub.
        Assert.Empty(f.Arbol.Pedidos);
    }

    [Fact]
    public async Task UnProyectoAjenoNoDaNada()
    {
        Limpio();

        var r = await Cliente().GetAsync(
            $"/api/proyectos/{Ajeno}/repos/SincroResto-frontend/arbol");

        Assert.Equal(HttpStatusCode.Forbidden, r.StatusCode);
        Assert.Empty(f.Arbol.Pedidos);
    }

    [Fact]
    public async Task SinSesionNoDaNada()
    {
        Limpio();

        var r = await f.CreateClient().GetAsync(
            $"/api/proyectos/{Proyecto}/repos/SincroResto-frontend/arbol");

        Assert.Equal(HttpStatusCode.Unauthorized, r.StatusCode);
    }

    /// <summary>
    /// Sin App instalada se dice, en vez de devolver un árbol vacío.
    /// </summary>
    /// <remarks>
    /// Un árbol vacío se leería como "el repo no tiene archivos", que es falso y
    /// no sugiere la acción que lo arregla: instalar la App.
    /// </remarks>
    [Fact]
    public async Task SinInstalacionLoDice()
    {
        Limpio();
        f.Arbol.Falla = "sin_instalacion";

        var r = await Cliente().GetAsync(
            $"/api/proyectos/{Proyecto}/repos/SincroResto-frontend/arbol");

        Assert.Equal(HttpStatusCode.Conflict, r.StatusCode);
        Assert.Contains("sin_instalacion", await r.Content.ReadAsStringAsync());
        f.Arbol.Falla = null;
    }

    // --- un archivo ---------------------------------------------------------

    [Fact]
    public async Task TraeUnArchivoDelRepo()
    {
        Limpio();

        var r = await Cliente().GetAsync(
            $"/api/proyectos/{Proyecto}/repos/SincroResto-frontend/archivo?ruta=CLAUDE.md");

        Assert.Equal(HttpStatusCode.OK, r.StatusCode);
        Assert.Contains("CLAUDE.md", await r.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task UnArchivoDeUnRepoAjenoNoSeLee()
    {
        Limpio();

        var r = await Cliente().GetAsync(
            $"/api/proyectos/{Proyecto}/repos/otro-repo/archivo?ruta=CLAUDE.md");

        Assert.Equal(HttpStatusCode.NotFound, r.StatusCode);
    }

    /// <summary>
    /// Una ruta que se escapa se rechaza acá, antes de llegar al cliente.
    /// </summary>
    [Theory]
    [InlineData("../otro/secreto.env")]
    [InlineData("/etc/passwd")]
    public async Task UnaRutaQueSeEscapaSeRechaza(string ruta)
    {
        Limpio();

        var r = await Cliente().GetAsync(
            $"/api/proyectos/{Proyecto}/repos/SincroResto-frontend/archivo" +
            $"?ruta={Uri.EscapeDataString(ruta)}");

        Assert.Equal(HttpStatusCode.BadRequest, r.StatusCode);
    }

    [Fact]
    public async Task SinRutaSeRechaza()
    {
        Limpio();

        var r = await Cliente().GetAsync(
            $"/api/proyectos/{Proyecto}/repos/SincroResto-frontend/archivo");

        Assert.Equal(HttpStatusCode.BadRequest, r.StatusCode);
    }
}
