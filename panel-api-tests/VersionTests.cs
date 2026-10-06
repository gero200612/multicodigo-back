using System.Net;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Logging.Abstractions;
using MultiCodigo.Panel;

namespace MultiCodigo.Panel.Tests;

/// <summary>
/// El commit de la rama por defecto de un repo y cuánto se desvió una rama en
/// curso, para el tab "Versión".
///
/// Se testea con un handler falso, igual que <c>CrearRepoTests</c>: la
/// alternativa es comparar ramas de un repo de verdad, y eso necesitaría un
/// repo con un desfase fijo que no se mueva entre corridas.
/// </summary>
public class VersionTests
{
    private const string AppId = "123456";
    private const string Proyecto = "22222222-2222-4222-8222-222222222222";

    /// <summary>Contesta segun el PATH del pedido, para no depender del orden.</summary>
    private sealed class HandlerFalso(int aheadBy, int behindBy) : HttpMessageHandler
    {
        public List<string> Rutas { get; } = [];

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request, CancellationToken ct)
        {
            var path = request.RequestUri!.AbsolutePath;
            Rutas.Add(path);

            if (path.EndsWith("/access_tokens"))
            {
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.Created)
                {
                    Content = new StringContent(
                        """{"token":"ghs_falso","expires_at":"2099-01-01T00:00:00Z"}""",
                        Encoding.UTF8, "application/json"),
                });
            }
            if (path.Contains("/compare/"))
            {
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent(
                        $$"""{"ahead_by":{{aheadBy}},"behind_by":{{behindBy}}}""",
                        Encoding.UTF8, "application/json"),
                });
            }
            if (path.Contains("/commits/"))
            {
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent(
                        """
                        {
                            "sha": "abcdef1234567890",
                            "commit": { "message": "arregla el stock\n\ndetalle largo", "author": { "date": "2026-01-02T03:04:05Z" } },
                            "html_url": "https://github.com/sincrosns/stock/commit/abcdef1234567890"
                        }
                        """,
                        Encoding.UTF8, "application/json"),
                });
            }
            // GET /repos/{full}
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(
                    """{"default_branch":"main"}""", Encoding.UTF8, "application/json"),
            });
        }
    }

    private static (VersionClient Cliente, HandlerFalso H, InstalacionesFalso Inst) Armar(
        int aheadBy = 0, int behindBy = 0)
    {
        var rsa = RSA.Create(2048);
        var app = new GitHubApp(AppId, rsa.ExportPkcs8PrivateKeyPem(), () => DateTimeOffset.UtcNow);
        var gh = new AppDeGitHub(app, "mi-app");
        var h = new HandlerFalso(aheadBy, behindBy);
        var http = new HttpClient(h);
        var inst = new InstalacionesFalso { Fila = new Instalacion(159882934, "sincrosns") };
        return (
            new VersionClient(http, gh, inst, NullLogger<VersionClient>.Instance),
            h, inst);
    }

    [Fact]
    public async Task ElCaminoFeliz_UnaRamaDesfasadaQuedaMarcada()
    {
        var (cliente, _, _) = Armar(aheadBy: 3, behindBy: 2);

        var v = await cliente.VersionAsync(
            "jwt", Proyecto, "sincrosns/stock", "claude/c1/trabajo");

        Assert.Equal("main", v.DefaultBranch);
        Assert.Equal("abcdef1", v.Commit.Sha);
        Assert.Equal("arregla el stock", v.Commit.Mensaje);
        Assert.NotNull(v.Rama);
        Assert.Equal(3, v.Rama!.AheadBy);
        Assert.Equal(2, v.Rama.BehindBy);
        Assert.True(v.Rama.Desfasada);
        Assert.Equal(
            "https://github.com/sincrosns/stock/compare/main...claude/c1/trabajo",
            v.Rama.CompareUrl);
    }

    [Fact]
    public async Task UnaRamaSinAtrasoNoQuedaDesfasada()
    {
        var (cliente, _, _) = Armar(aheadBy: 1, behindBy: 0);

        var v = await cliente.VersionAsync("jwt", Proyecto, "sincrosns/stock", "claude/c1/trabajo");

        Assert.False(v.Rama!.Desfasada);
    }

    [Fact]
    public async Task SinRamaNoComparaNada()
    {
        var (cliente, h, _) = Armar();

        var v = await cliente.VersionAsync("jwt", Proyecto, "sincrosns/stock", null);

        Assert.Null(v.Rama);
        Assert.DoesNotContain(h.Rutas, r => r.Contains("/compare/"));
    }

    [Fact]
    public async Task SinInstalacionDaElCodigoSinSalirARed()
    {
        var (cliente, h, inst) = Armar();
        inst.Fila = null;

        var ex = await Assert.ThrowsAsync<UpstreamException>(
            () => cliente.VersionAsync("jwt", Proyecto, "sincrosns/stock", null));

        Assert.Equal("sin_instalacion", ex.Message);
        Assert.Empty(h.Rutas);
    }

    [Theory]
    [InlineData("claude/c1/trabajo")]
    [InlineData("main")]
    [InlineData("feature.rara-1")]
    public void AceptaUnNombreDeRamaNormal(string rama)
    {
        Assert.True(VersionClient.RamaValida(rama));
    }

    [Theory]
    [InlineData("rama con espacios")]
    [InlineData("")]
    [InlineData("ñandu")]
    public void RechazaUnNombreDeRamaInvalido(string rama)
    {
        Assert.False(VersionClient.RamaValida(rama));
    }
}
