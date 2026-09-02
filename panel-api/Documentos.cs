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
/// <summary>
/// Un documento tal como viaja al gateway: rutas en el disco, no URLs.
/// </summary>
public sealed record DocumentoDelTurno(string Nombre, string Ruta, string? RutaTexto);

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
    Task<byte[]?> DescargarAsync(
        string jwt, string proyectoId, string nombre, CancellationToken ct = default);
}

public sealed class DocumentosClient(
    HttpClient http, string anonKey, ILogger<DocumentosClient> log) : IDocumentosClient
{
    /// <summary>
    /// Dónde viven los documentos en el disco del servidor.
    /// </summary>
    /// <remarks>
    /// El gateway monta este mismo directorio y lee de ahí. Se puede mover con
    /// DOCS_ROOT para un despliegue con otra estructura.
    /// </remarks>
    private static readonly string RaizDocs =
        Environment.GetEnvironmentVariable("DOCS_ROOT") is { Length: > 0 } r ? r : "/srv/docs";

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

    /// <summary>
    /// Escribe el archivo en el disco del servidor.
    /// </summary>
    /// <remarks>
    /// En disco y no en Supabase Storage. El panel y el gateway corren en la
    /// misma máquina y montan el mismo directorio, así que Storage era mandar
    /// el archivo a internet para que el gateway lo bajara tres líneas después
    /// — con una URL firmada por documento y por turno, y una service_role que
    /// este proceso tenía negada por diseño.
    ///
    /// El escape de la ruta se chequea igual: `ruta` la arma este proceso a
    /// partir del id del proyecto y un nombre ya validado, pero un archivo que
    /// se escribe fuera de su directorio es un agujero demasiado caro como para
    /// depender de que quien llame lo haya hecho bien.
    /// </remarks>
    private async Task GuardarArchivoAsync(
        string jwt, string ruta, byte[] datos, CancellationToken ct)
    {
        var destino = Path.GetFullPath(Path.Combine(RaizDocs, ruta));
        var raiz = Path.GetFullPath(RaizDocs);
        if (!destino.StartsWith(raiz + Path.DirectorySeparatorChar, StringComparison.Ordinal))
        {
            log.LogError("ruta de documento fuera de la raíz: {Ruta}", ruta);
            throw new UpstreamException("archivo_no_subido");
        }

        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(destino)!);
            // Sobrescribe: reemplazar un documento no puede fallar contra el
            // archivo que ya está. La fila hace upsert, y si esto no lo hiciera
            // las dos mitades quedarían desincronizadas.
            await File.WriteAllBytesAsync(destino, datos, ct);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            log.LogError(e, "no se pudo escribir {Ruta}", ruta);
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
                var destino = RutaSegura(ruta);
                if (destino is not null) File.Delete(destino);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
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
            // La ruta viaja tal cual: el gateway lee el archivo del disco que
            // los dos montan. Antes se firmaba una URL de Storage por documento
            // y por turno para mover un archivo entre dos procesos de la misma
            // máquina.
            var filas = await FilasAsync(jwt, proyectoId, ct);
            return filas
                .Select(f => new DocumentoDelTurno(f.Nombre, f.Ruta, f.RutaTexto))
                .ToList();
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException)
        {
            // Sin documentos el turno corre igual: el agente trabaja sobre el
            // código y nada más, que es como funcionaba antes de esta feature.
            log.LogWarning(ex, "no se pudieron leer los documentos de {Proyecto}", proyectoId);
            return [];
        }
    }

    /// <summary>
    /// El archivo, para que el panel lo sirva.
    /// </summary>
    /// <remarks>
    /// Antes esto devolvía una URL firmada de Storage y el navegador iba a
    /// buscarla directo, con el argumento de que el panel no tiene que hacer de
    /// proxy de 20 MB. Sin Storage ese atajo no existe: el archivo está en un
    /// disco que solo este proceso ve, así que lo sirve él.
    ///
    /// El costo es real y acotado — 20 MB es el tope de subida, y una descarga
    /// es algo que alguien pide a mano, no algo que pase en cada turno.
    /// </remarks>
    public async Task<byte[]?> DescargarAsync(
        string jwt, string proyectoId, string nombre, CancellationToken ct = default)
    {
        var destino = RutaSegura($"{proyectoId}/{nombre}");
        if (destino is null || !File.Exists(destino)) return null;
        try
        {
            return await File.ReadAllBytesAsync(destino, ct);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            log.LogWarning(ex, "no se pudo leer {Nombre}", nombre);
            return null;
        }
    }

    /// <summary>
    /// La ruta absoluta de un documento, o null si se escapa de la raíz.
    /// </summary>
    /// <remarks>
    /// `ruta` la arma este proceso con el id del proyecto y un nombre ya
    /// validado, pero escribir o borrar fuera del directorio es un agujero
    /// demasiado caro como para depender de que quien llame lo haya hecho bien.
    /// </remarks>
    private static string? RutaSegura(string ruta)
    {
        var raiz = Path.GetFullPath(RaizDocs);
        var destino = Path.GetFullPath(Path.Combine(raiz, ruta));
        return destino.StartsWith(raiz + Path.DirectorySeparatorChar, StringComparison.Ordinal)
            ? destino
            : null;
    }
}