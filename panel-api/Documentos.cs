using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace MultiCodigo.Panel;

/// <summary>Un documento vinculado a un proyecto.</summary>
/// <param name="Nombre">El nombre del archivo en el worktree del agente.</param>
/// <param name="Error">Por qué no se pudo convertir, o null si se pudo.</param>
public sealed record Documento(
    [property: JsonPropertyName("id")] string Id,
    [property: JsonPropertyName("nombre")] string Nombre,
    [property: JsonPropertyName("nombreOriginal")] string NombreOriginal,
    [property: JsonPropertyName("tipo")] string Tipo,
    [property: JsonPropertyName("bytes")] long Bytes,
    [property: JsonPropertyName("error")] string? Error = null);

/// <summary>Lo que viaja con el turno: el nombre y de dónde bajarlo.</summary>
public sealed record DocumentoDelTurno(string Nombre, string Url, string? UrlTexto);

/// <summary>
/// Los documentos de cada proyecto: la tabla y los archivos.
///
/// Junta las dos mitades a propósito. Un documento sin su archivo es una fila
/// que miente, y un archivo sin su fila es basura que nadie va a borrar: son una
/// sola cosa y se manejan desde un solo lugar.
/// </summary>
public interface IDocumentosClient
{
    Task<IReadOnlyList<Documento>> DeProyectoAsync(
        string jwt, string proyectoId, CancellationToken ct = default);

    /// <summary>
    /// Sube el original y su texto, y escribe la fila.
    ///
    /// `texto` es null cuando la conversión falló; `error` dice por qué. El
    /// documento se guarda igual: el original se puede descargar y la conversión
    /// se puede reintentar, que es mejor que perder el archivo.
    /// </summary>
    Task<Documento> SubirAsync(
        string jwt, string proyectoId, string nombre, string nombreOriginal, string tipo,
        byte[] datos, string? texto, string? error, CancellationToken ct = default);

    Task BorrarAsync(string jwt, string proyectoId, string nombre, CancellationToken ct = default);

    /// <summary>
    /// Los documentos con URLs firmadas, para que el gateway los baje.
    ///
    /// Firmadas y no públicas: el bucket es privado, y una URL que no vence
    /// convierte "quien es miembro puede leerlo" en "quien vio la URL alguna vez
    /// puede leerlo para siempre".
    /// </summary>
    Task<IReadOnlyList<DocumentoDelTurno>> ParaElTurnoAsync(
        string jwt, string proyectoId, CancellationToken ct = default);

    /// <summary>Una URL temporal para descargar el original desde el panel.</summary>
    Task<string?> UrlDeDescargaAsync(
        string jwt, string proyectoId, string nombre, CancellationToken ct = default);
}

