using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using MultiCodigo.Panel;

namespace MultiCodigo.Panel.Tests;

/// <summary>
/// El tab "Versión": el commit de la rama por defecto de cada repo y el
/// desfase de las ramas en curso.
/// </summary>
public class VersionEndpointTests(PanelFactory f) : IClassFixture<PanelFactory>
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

    private void Limpio()
    {
        f.Proyectos.Mios[Proyecto] = "sincroresto";
        f.Repos.Filas.Clear();
        f.Repos.Filas.Add(new Repo("SincroResto-frontend", "sincrosns/SincroResto-frontend"));
        f.Version.Pedidos.Clear();
        f.Version.Falla = null;
        f.Version.Resultado = new VersionDeRepo(
            "main",
            new CommitDeRepo("abc1234", "arregla el stock", "2026-01-02T03:04:05Z",
                "https://github.com/sincrosns/SincroResto-frontend/commit/abc1234"),
            new RamaComparada("claude/c1/trabajo", 1, 2, true,
                "https://github.com/sincrosns/SincroResto-frontend/compare/main...claude/c1/trabajo"));
    }

    [Fact]
    public async Task TraeLaVersionDelRepoVinculado()
    {
        Limpio();

        var r = await Cliente().GetAsync(
            $"/api/proyectos/{Proyecto}/repos/SincroResto-frontend/version?rama=claude/c1/trabajo");

        Assert.Equal(HttpStatusCode.OK, r.StatusCode);
        var texto = await r.Content.ReadAsStringAsync();
        Assert.Contains("\"defaultBranch\":\"main\"", texto);
        Assert.Contains("\"aheadBy\":1", texto);
        Assert.Contains("\"behindBy\":2", texto);
        Assert.Contains("\"desfasada\":true", texto);
        Assert.Equal("sincrosns/SincroResto-frontend", f.Version.Pedidos[^1]);
    }

    /// <summary>
    /// Sin rama pedida, el campo se omite — mismo criterio que el resto del
    /// panel: los opcionales ausentes no viajan como `null` explícito.
    /// </summary>
    [Fact]
    public async Task SinRamaNoHayComparacion()
    {
        Limpio();
        f.Version.Resultado = f.Version.Resultado with { Rama = null };

        var r = await Cliente().GetAsync(
            $"/api/proyectos/{Proyecto}/repos/SincroResto-frontend/version");

        Assert.Equal(HttpStatusCode.OK, r.StatusCode);
        var texto = await r.Content.ReadAsStringAsync();
        Assert.DoesNotContain("\"rama\"", texto);
        Assert.Contains("\"defaultBranch\":\"main\"", texto);
    }

    /// <summary>Un repo que no es de este proyecto no se lee.</summary>
    [Fact]
    public async Task UnRepoQueNoEsDelProyectoDa404()
    {
        Limpio();

        var r = await Cliente().GetAsync($"/api/proyectos/{Proyecto}/repos/otro-repo/version");

        Assert.Equal(HttpStatusCode.NotFound, r.StatusCode);
        Assert.Empty(f.Version.Pedidos);
    }

    [Fact]
    public async Task UnProyectoAjenoDa403()
    {
        Limpio();

        var r = await Cliente().GetAsync(
            $"/api/proyectos/{Ajeno}/repos/SincroResto-frontend/version");

        Assert.Equal(HttpStatusCode.Forbidden, r.StatusCode);
        Assert.Empty(f.Version.Pedidos);
    }

    [Fact]
    public async Task SinSesionDa401()
    {
        Limpio();

        var r = await f.CreateClient().GetAsync(
            $"/api/proyectos/{Proyecto}/repos/SincroResto-frontend/version");

        Assert.Equal(HttpStatusCode.Unauthorized, r.StatusCode);
    }

    [Theory]
    [InlineData("rama con espacios")]
    [InlineData("ñandu")]
    public async Task UnaRamaInvalidaDa400YNoLlegaAlCliente(string rama)
    {
        Limpio();

        var r = await Cliente().GetAsync(
            $"/api/proyectos/{Proyecto}/repos/SincroResto-frontend/version"
            + $"?rama={Uri.EscapeDataString(rama)}");

        Assert.Equal(HttpStatusCode.BadRequest, r.StatusCode);
        Assert.Contains("rama_invalida", await r.Content.ReadAsStringAsync());
        Assert.Empty(f.Version.Pedidos);
    }

    /// <summary>
    /// Sin instalación se dice, en vez de devolver una versión vacía — mismo
    /// criterio que /arbol.
    /// </summary>
    [Fact]
    public async Task SinInstalacionLoDice()
    {
        Limpio();
        f.Version.Falla = "sin_instalacion";

        var r = await Cliente().GetAsync(
            $"/api/proyectos/{Proyecto}/repos/SincroResto-frontend/version");

        Assert.Equal(HttpStatusCode.Conflict, r.StatusCode);
        Assert.Contains("sin_instalacion", await r.Content.ReadAsStringAsync());
    }
}
