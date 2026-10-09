namespace MultiCodigo.Panel;

/// <summary>
/// "Cualquiera": en vez de un slot, el primero que esté libre, o el primero que
/// se libere.
/// </summary>
/// <remarks>
/// La espera vive acá y no en el gateway aunque el gateway sea quien sabe quién
/// tiene cada slot: un turno arma sesión, worktree y tokens para UN agente
/// concreto, así que el slot tiene que estar decidido antes de pedirlo. La
/// carrera —lo elegimos libre y otro lo toma antes que nosotros— se resuelve
/// con el 409 del gateway: `agente_ocupado` vuelve a la espera en vez de fallar.
///
/// Libre es lo mismo que mira el relevo del bridge (`proximoSlot`): con cuenta,
/// sin turno en vuelo y con cuota. Un slot sin cuota no está libre aunque nadie
/// lo use: mandarle trabajo gasta un intento y vuelve con `usage_limit`.
/// </remarks>
public static class Cualquiera
{
    /// <summary>El valor que manda el front en lugar de un `cN`.</summary>
    public const string Valor = "cualquiera";

    public static readonly TimeSpan Tope = TimeSpan.FromMinutes(30);
    public static readonly TimeSpan Cada = TimeSpan.FromSeconds(10);

    public static bool Es(string? slot) => slot == Valor;

    /// <summary>El primer slot libre, en orden numérico (`c10` va después de `c2`), o null.</summary>
    public static string? Libre(IEnumerable<SlotVista> slots)
        => slots
            .Where(s => s.TieneCredencial && s.ProyectoId is not null && !s.Trabajando && s.SinCuotaHasta is null)
            .Select(s => s.Slot)
            .OrderBy(s => int.TryParse(s.AsSpan(1), out var n) ? n : int.MaxValue)
            .FirstOrDefault();

    /// <summary>
    /// Corre <paramref name="correr"/> con el primer slot libre. Si no hay, espera
    /// y vuelve a mirar; <paramref name="alEsperar"/> se llama UNA vez, la primera
    /// que no encuentra ninguno (para que la pantalla diga "esperando").
    /// </summary>
    /// <exception cref="UpstreamException">`sin_agente_libre` si pasa el tope sin que se libere ninguno.</exception>
    public static async Task<T> ConElPrimeroLibre<T>(
        Func<CancellationToken, Task<IEnumerable<SlotVista>>> slots,
        Func<string, Task<T>> correr,
        Func<Task>? alEsperar,
        CancellationToken ct,
        TimeSpan? tope = null,
        TimeSpan? cada = null,
        Func<DateTimeOffset>? ahora = null)
    {
        var reloj = ahora ?? (() => DateTimeOffset.UtcNow);
        var hasta = reloj() + (tope ?? Tope);
        var avisado = false;

        while (true)
        {
            var slot = Libre(await slots(ct));
            if (slot is not null)
            {
                try
                {
                    return await correr(slot);
                }
                catch (UpstreamException e) when (e.Message == "agente_ocupado")
                {
                    // Lo tomó otro entre que lo vimos libre y lo pedimos: se
                    // sigue esperando, no es una falla del pedido.
                }
            }

            if (!avisado && alEsperar is not null)
            {
                avisado = true;
                await alEsperar();
            }
            if (reloj() >= hasta)
            {
                throw new UpstreamException(
                    "sin_agente_libre", detalle: "no se liberó ningún agente a tiempo");
            }
            await Task.Delay(cada ?? Cada, ct);
        }
    }
}
