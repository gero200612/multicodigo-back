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
    /// <summary>
    /// Los proyectos con los que se llamo a ProbarAsync.
    ///
    /// Existe para poder afirmar que llega el nombre REAL del proyecto y no una
    /// constante del entorno: mientras el panel leia PANEL_PROJECT, todos los
    /// proyectos probaban contra el mismo, y el test no podia notar la
    /// diferencia.
    /// </summary>
    public List<string> ProyectosPedidos { get; } = [];

    public Task<IReadOnlyList<Agente>> AgentesAsync(CancellationToken ct = default)
        => AgentesFalla
            ? throw new HttpRequestException("gateway caído")
            : Task.FromResult<IReadOnlyList<Agente>>(Agentes);

    public Task<Cola> ColaAsync(CancellationToken ct = default)
        => ColaFalla ? throw new HttpRequestException("gateway caído") : Task.FromResult(Cola);

    /// <summary>Los repos que viajaron con cada test.</summary>
    public List<IReadOnlyList<Repo>> ReposDeCadaTest { get; } = [];

    /// <summary>El token que viajo con cada test. Null cuando fue por SSH.</summary>
    public List<string?> TokensDeCadaTest { get; } = [];

    public Task<ResultadoTest> ProbarAsync(
        string proyecto, string slot, IReadOnlyList<Repo> repos, string? githubToken,
        CancellationToken ct = default)
    {
        Probados.Add(slot);
        ProyectosPedidos.Add(proyecto);
        ReposDeCadaTest.Add(repos);
        TokensDeCadaTest.Add(githubToken);
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
/// <summary>
/// Los repos vinculados, en memoria.
///
/// No modela RLS: la membresía la chequea el endpoint antes de llamar acá, que
/// es justo lo que estos tests verifican.
/// </summary>
public sealed class ReposFalso : IReposClient
{
    public List<Repo> Filas { get; } = [];
    public List<string> Vinculados { get; } = [];
    public List<string> Desvinculados { get; } = [];
    /// <summary>Fuerza el caso "ese repo ya estaba", que es el UNIQUE de la tabla.</summary>
    public bool Duplicado { get; set; }

    public Task<IReadOnlyList<Repo>> DeProyectoAsync(
        string jwt, string proyectoId, CancellationToken ct = default)
        => Task.FromResult<IReadOnlyList<Repo>>(Filas);

    public Task VincularAsync(string jwt, string proyectoId, Repo repo, CancellationToken ct = default)
    {
        if (Duplicado) throw new UpstreamException("repo_duplicado");
        Vinculados.Add(repo.Nombre);
        Filas.Add(repo);
        return Task.CompletedTask;
    }

    public Task DesvincularAsync(
        string jwt, string proyectoId, string nombre, CancellationToken ct = default)
    {
        Desvinculados.Add(nombre);
        Filas.RemoveAll(f => f.Nombre == nombre);
        return Task.CompletedTask;
    }
}

public sealed class InstalacionesFalso : IInstalacionesClient
{
    public Instalacion? Fila { get; set; }
    public List<(string ProyectoId, Instalacion Inst)> Guardadas { get; } = [];
    /// <summary>Fuerza el caso "sos miembro pero no dueño", que es RLS rechazando.</summary>
    public bool NoSosDueno { get; set; }

    public Task<Instalacion?> DeProyectoAsync(
        string jwt, string proyectoId, CancellationToken ct = default)
        => Task.FromResult(Fila);

    public Task GuardarAsync(
        string jwt, string proyectoId, Instalacion inst, CancellationToken ct = default)
    {
        if (NoSosDueno) throw new UpstreamException("no_sos_dueño");
        Guardadas.Add((proyectoId, inst));
        return Task.CompletedTask;
    }

    public Task BorrarAsync(string jwt, string proyectoId, CancellationToken ct = default)
    {
        if (NoSosDueno) throw new UpstreamException("no_sos_dueño");
        Fila = null;
        Borradas.Add(proyectoId);
        return Task.CompletedTask;
    }

    public List<string> Borradas { get; } = [];
}

public sealed class DocumentosFalso : IDocumentosClient
{
    public List<Documento> Filas { get; } = [];
    public List<DocumentoDelTurno> ParaTurno { get; } = [];
    public List<string> Borrados { get; } = [];
    public List<(string Nombre, string? Texto, string? Error)> Subidos { get; } = [];

    public Task<IReadOnlyList<Documento>> DeProyectoAsync(
        string jwt, string proyectoId, CancellationToken ct = default)
        // Espeja al cliente de verdad: el instructivo NO va en esta lista, que
        // es lo que hace que la pantalla no lo muestre dos veces.
        => Task.FromResult<IReadOnlyList<Documento>>(
            [.. Filas.Where(f => !f.EsInstruccion)]);

    public Task<Documento?> InstructivoDeProyectoAsync(
        string jwt, string proyectoId, CancellationToken ct = default)
        => Task.FromResult(Filas.FirstOrDefault(f => f.EsInstruccion));

    public Task<Documento> SubirAsync(
        string jwt, string proyectoId, string nombre, string nombreOriginal, string tipo,
        byte[] datos, string? texto, string? error, bool esInstruccion = false,
        CancellationToken ct = default)
    {
        Subidos.Add((nombre, texto, error));
        var doc = new Documento(
            "id", nombre, nombreOriginal, tipo, datos.LongLength, error, esInstruccion);
        Filas.Add(doc);
        return Task.FromResult(doc);
    }

    public Task BorrarAsync(string jwt, string proyectoId, string nombre, CancellationToken ct = default)
    {
        Borrados.Add(nombre);
        Filas.RemoveAll(f => f.Nombre == nombre);
        return Task.CompletedTask;
    }

    public Task<IReadOnlyList<DocumentoDelTurno>> ParaElTurnoAsync(
        string jwt, string proyectoId, CancellationToken ct = default)
        => Task.FromResult<IReadOnlyList<DocumentoDelTurno>>(ParaTurno);

    /// <summary>Bytes de mentira: alcanza para saber que la descarga sale.</summary>
    public Task<byte[]?> DescargarAsync(
        string jwt, string proyectoId, string nombre, CancellationToken ct = default)
        => Task.FromResult<byte[]?>(System.Text.Encoding.UTF8.GetBytes($"contenido de {nombre}"));
}

/// <summary>El conversor que siempre puede. Los tests que necesitan un fallo lo pisan.</summary>
public sealed class ConversorFalso : IConversorClient
{
    public string? Texto { get; set; } = "# convertido";
    public string? Error { get; set; }

    public Task<Conversion> ConvertirAsync(byte[] datos, string tipo, CancellationToken ct = default)
        => Task.FromResult(new Conversion(Texto, Error));
}

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
    /// <summary>Lo anotado por MarcarCuotaAsync: slot -> hasta (null = se limpio).</summary>
    public List<(string Slot, string? Hasta)> Cuotas { get; } = [];
    public Dictionary<string, string> SinCuota { get; } = [];

    public Task MarcarCuotaAsync(
        string jwt, string slot, string? hasta, CancellationToken ct = default)
    {
        Cuotas.Add((slot, hasta));
        return Task.CompletedTask;
    }

    public Task<IReadOnlyDictionary<string, string>> SinCuotaAsync(
        string jwt, CancellationToken ct = default)
        => Task.FromResult<IReadOnlyDictionary<string, string>>(SinCuota);

    /// <summary>
    /// La asignacion slot -> proyecto que devuelve la tabla.
    /// </summary>
    /// <remarks>
    /// Arranca con c1 y c2 —los dos de <see cref="GatewayFalso"/>— porque el
    /// caso normal es que los slots de la maquina sean los del usuario. Desde
    /// que el panorama FILTRA por esta asignacion, un diccionario vacio
    /// significa "este usuario no tiene ningun agente", y con ese default los
    /// tests de degradacion afirmaban sobre una lista vacia sin notarlo.
    ///
    /// Los tests de aislamiento lo pisan para poner solo lo que corresponde.
    /// </remarks>
    public Dictionary<string, string> PorSlot { get; } = new()
    {
        ["c1"] = "11111111-1111-4111-8111-111111111111",
        ["c2"] = "11111111-1111-4111-8111-111111111111",
    };

    public Task<IReadOnlyDictionary<string, string>> ProyectosPorSlotAsync(
        string jwt, CancellationToken ct = default)
        => Task.FromResult<IReadOnlyDictionary<string, string>>(PorSlot);

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

    public List<(string ProyectoId, string Proyecto, string Slot, string UsuarioId, string Prompt)> Turnos { get; } = [];
    public string TextoQueDevuelve { get; set; } = "la respuesta";
    /// <summary>El agente no contesta: el bridge devuelve 502 con su codigo.</summary>
    public string? TurnoFalla { get; set; }

    /// <summary>
    /// Los repos que viajaron con cada turno.
    ///
    /// El gateway no le habla a Supabase, asi que si el panel no los manda el
    /// agente trabaja sobre el catalogo local — que no conoce los proyectos que
    /// se crean desde el panel.
    /// </summary>
    public List<IReadOnlyList<Repo>> ReposDeCadaTurno { get; } = [];

    /// <summary>El token de github que viajo con cada turno. Null cuando fue por SSH.</summary>
    public List<string?> TokensDeCadaTurno { get; } = [];

    /// <summary>Los documentos que viajaron con cada turno.</summary>
    public List<IReadOnlyList<DocumentoDelTurno>> DocsDeCadaTurno { get; } = [];

    public Task<RespuestaTurno> TurnoAsync(
        string proyectoId, string proyecto, string slot, string usuarioId, string prompt,
        IReadOnlyList<Repo> repos, string? githubToken,
        IReadOnlyList<DocumentoDelTurno> documentos, CancellationToken ct = default)
    {
        DocsDeCadaTurno.Add(documentos);
        if (TurnoFalla is not null) throw new UpstreamException(TurnoFalla);
        Turnos.Add((proyectoId, proyecto, slot, usuarioId, prompt));
        ReposDeCadaTurno.Add(repos);
        TokensDeCadaTurno.Add(githubToken);
        return Task.FromResult(new RespuestaTurno("11111111-1111-4111-8111-111111111111", TextoQueDevuelve));
    }

    public Task CanjearVinculoAsync(string codigo, string usuarioId, CancellationToken ct = default)
    {
        if (Falla) throw new HttpRequestException("bridge caído");
        if (CodigoNoSirve) throw new UpstreamException("el codigo no sirve");
        Canjeados.Add((codigo, usuarioId));
        return Task.CompletedTask;
    }

    // --- Drive en vivo ----------------------------------------------------

    /// <summary>Con que cuenta esta conectado. Null = ninguna.</summary>
    public string? EmailDeGoogle { get; set; }
    /// <summary>Los canjes de codigo de OAuth que llegaron.</summary>
    public List<(string UsuarioId, string Code, string RedirectUri)> ConexionesDeGoogle { get; } = [];
    /// <summary>Google rechaza el canje: el bridge contesta con el motivo.</summary>
    public string? ConectarFalla { get; set; }
    /// <summary>Los links de "pedir acceso" que se quemaron.</summary>
    public List<(string Codigo, string Id)> PedidosCanjeados { get; } = [];
    /// <summary>El link no sirve: vencido, usado o desconocido.</summary>
    public string? LinkNoSirve { get; set; }

    public Task<string> ConectarGoogleAsync(
        string usuarioId, string code, string redirectUri, CancellationToken ct = default)
    {
        if (Falla) throw new HttpRequestException("bridge caído");
        if (ConectarFalla is not null) throw new UpstreamException(ConectarFalla);
        ConexionesDeGoogle.Add((usuarioId, code, redirectUri));
        EmailDeGoogle = "yo@ejemplo.com";
        return Task.FromResult(EmailDeGoogle);
    }

    public Task<EstadoGoogle> EstadoGoogleAsync(string usuarioId, CancellationToken ct = default)
    {
        if (Falla) throw new HttpRequestException("bridge caído");
        return Task.FromResult(new EstadoGoogle(EmailDeGoogle is not null, EmailDeGoogle));
    }

    public Task<bool> DesconectarGoogleAsync(string usuarioId, CancellationToken ct = default)
    {
        if (Falla) throw new HttpRequestException("bridge caído");
        var habia = EmailDeGoogle is not null;
        EmailDeGoogle = null;
        return Task.FromResult(habia);
    }

    public Task<string> CanjearPedidoDriveAsync(string codigo, string id, CancellationToken ct = default)
    {
        if (Falla) throw new HttpRequestException("bridge caído");
        if (LinkNoSirve is not null) throw new UpstreamException(LinkNoSirve);
        PedidosCanjeados.Add((codigo, id));
        return Task.FromResult("Balance 2026");
    }

    /// <summary>Lo gastado por agente que devuelve el bridge. Vacio por default.</summary>
    public Dictionary<string, Consumo> Consumo { get; } = [];

    public Task<IReadOnlyDictionary<string, Consumo>> ConsumoAsync(CancellationToken ct = default)
    {
        if (Falla) throw new HttpRequestException("bridge caído");
        return Task.FromResult<IReadOnlyDictionary<string, Consumo>>(Consumo);
    }

    /// <summary>Los chats desvinculados: chat -> usuario que lo pidio.</summary>
    public List<(long ChatId, string UsuarioId)> Desvinculados { get; } = [];

    /// <summary>Lo que devuelve el bridge. False = ese chat no era de ese usuario.</summary>
    public bool HayQueDesvincular { get; set; } = true;

    public Task<bool> DesvincularTelegramAsync(
        long chatId, string usuarioId, CancellationToken ct = default)
    {
        if (Falla) throw new HttpRequestException("bridge caído");
        Desvinculados.Add((chatId, usuarioId));
        return Task.FromResult(HayQueDesvincular);
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


/// <summary>
/// Los archivos de un repo, sin salir a GitHub.
///
/// El token de instalación lo resuelve el cliente de verdad, así que este doble
/// no tiene que firmar nada: es justo la razón de que ese token viva ahí adentro
/// y no en el endpoint.
/// </summary>
public sealed class ArbolFalso : IRepoArbolClient
{
    public List<EntradaDeRepo> Entradas { get; } = [];
    /// <summary>Los `full_name` que se pidieron, para verificar cuál se resolvió.</summary>
    public List<string> Pedidos { get; } = [];
    /// <summary>Fuerza un fallo de upstream: "sin_app", "sin_instalacion", "github_404".</summary>
    public string? Falla { get; set; }

    public Task<IReadOnlyList<EntradaDeRepo>> ArbolAsync(
        string jwt, string proyectoId, string fullName, CancellationToken ct = default)
    {
        if (Falla is not null) throw new UpstreamException(Falla);
        Pedidos.Add(fullName);
        return Task.FromResult<IReadOnlyList<EntradaDeRepo>>(Entradas);
    }

    public Task<byte[]?> ArchivoAsync(
        string jwt, string proyectoId, string fullName, string ruta,
        CancellationToken ct = default)
    {
        if (Falla is not null) throw new UpstreamException(Falla);
        Pedidos.Add(fullName);
        return Task.FromResult<byte[]?>(
            System.Text.Encoding.UTF8.GetBytes($"contenido de {ruta} en {fullName}"));
    }
}
