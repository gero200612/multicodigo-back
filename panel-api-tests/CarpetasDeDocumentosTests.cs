using System.Net;
using System.Net.Http.Headers;
using MultiCodigo.Panel;

namespace MultiCodigo.Panel.Tests;

/// <summary>
/// Las carpetas de Archivos para los documentos del proyecto.
///
/// Son solo organización: la carpeta es una columna, el disco sigue plano. Lo
/// que se valida es que no se pueda armar algo raro con el nombre.
/// </summary>
public class CarpetasDeDocumentosTests(PanelFactory f) : IClassFixture<PanelFactory>
{
    private const string Proyecto = "22222222-2222-4222-8222-222222222222";

    [Theory]
    [InlineData("")]
    [InlineData("Análisis funcional (sincroresto)")]
    [InlineData("cliente/fotos 2026")]
    [InlineData("pliegos_v2.final")]
    public void AceptaCarpetasNormales(string carpeta) => Assert.True(Documentos.CarpetaValida(carpeta));

    [Theory]
    [InlineData("../afuera")]
    [InlineData("a//b")]
    [InlineData("a/./b")]
    [InlineData("a\\b")]
    [InlineData("a/<script>")]
    [InlineData(" ")]
    public void RechazaCarpetasRaras(string carpeta) => Assert.False(Documentos.CarpetaValida(carpeta));

    [Fact]
    public void RechazaCarpetasMuyLargas() => Assert.False(Documentos.CarpetaValida(new string('a', 151)));

    private HttpClient Cliente()
    {
        var c = f.CreateClient();
        c.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", AuthDePrueba.TokenValido);
        return c;
    }

    private static MultipartFormDataContent Form(string carpeta)
    {
        var form = new MultipartFormDataContent { { new StringContent(carpeta), "carpeta" } };
        form.Add(new ByteArrayContent(System.Text.Encoding.UTF8.GetBytes("hola")), "archivo", "notas.txt");
        return form;
    }

    [Fact]
    public async Task ElDocumentoQuedaEnLaCarpeta()
    {
        f.Proyectos.Mios[Proyecto] = "sincroresto";
        f.Documentos.Filas.Clear();
        var r = await Cliente().PostAsync($"/api/proyectos/{Proyecto}/documentos", Form("cliente/fotos"));
        Assert.Equal(HttpStatusCode.OK, r.StatusCode);
        Assert.Equal("cliente/fotos", Assert.Single(f.Documentos.Filas).Carpeta);
    }

    [Fact]
    public async Task UnaCarpetaInvalidaNoSeGuarda()
    {
        f.Proyectos.Mios[Proyecto] = "sincroresto";
        f.Documentos.Filas.Clear();
        var r = await Cliente().PostAsync($"/api/proyectos/{Proyecto}/documentos", Form("../afuera"));
        Assert.Equal(HttpStatusCode.BadRequest, r.StatusCode);
        Assert.Empty(f.Documentos.Filas);
    }
}
