using System.Net;
using MultiCodigo.Panel;

namespace MultiCodigo.Panel.Tests;

/// <summary>
/// Que el panel lea del gateway quién está trabajando.
///
/// Con un doble no se prueba: el bug posible es de deserialización, y el
/// gateway manda `ocupado` solo cuando alguien tiene el slot tomado.
/// </summary>
public class GatewayAgentesTests
{
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
    public async Task ConOcupadoEstaTrabajandoYSinOcupadoNo()
    {
        // Exactamente lo que contesta GET /agents del gateway.
        var json = """
            {"agents":[
              {"id":"c1","proyecto":"sincro","estado":"corriendo","arriba":true,"cuenta":true},
              {"id":"c2","proyecto":"sincro","estado":"corriendo","arriba":true,"cuenta":true,
               "ocupado":{"usuarioId":"6bbd04b2-68b6-4521-a310-3f8e3f0531ad","desde":1791224567046}},
              {"id":"c3","proyecto":"x","estado":"apagado","arriba":false,"cuenta":false}
            ]}
            """;
        var http = new HttpClient(new HandlerFalso(json)) { BaseAddress = new Uri("http://gateway:8080") };

        var agentes = await new GatewayClient(http).AgentesAsync();

        Assert.False(agentes.Single(a => a.Id == "c1").Trabajando);
        Assert.True(agentes.Single(a => a.Id == "c2").Trabajando);
        Assert.False(agentes.Single(a => a.Id == "c3").Trabajando);
    }
}
