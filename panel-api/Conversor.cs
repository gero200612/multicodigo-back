using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json.Serialization;

namespace MultiCodigo.Panel;

/// <summary>El resultado de convertir un documento: el texto, o por qué no se pudo.</summary>
/// <param name="Texto">El Markdown, o null si no se pudo convertir.</param>
/// <param name="Error">El mensaje para el usuario, o null si salió bien.</param>
public sealed record Conversion(string? Texto, string? Error);

/// <summary>
/// El conversor de documentos, que corre en su propio contenedor.
///
/// Aparte del panel a propósito: parsear formatos binarios de terceros es una
/// superficie de ataque clásica, y el panel es el único proceso expuesto a
/// internet. Ver <c>src/conversor/</c> en el repo de la VM.
/// </summary>
public interface IConversorClient
{
    Task<Conversion> ConvertirAsync(
        byte[] datos, string tipo, CancellationToken ct = default);
}

public sealed class ConversorClient(HttpClient http, ILogger<ConversorClient> log) : IConversorClient
{
    private sealed record RespuestaOk([property: JsonPropertyName("texto")] string Texto);
    private sealed record RespuestaError([property: JsonPropertyName("message")] string? Message);

    public async Task<Conversion> ConvertirAsync(
        byte[] datos, string tipo, CancellationToken ct = default)
    {
        try
        {
            var req = new HttpRequestMessage(HttpMethod.Post, $"/convertir?tipo={tipo}")
            {
                Content = new ByteArrayContent(datos),
            };
            req.Content.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");

            var res = await http.SendAsync(req, ct);

            // 422 es "este documento no se puede leer" y NO un fallo del
            // servicio: el mensaje lo escribió el conversor para el usuario y va
            // tal cual. Colapsarlo con el 500 haría que un PDF escaneado se
            // reintente para siempre.
            if (res.StatusCode == HttpStatusCode.UnprocessableEntity)
            {
                var e = await res.Content.ReadFromJsonAsync<RespuestaError>(Json.Opciones, ct);
                return new Conversion(null, e?.Message ?? "no se pudo leer el documento");
            }

            if (!res.IsSuccessStatusCode)
            {
                log.LogWarning("el conversor respondio {Status}", (int)res.StatusCode);
                return new Conversion(null, "no se pudo convertir el documento; probá de nuevo");
            }

            var cuerpo = await res.Content.ReadFromJsonAsync<RespuestaOk>(Json.Opciones, ct);
            return cuerpo is null
                ? new Conversion(null, "el conversor devolvió una respuesta vacía")
                : new Conversion(cuerpo.Texto, null);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
        {
            // El documento se guarda igual, sin texto: el original se puede
            // descargar y la conversión se puede reintentar, que es mejor que
            // perder el archivo que la persona ya subió.
            log.LogWarning(ex, "no se pudo hablar con el conversor");
            return new Conversion(null, "el conversor no está disponible; el documento se guardó sin convertir");
        }
    }
}

/// <summary>
/// El conversor que no está configurado.
///
/// Existe para que el panel arranque sin `CONVERSOR_URL`: subir un documento
/// sigue funcionando y se guarda sin texto, con un mensaje que lo dice. Es el
/// mismo criterio que la GitHub App —las variables son opcionales y sin ellas se
/// degrada en vez de romper.
/// </summary>
public sealed class SinConversor : IConversorClient
{
    public Task<Conversion> ConvertirAsync(byte[] datos, string tipo, CancellationToken ct = default)
        => Task.FromResult(new Conversion(
            null, "este servidor no tiene el conversor configurado; el documento se guardó sin convertir"));
}
