using MultiCodigo.Panel;

namespace MultiCodigo.Panel.Tests;

/// <summary>
/// Dobles configurables de las tres fuentes. Cada uno permite forzar una caída,
/// que es el caso que más importa probar: el panel tiene que degradar, no
/// desaparecer.
/// </summary>
public sealed class GatewayFalso : IGatewayClient
{
    public List<Agente> Agentes { get; set; } = [new("c1", true), new("c2", false)];
    public Cola Cola { get; set; } = Cola.Vacia;
    public ResultadoTest Resultado { get; set; } = new(true, "hoy", "ok");
    public bool AgentesFalla { get; set; }
    public bool ColaFalla { get; set; }
    public List<string> Probados { get; } = [];

    public Task<IReadOnlyList<Agente>> AgentesAsync(CancellationToken ct = default)
        => AgentesFalla
            ? throw new HttpRequestException("gateway caído")
            : Task.FromResult<IReadOnlyList<Agente>>(Agentes);

    public Task<Cola> ColaAsync(CancellationToken ct = default)
        => ColaFalla ? throw new HttpRequestException("gateway caído") : Task.FromResult(Cola);

    public Task<ResultadoTest> ProbarAsync(string slot, CancellationToken ct = default)
    {
        Probados.Add(slot);
        return Task.FromResult(Resultado);
    }

    public List<string> SlotsCreados { get; } = [];
    public string SlotQueDevuelve { get; set; } = "c1";
    /// <summary>Fuerza el caso "no quedan slots", que el panel traduce a 409.</summary>
    public bool SinSlots { get; set; }

    public Task<string> CrearSlotAsync(string proyecto, CancellationToken ct = default)
    {
        if (SinSlots) throw new UpstreamException("sin_slots");
        SlotsCreados.Add(proyecto);
        return Task.FromResult(SlotQueDevuelve);
    }
}

/// <summary>
/// Los proyectos del usuario. `Mios` es lo que en produccion decide RLS: un id
/// que no esta en el diccionario es un proyecto del que no sos miembro.
/// </summary>
public sealed class ProyectosFalso : IProyectosClient
{
    public Dictionary<string, string> Mios { get; } = [];

    public Task<string?> NombreSiEsMiembroAsync(
        string jwt, string proyectoId, CancellationToken ct = default)
        => Task.FromResult(Mios.TryGetValue(proyectoId, out var n) ? n : null);

    public List<(string Nombre, string Jwt)> Creados { get; } = [];
    public string IdQueDevuelve { get; set; } = "33333333-3333-4333-8333-333333333333";
    /// <summary>Un nombre que ya existe: el UNIQUE de la tabla lo rechaza.</summary>
    public bool NombreRepetido { get; set; }

    public Task<string> CrearAsync(string jwt, string nombre, CancellationToken ct = default)
    {
        if (NombreRepetido) throw new UpstreamException("nombre_repetido");
        Creados.Add((nombre, jwt));
        return Task.FromResult(IdQueDevuelve);
    }

    /// <summary>El rol del usuario por proyecto. Ausente = no es miembro.</summary>
    public Dictionary<string, string> Roles { get; } = [];

    public Task<string?> RolDeAsync(string jwt, string proyectoId, CancellationToken ct = default)
        => Task.FromResult(Roles.TryGetValue(proyectoId, out var r) ? r : null);

    public List<(string ProyectoId, string Email, string Rol)> Invitados { get; } = [];
    public string TokenQueDevuelve { get; set; } = "un-token-de-invitacion";

    public Task<string> InvitarAsync(
        string jwt, string proyectoId, string email, string rol, CancellationToken ct = default)
    {
        Invitados.Add((proyectoId, email, rol));
        return Task.FromResult(TokenQueDevuelve);
    }

    public List<string> Aceptados { get; } = [];
    /// <summary>La invitacion vencida, usada o inexistente.</summary>
    public bool InvitacionNoSirve { get; set; }

    public Task<string> AceptarAsync(string jwt, string token, CancellationToken ct = default)
    {
        if (InvitacionNoSirve) throw new UpstreamException("invitacion_no_sirve");
        Aceptados.Add(token);
        return Task.FromResult(IdQueDevuelve);
    }
}

public sealed class AgentesFalso : IAgentesClient
{
    public List<(string Jwt, string ProyectoId, string Slot)> Registrados { get; } = [];
    public bool Falla { get; set; }

    public Task RegistrarAsync(string jwt, string proyectoId, string slot, CancellationToken ct = default)
    {
        if (Falla) throw new UpstreamException("no se pudo anotar el agente");
        Registrados.Add((jwt, proyectoId, slot));
        return Task.CompletedTask;
    }
}

