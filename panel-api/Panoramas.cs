namespace MultiCodigo.Panel;

/// <summary>
/// Junta las tres fuentes en la vista que consume el front.
///
/// Cada fuente degrada por su cuenta: la cola vive en el gateway, las peticiones
/// en el bridge y el historial en Supabase — tres procesos distintos. Que uno se
/// caiga no puede dejar la página en blanco, porque justo ahí es cuando más la
/// necesitás para diagnosticar esa misma caída.
/// </summary>
public sealed class PanoramaService(
    IGatewayClient gateway,
    ILoginClient login,
    IBridgeClient bridge,
    IHistorialClient historial,
    ILogger<PanoramaService> log)
{
    private const int JobsAMostrar = 20;

    public async Task<Panorama> VerAsync(string jwt, CancellationToken ct = default)
    {
        // El gateway NO se protege: sin él no hay nada que mostrar, y una lista
        // vacía se leería como "no tenés ningún agente". Ese error sube y el
        // endpoint contesta 503.
        var agentes = await gateway.AgentesAsync(ct);

        var cola = await Degradar(() => gateway.ColaAsync(ct), Cola.Vacia, "la cola");
        var jobs = await Degradar(
            () => bridge.JobsAsync(JobsAMostrar, ct), [], "las últimas peticiones");

        // En paralelo y no en fila: con seis slots y una consulta lenta, la
        // página tardaría seis veces más de lo necesario.
        var slots = await Task.WhenAll(agentes.Select(a => VerSlotAsync(jwt, a, ct)));

        return new Panorama(slots, cola, jobs);
    }

    private async Task<SlotVista> VerSlotAsync(string jwt, Agente a, CancellationToken ct)
    {
        var credTask = Degradar(
            () => login.EstadoAsync(a.Id, ct), new EstadoCredencial(false), $"la credencial de {a.Id}");
        var testTask = Degradar<ResultadoTest?>(
            () => historial.UltimoAsync(jwt, a.Id, ct), null, $"el último test de {a.Id}");

        await Task.WhenAll(credTask, testTask);
        var cred = await credTask;
        var test = await testTask;

        return new SlotVista(
            Slot: a.Id,
            Arriba: a.Arriba,
            TieneCredencial: cred.Tiene,
            LoginAbierto: cred.LoginAbierto,
            // Sin ningún test corrido es false: nadie lo comprobó todavía.
            Funcionando: test?.Ok == true,
            Account: cred.Account,
            LoadedAt: cred.LoadedAt,
            UltimoTest: test,
            Proyecto: a.Proyecto);
    }

    /// <summary>
    /// Devuelve el valor por defecto en vez de propagar, y deja el detalle en el
    /// log. Se atrapa <see cref="Exception"/> a secas a propósito: el punto es
    /// que NINGUNA falla de una fuente secundaria voltee la página.
    /// </summary>
    private async Task<T> Degradar<T>(Func<Task<T>> traer, T porDefecto, string que)
    {
        try
        {
            return await traer();
        }
        catch (Exception ex)
        {
            log.LogError(ex, "no pude leer {Que}", que);
            return porDefecto;
        }
    }
}