public sealed class DocumentosClient(
    HttpClient http, string anonKey, ILogger<DocumentosClient> log) : IDocumentosClient
{
    private const string Bucket = "documentos";

    /// <summary>
    /// Cuánto vive una URL firmada.
    ///
    /// Una hora: tiene que durar lo que dura un turno —el gateway la usa al
    /// preparar el worktree, y un turno puede esperar a que un slot arranque—
    /// pero no más. Es el mismo criterio que el token de la GitHub App.
    /// </summary>
    private const int SegundosDeUrl = 3600;

    private sealed record Fila(
        string Id, string Nombre, string NombreOriginal, string Tipo, long Bytes,
        string? Error, string Ruta, string? RutaTexto);

    private HttpRequestMessage Pedido(HttpMethod metodo, string url, string jwt)
    {
        var req = new HttpRequestMessage(metodo, url);
        req.Headers.TryAddWithoutValidation("apikey", anonKey);
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", jwt);
        return req;
    }

    private const string Columnas =
        "select=id,nombre,nombre_original,tipo,bytes,error,ruta,ruta_texto&order=nombre";

    private async Task<List<Fila>> FilasAsync(string jwt, string proyectoId, CancellationToken ct)
    {
        var url = $"/rest/v1/documentos?proyecto_id=eq.{proyectoId}&{Columnas}";
        var res = await http.SendAsync(Pedido(HttpMethod.Get, url, jwt), ct);
        if (!res.IsSuccessStatusCode)
        {
            log.LogWarning("no se pudieron leer los documentos de {Proyecto}", proyectoId);
            return [];
        }
        return await res.Content.ReadFromJsonAsync<List<Fila>>(Json.Supabase, ct) ?? [];
    }

    public async Task<IReadOnlyList<Documento>> DeProyectoAsync(
        string jwt, string proyectoId, CancellationToken ct = default)
    {
        try
        {
            var filas = await FilasAsync(jwt, proyectoId, ct);
            return [.. filas.Select(f => new Documento(
                f.Id, f.Nombre, f.NombreOriginal, f.Tipo, f.Bytes, f.Error))];
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException)
        {
            log.LogWarning(ex, "no se pudieron leer los documentos de {Proyecto}", proyectoId);
            return [];
        }
    }

    public async Task<Documento> SubirAsync(
        string jwt, string proyectoId, string nombre, string nombreOriginal, string tipo,
        byte[] datos, string? texto, string? error, CancellationToken ct = default)
    {
        var ruta = $"{proyectoId}/{nombre}";
        await GuardarArchivoAsync(jwt, ruta, datos, ct);

        string? rutaTexto = null;
        if (texto is not null)
        {
            // El texto al lado del original, con `.md` pegado al nombre entero y
            // no reemplazando la extensión: así `precios.xlsx` y `precios.csv`
            // no se pisan entre sí en el bucket.
            rutaTexto = $"{proyectoId}/{nombre}.md";
            await GuardarArchivoAsync(jwt, rutaTexto, System.Text.Encoding.UTF8.GetBytes(texto), ct);
        }

        var req = Pedido(HttpMethod.Post, "/rest/v1/documentos", jwt);
        // Upsert: subir un documento con el mismo nombre lo reemplaza, que es lo
        // que la persona espera al arrastrar una versión nueva del mismo archivo.
        req.Headers.TryAddWithoutValidation(
            "Prefer", "return=representation,resolution=merge-duplicates");
        req.Content = JsonContent.Create(
            new
            {
                proyecto_id = proyectoId,
                nombre,
                nombre_original = nombreOriginal,
                ruta,
                ruta_texto = rutaTexto,
                tipo,
                bytes = datos.LongLength,
                error,
            },
            options: Json.Opciones);

        var res = await http.SendAsync(req, ct);
        if (!res.IsSuccessStatusCode)
        {
            var detalle = await res.Content.ReadAsStringAsync(ct);
            log.LogError("no se pudo guardar el documento {Nombre}: {Detalle}", nombre, detalle);
            throw new UpstreamException(
                res.StatusCode == HttpStatusCode.Forbidden ? "no_sos_miembro" : "documento_no_guardado");
        }

        var filas = await res.Content.ReadFromJsonAsync<List<Fila>>(Json.Supabase, ct);
        var f = filas?.FirstOrDefault();
        return f is null
            ? new Documento("", nombre, nombreOriginal, tipo, datos.LongLength, error)
            : new Documento(f.Id, f.Nombre, f.NombreOriginal, f.Tipo, f.Bytes, f.Error);
    }

    private async Task GuardarArchivoAsync(
        string jwt, string ruta, byte[] datos, CancellationToken ct)
    {
        var req = Pedido(HttpMethod.Post, $"/storage/v1/object/{Bucket}/{ruta}", jwt);
        // `x-upsert` para que reemplazar un documento no falle contra el archivo
        // que ya está: la fila hace upsert, y sin esto las dos mitades quedarían
        // desincronizadas.
        req.Headers.TryAddWithoutValidation("x-upsert", "true");
        req.Content = new ByteArrayContent(datos);
        req.Content.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");

        var res = await http.SendAsync(req, ct);
        if (!res.IsSuccessStatusCode)
        {
            var detalle = await res.Content.ReadAsStringAsync(ct);
            log.LogError("no se pudo subir {Ruta}: {Status} {Detalle}", ruta, (int)res.StatusCode, detalle);
            throw new UpstreamException("archivo_no_subido");
        }
    }

    public async Task BorrarAsync(
        string jwt, string proyectoId, string nombre, CancellationToken ct = default)
    {
        // La fila primero: si falla, el archivo queda pero el documento sigue
        // apareciendo, que es un estado que el usuario entiende y puede
        // reintentar. Al revés quedaría una fila apuntando a un archivo que ya no
        // existe, y el turno siguiente fallaría al bajarlo.
        var url = $"/rest/v1/documentos?proyecto_id=eq.{proyectoId}&nombre=eq.{Uri.EscapeDataString(nombre)}";
        var res = await http.SendAsync(Pedido(HttpMethod.Delete, url, jwt), ct);
        if (!res.IsSuccessStatusCode)
        {
            log.LogError("no se pudo borrar el documento {Nombre}: {Status}", nombre, (int)res.StatusCode);
            throw new UpstreamException("documento_no_borrado");
        }

        // Los archivos después, y sin romper si fallan: la fila ya no está, así
        // que el documento desapareció de la vista. Un archivo huérfano ocupa
        // lugar y no rompe nada.
        foreach (var ruta in new[] { $"{proyectoId}/{nombre}", $"{proyectoId}/{nombre}.md" })
        {
            try
            {
                await http.SendAsync(
                    Pedido(HttpMethod.Delete, $"/storage/v1/object/{Bucket}/{ruta}", jwt), ct);
            }
            catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
            {
                log.LogWarning(ex, "quedo un archivo huerfano en {Ruta}", ruta);
            }
        }
    }

    public async Task<IReadOnlyList<DocumentoDelTurno>> ParaElTurnoAsync(
        string jwt, string proyectoId, CancellationToken ct = default)
    {
        try
        {
            var filas = await FilasAsync(jwt, proyectoId, ct);
            var salida = new List<DocumentoDelTurno>();
            foreach (var f in filas)
            {
                var url = await FirmarAsync(jwt, f.Ruta, ct);
                if (url is null) continue;
                salida.Add(new DocumentoDelTurno(
                    f.Nombre, url,
                    f.RutaTexto is null ? null : await FirmarAsync(jwt, f.RutaTexto, ct)));
            }
            return salida;
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException)
        {
            // Sin documentos el turno corre igual: el agente trabaja sobre el
            // código y nada más, que es como funcionaba antes de esta feature.
            log.LogWarning(ex, "no se pudieron firmar los documentos de {Proyecto}", proyectoId);
            return [];
        }
    }

    public async Task<string?> UrlDeDescargaAsync(
        string jwt, string proyectoId, string nombre, CancellationToken ct = default)
        => await FirmarAsync(jwt, $"{proyectoId}/{nombre}", ct);

    private sealed record RespuestaFirma([property: JsonPropertyName("signedURL")] string? SignedUrl);

    private async Task<string?> FirmarAsync(string jwt, string ruta, CancellationToken ct)
    {
        var req = Pedido(HttpMethod.Post, $"/storage/v1/object/sign/{Bucket}/{ruta}", jwt);
        req.Content = JsonContent.Create(new { expiresIn = SegundosDeUrl }, options: Json.Opciones);

        var res = await http.SendAsync(req, ct);
        if (!res.IsSuccessStatusCode)
        {
            log.LogWarning("no se pudo firmar {Ruta}: {Status}", ruta, (int)res.StatusCode);
            return null;
        }

        var cuerpo = await res.Content.ReadFromJsonAsync<RespuestaFirma>(Json.Opciones, ct);
        if (cuerpo?.SignedUrl is null) return null;

        // Supabase devuelve la URL relativa al endpoint de storage. El gateway
        // corre en otra máquina, así que necesita la absoluta.
        var basePath = http.BaseAddress?.ToString().TrimEnd('/') ?? "";
        return $"{basePath}/storage/v1{cuerpo.SignedUrl}";
    }
}