public sealed class LoginFalso : ILoginClient
{
    public Dictionary<string, EstadoCredencial> Estados { get; } = [];
    public bool Falla { get; set; }
    public string Url { get; set; } = "https://claude.ai/oauth/x";
    public List<(string Slot, string Code)> Codigos { get; } = [];
    public List<(string Slot, string Token, string Account)> Tokens { get; } = [];
    public List<string> Borrados { get; } = [];

    public Task<EstadoCredencial> EstadoAsync(string slot, CancellationToken ct = default)
        => Falla
            ? throw new HttpRequestException("login caído")
            : Task.FromResult(Estados.TryGetValue(slot, out var e) ? e : new EstadoCredencial(false));

    public Task<string> IniciarAsync(string slot, CancellationToken ct = default)
        => Falla ? throw new UpstreamException("no imprimió URL") : Task.FromResult(Url);

    public Task CodigoAsync(string slot, string code, CancellationToken ct = default)
    {
        if (Falla) throw new UpstreamException("el código no sirvió");
        Codigos.Add((slot, code));
        return Task.CompletedTask;
    }

    public Task TokenAsync(string slot, string token, string account, CancellationToken ct = default)
    {
        if (Falla) throw new UpstreamException("no se pudo guardar");
        Tokens.Add((slot, token, account));
        return Task.CompletedTask;
    }

    public Task BorrarAsync(string slot, CancellationToken ct = default)
    {
        Borrados.Add(slot);
        return Task.CompletedTask;
    }
}

public sealed class BridgeFalso : IBridgeClient
{
    public List<JobResumen> Jobs { get; set; } = [];
    public bool Falla { get; set; }

    public Task<IReadOnlyList<JobResumen>> JobsAsync(int limite, CancellationToken ct = default)
        => Falla
            ? throw new HttpRequestException("bridge caído")
            : Task.FromResult<IReadOnlyList<JobResumen>>(Jobs);

    public List<(string Codigo, string UsuarioId)> Canjeados { get; } = [];
    /// <summary>El codigo vencido, usado o desconocido: el bridge contesta 400.</summary>
    public bool CodigoNoSirve { get; set; }

    public List<(string Id, string Decision, string? Feedback, string UsuarioId)> Decisiones { get; } = [];
    /// <summary>Alguien la decidio desde Telegram mientras la pantalla estaba abierta.</summary>
    public bool YaDecidida { get; set; }

    public Task DecidirAsync(
        string aprobacionId, string decision, string? feedback, string usuarioId,
        CancellationToken ct = default)
    {
        if (YaDecidida) throw new UpstreamException("ya_decidida");
        if (Falla) throw new HttpRequestException("bridge caído");
        Decisiones.Add((aprobacionId, decision, feedback, usuarioId));
        return Task.CompletedTask;
    }

    public Task CanjearVinculoAsync(string codigo, string usuarioId, CancellationToken ct = default)
    {
        if (Falla) throw new HttpRequestException("bridge caído");
        if (CodigoNoSirve) throw new UpstreamException("el codigo no sirve");
        Canjeados.Add((codigo, usuarioId));
        return Task.CompletedTask;
    }
}

public sealed class HistorialFalso : IHistorialClient
{
    public Dictionary<string, ResultadoTest> Ultimos { get; } = [];
    public List<(string Jwt, string Slot, ResultadoTest R)> Guardados { get; } = [];
    /// <summary>Los JWT con los que se pidió el historial, para poder verificar que se reenvía el del usuario.</summary>
    public List<string> JwtsLeidos { get; } = [];
    public bool Falla { get; set; }

    public Task<ResultadoTest?> UltimoAsync(string jwt, string slot, CancellationToken ct = default)
    {
        if (Falla) throw new HttpRequestException("supabase caído");
        JwtsLeidos.Add(jwt);
        return Task.FromResult(Ultimos.TryGetValue(slot, out var r) ? r : null);
    }

    public Task GuardarAsync(string jwt, string slot, ResultadoTest r, CancellationToken ct = default)
    {
        Guardados.Add((jwt, slot, r));
        return Task.CompletedTask;
    }
}

public sealed class NombresFalso : INombresClient
{
    public Dictionary<string, string> Guardados { get; } = [];
    /// <summary>Los JWT con los que se leyó, para verificar que se reenvía el del usuario.</summary>
    public List<string> JwtsLeidos { get; } = [];
    public bool Falla { get; set; }

    public Task<IReadOnlyDictionary<string, string>> TodosAsync(string jwt, CancellationToken ct = default)
    {
        JwtsLeidos.Add(jwt);
        return Task.FromResult<IReadOnlyDictionary<string, string>>(
            new Dictionary<string, string>(Guardados));
    }

    public Task GuardarAsync(string jwt, string slot, string nombre, CancellationToken ct = default)
    {
        if (Falla) throw new UpstreamException("no se pudo guardar el nombre");
        Guardados[slot] = nombre;
        return Task.CompletedTask;
    }
}
