using System.Net;
using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using MultiCodigo.Panel;

namespace MultiCodigo.Panel.Tests;

/// <summary>
/// Que las filas de PostgREST se lean de verdad.
///
/// Este archivo existe por un bug que ningún test con dobles podía atrapar: los
/// dobles devuelven objetos ya armados, así que nunca ejercitan la
/// deserialización. Y la deserialización fallaba en silencio.
///
/// PostgREST devuelve los nombres de las COLUMNAS (`installation_id`), y las
/// opciones por defecto del panel son camelCase (`installationId`).
/// System.Text.Json no encuentra la propiedad, <b>no avisa</b>, y la deja en su
/// valor por defecto: un `long` en 0, un `string` en null.
///
/// El síntoma quedaba tres capas más abajo de la causa: el panel pedía un token
/// para la instalación 0, GitHub contestaba 404, y la pantalla decía "ningún
/// repo vinculado".
///
/// Lo que lo hacía peor: las columnas de UNA palabra sí funcionan (`cuenta`,
/// `nombre`, `slot`), así que el bug aparecía sólo en algunas y parecía otra
/// cosa.
/// </summary>
public class PostgrestTests
{
    /// <summary>Un HttpClient que contesta siempre el mismo JSON, como PostgREST.</summary>
    private static HttpClient Contestando(string json)
    {
        var handler = new HandlerFalso(json);
        return new HttpClient(handler) { BaseAddress = new Uri("https://proyecto.supabase.co") };
    }

    private sealed class HandlerFalso(string json) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request, CancellationToken ct)
            => Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(json, System.Text.Encoding.UTF8, "application/json"),
            });
    }

    [Fact]
    public async Task ElInstallationIdDeLaAppSeLee()
    {
        // Exactamente lo que devuelve PostgREST para github_instalaciones.
        var http = Contestando("""[{"installation_id":158312806,"cuenta":"sincrosns"}]""");
        var cliente = new InstalacionesClient(http, "anon", NullLogger<InstalacionesClient>.Instance);

        var inst = await cliente.DeProyectoAsync("jwt", "22222222-2222-4222-8222-222222222222");

        Assert.NotNull(inst);
        // El 0 es el bug: sin la política snake_case, esto era 0 y el panel pedía
        // un token para la instalación 0.
        Assert.Equal(158312806L, inst!.InstallationId);
        Assert.Equal("sincrosns", inst.Cuenta);
    }

    [Fact]
    public async Task ElGithubRepoDeUnRepoSeLee()
    {
        var http = Contestando("""[{"nombre":"front","github_repo":"gero/front"}]""");
        var cliente = new ReposClient(http, "anon", NullLogger<ReposClient>.Instance);

        var repos = await cliente.DeProyectoAsync("jwt", "22222222-2222-4222-8222-222222222222");

        var r = Assert.Single(repos);
        Assert.Equal("front", r.Nombre);
        // Sin esto, `github_repo` quedaba en null y el turno viajaba al gateway
        // con un repo sin origen — que zod rechaza con 400 "repos invalidos".
        Assert.Equal("gero/front", r.GithubRepo);
    }

    [Fact]
    public async Task ElProyectoIdDeUnSlotSeLee()
    {
        var http = Contestando(
            """[{"slot":"c1","proyecto_id":"22222222-2222-4222-8222-222222222222"}]""");
        var cliente = new AgentesClient(http, "anon", NullLogger<AgentesClient>.Instance);

        var porSlot = await cliente.ProyectosPorSlotAsync("jwt");

        // Sin esto quedaba en null y el botón de probar del dashboard aparecía
        // deshabilitado, sin decir por qué.
        Assert.Equal("22222222-2222-4222-8222-222222222222", porSlot["c1"]);
    }

    /// <summary>
    /// El guard de toda esta clase de bug.
    ///
    /// Si alguien vuelve a poner `Json.Opciones` en una lectura de PostgREST, o
    /// agrega una columna con underscore a un record que no la declara, este test
    /// no lo atrapa — pero sí deja escrito qué política hay que usar y por qué.
    /// </summary>
    [Fact]
    public void LaPoliticaDeSupabaseEsSnakeCase()
    {
        Assert.Equal(JsonNamingPolicy.SnakeCaseLower, Json.Supabase.PropertyNamingPolicy);
        // Y la general sigue siendo camelCase: es lo que consume el front.
        Assert.NotEqual(JsonNamingPolicy.SnakeCaseLower, Json.Opciones.PropertyNamingPolicy);
    }
}
