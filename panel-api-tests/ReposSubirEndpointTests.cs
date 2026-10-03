using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using MultiCodigo.Panel;

namespace MultiCodigo.Panel.Tests;

/// <summary>
/// Subir archivos y crear carpetas en un repo desde Archivos.
///
/// Cada archivo es un commit; el repo se resuelve contra los del proyecto y
/// las referencias (solo lectura) no se tocan.
/// </summary>
public class ReposSubirEndpointTests(PanelFactory f) : IClassFixture<PanelFactory>
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
        f.Proyectos.Roles[Proyecto] = "dueño";
        f.Repos.Filas.Clear();
        f.Repos.Filas.Add(new Repo("front", "sincrosns/SincroResto-frontend"));
        f.Repos.Filas.Add(new Repo("referencia", "Sincro-arg/referencia-front", SoloLectura: true));
        f.Arbol.Subidos.Clear();
        f.Arbol.Falla = null;
    }

    private static MultipartFormDataContent Form(string carpeta, params (string Nombre, string Texto)[] archivos)
    {
        var form = new MultipartFormDataContent { { new StringContent(carpeta), "carpeta" } };
        foreach (var (nombre, texto) in archivos)
        {
            form.Add(new ByteArrayContent(System.Text.Encoding.UTF8.GetBytes(texto)), "archivos", nombre);
        }
        return form;
    }

    [Fact]
    public async Task SubeCadaArchivoComoCommitEnLaCarpeta()
    {
        Limpio();
        var r = await Cliente().PostAsync($"/api/proyectos/{Proyecto}/repos/front/archivos",
            Form("docs/specs", ("a.md", "hola"), ("b.txt", "chau")));

        Assert.Equal(HttpStatusCode.OK, r.StatusCode);
        Assert.Equal(["docs/specs/a.md", "docs/specs/b.txt"], f.Arbol.Subidos.Select(s => s.Ruta).ToArray());
        Assert.All(f.Arbol.Subidos, s => Assert.Equal("sincrosns/SincroResto-frontend", s.Repo));
        Assert.All(f.Arbol.Subidos, s => Assert.StartsWith("Subido desde el panel:", s.Mensaje));
    }

    [Fact]
    public async Task SinCarpetaVaALaRaiz()
    {
        Limpio();
        await Cliente().PostAsync($"/api/proyectos/{Proyecto}/repos/front/archivos", Form("", ("README.md", "x")));
        Assert.Equal("README.md", Assert.Single(f.Arbol.Subidos).Ruta);
    }

    [Fact]
    public async Task UnaReferenciaNoSeToca()
    {
        Limpio();
        var r = await Cliente().PostAsync($"/api/proyectos/{Proyecto}/repos/referencia/archivos", Form("", ("a.md", "x")));
        Assert.Equal(HttpStatusCode.Forbidden, r.StatusCode);
        Assert.Empty(f.Arbol.Subidos);
    }

    [Fact]
    public async Task UnaCarpetaConPuntosPuntosSeRechaza()
    {
        Limpio();
        var r = await Cliente().PostAsync($"/api/proyectos/{Proyecto}/repos/front/archivos", Form("../afuera", ("a.md", "x")));
        Assert.Equal(HttpStatusCode.BadRequest, r.StatusCode);
        Assert.Empty(f.Arbol.Subidos);
    }

    [Fact]
    public async Task UnRepoDeOtroProyectoDa404()
    {
        Limpio();
        var r = await Cliente().PostAsync($"/api/proyectos/{Proyecto}/repos/otro/archivos", Form("", ("a.md", "x")));
        Assert.Equal(HttpStatusCode.NotFound, r.StatusCode);
    }

    [Fact]
    public async Task UnProyectoAjenoDa403()
    {
        Limpio();
        var r = await Cliente().PostAsync($"/api/proyectos/{Ajeno}/repos/front/archivos", Form("", ("a.md", "x")));
        Assert.Equal(HttpStatusCode.Forbidden, r.StatusCode);
    }

    /// <summary>
    /// Un miembro puede vincular cualquier repo de la instalación; si pudiera
    /// escribir, escribiría en repos que no son del proyecto.
    /// </summary>
    [Fact]
    public async Task UnMiembroQueNoEsDuenioNoEscribe()
    {
        Limpio();
        f.Proyectos.Roles[Proyecto] = "miembro";
        var r = await Cliente().PostAsync($"/api/proyectos/{Proyecto}/repos/front/archivos", Form("", ("a.md", "x")));
        Assert.Equal(HttpStatusCode.Forbidden, r.StatusCode);
        var c = await Cliente().PostAsJsonAsync($"/api/proyectos/{Proyecto}/repos/front/carpetas", new { ruta = "x" });
        Assert.Equal(HttpStatusCode.Forbidden, c.StatusCode);
        Assert.Empty(f.Arbol.Subidos);
    }

    /// <summary>Un workflow de Actions corre con los secretos del repo: no se sube desde acá.</summary>
    [Theory]
    [InlineData(".github/workflows")]
    [InlineData(".GitHub")]
    [InlineData("src/.git")]
    public async Task NoSeEscribeEnGithubNiEnGit(string carpeta)
    {
        Limpio();
        var r = await Cliente().PostAsync($"/api/proyectos/{Proyecto}/repos/front/archivos", Form(carpeta, ("deploy.yml", "x")));
        Assert.Equal(HttpStatusCode.BadRequest, r.StatusCode);
        var c = await Cliente().PostAsJsonAsync($"/api/proyectos/{Proyecto}/repos/front/carpetas", new { ruta = carpeta });
        Assert.Equal(HttpStatusCode.BadRequest, c.StatusCode);
        Assert.Empty(f.Arbol.Subidos);
    }

    [Fact]
    public async Task LaCarpetaNuevaSeCreaConGitkeep()
    {
        Limpio();
        var r = await Cliente().PostAsJsonAsync($"/api/proyectos/{Proyecto}/repos/front/carpetas", new { ruta = "assets/img" });
        Assert.Equal(HttpStatusCode.OK, r.StatusCode);
        var s = Assert.Single(f.Arbol.Subidos);
        Assert.Equal("assets/img/.gitkeep", s.Ruta);
        Assert.Equal(0, s.Bytes);
    }

    [Fact]
    public async Task UnFalloDeGithubSeDiceArchivoPorArchivo()
    {
        Limpio();
        f.Arbol.Falla = "github_409";
        var r = await Cliente().PostAsync($"/api/proyectos/{Proyecto}/repos/front/archivos", Form("", ("a.md", "x")));
        Assert.Equal(HttpStatusCode.OK, r.StatusCode);
        var cuerpo = await r.Content.ReadAsStringAsync();
        Assert.Contains("github_409", cuerpo);
    }
}
