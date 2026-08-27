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
