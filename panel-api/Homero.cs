using System.Text;

namespace MultiCodigo.Panel;

/// <summary>
/// La respuesta de Homero tal cual: el panel no la interpreta, la reenvía.
/// Casi todo es JSON; una imagen (la de un anuncio) viene en `Binario` con su
/// `Tipo`, porque leída como texto llega rota.
/// </summary>
public sealed record RespuestaDeHomero(int Status, string Cuerpo, byte[]? Binario = null, string? Tipo = null);

/// <summary>
/// El agente comercial, visto desde el panel: un reenvío autenticado.
///
/// Homero vive en la red interna y no está expuesto; su API ya valida cada
/// pedido y llama a las mismas funciones que los botones de Telegram. El panel
/// agrega lo que Homero no sabe: QUIÉN pide. Por eso no hay lógica de ventas
/// acá, solo el control de que sea el dueño.
/// </summary>
public interface IHomeroClient
{
    /// <summary>Null cuando Homero no está configurado en este despliegue.</summary>
    bool Configurado { get; }

    Task<RespuestaDeHomero> ReenviarAsync(HttpMethod metodo, string rutaYQuery, string? cuerpoJson, CancellationToken ct);
}

public sealed class HomeroClient(HttpClient http) : IHomeroClient
{
    public bool Configurado => true;

    public async Task<RespuestaDeHomero> ReenviarAsync(
        HttpMethod metodo, string rutaYQuery, string? cuerpoJson, CancellationToken ct)
    {
        using var pedido = new HttpRequestMessage(metodo, rutaYQuery);
        if (cuerpoJson is not null)
        {
            pedido.Content = new StringContent(cuerpoJson, Encoding.UTF8, "application/json");
        }
        using var r = await http.SendAsync(pedido, ct);
        var tipo = r.Content.Headers.ContentType?.MediaType;
        if (r.IsSuccessStatusCode && tipo is not null && tipo.StartsWith("image/", StringComparison.OrdinalIgnoreCase))
        {
            return new RespuestaDeHomero((int)r.StatusCode, "", await r.Content.ReadAsByteArrayAsync(ct), tipo);
        }
        return new RespuestaDeHomero((int)r.StatusCode, await r.Content.ReadAsStringAsync(ct));
    }
}

/// <summary>Sin HOMERO_URL: la sección no existe y el front la esconde.</summary>
public sealed class SinHomero : IHomeroClient
{
    public bool Configurado => false;

    public Task<RespuestaDeHomero> ReenviarAsync(
        HttpMethod metodo, string rutaYQuery, string? cuerpoJson, CancellationToken ct)
        => throw new InvalidOperationException("Homero no esta configurado");
}

public static class RutasDeHomero
{
    /// <summary>
    /// Solo letras, números, guiones y barras: el resto de la ruta termina en
    /// una URL interna, y un `..` o un `//host` no pueden llegar hasta ahí.
    /// </summary>
    public static bool RutaValida(string resto)
        => resto.Length is > 0 and <= 200
           && !resto.Contains("..", StringComparison.Ordinal)
           && System.Text.RegularExpressions.Regex.IsMatch(resto, "^[A-Za-z0-9-]+(/[A-Za-z0-9-]+)*$");
}
