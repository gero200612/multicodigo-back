using System.Net.Http.Headers;
using System.Text;
using System.Security.Claims;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.Http.Json;
using Microsoft.IdentityModel.Tokens;
using MultiCodigo.Panel;

var builder = WebApplication.CreateBuilder(args);

// --- configuracion --------------------------------------------------------
//
// Todo requerido salvo lo que tiene default. Si falta algo, esto tira y el
// proceso muere con codigo distinto de cero: un panel arriba pero sin poder
// hablarle al gateway es peor que uno que no arranca.
var cfg = builder.Configuration;
string Requerido(string clave) =>
    cfg[clave] is { Length: > 0 } v
        ? v
        : throw new InvalidOperationException($"falta la configuración {clave}");

var gatewayUrl = Requerido("GATEWAY_URL");
var gatewayToken = Requerido("GATEWAY_TOKEN");
var loginUrl = Requerido("LOGIN_URL");
var loginToken = Requerido("LOGIN_TOKEN");
var bridgeUrl = Requerido("BRIDGE_URL");
var bridgeToken = Requerido("BRIDGE_API_TOKEN");
// La GitHub App. OPCIONALES a proposito, a diferencia del resto: sin ellas el
// panel arranca igual y los turnos van por el camino SSH con la deploy key, que
// es el de `demo` y el del smoke test. Hacerlas obligatorias volteria el panel
// de cualquiera que todavia no registro la App.
var githubAppId = cfg["GITHUB_APP_ID"];
var githubAppKey = cfg["GITHUB_APP_PRIVATE_KEY"];
// El slug es para armar la URL de instalacion: github.com/apps/<slug>/installations/new
var githubAppSlug = cfg["GITHUB_APP_SLUG"];

// El conversor de documentos. OPCIONAL, como las de la GitHub App: sin el, subir
// un documento sigue funcionando y se guarda sin convertir, con un mensaje que
// lo dice. Hacerlo obligatorio voltearia el panel de un despliegue que no lo
// tiene levantado.
var conversorUrl = cfg["CONVERSOR_URL"];

var supabaseUrl = Requerido("SUPABASE_URL").TrimEnd('/');
var supabaseAnonKey = Requerido("SUPABASE_ANON_KEY");
// Aca vivia `var proyecto = cfg["PANEL_PROJECT"] ?? "demo";`.
//
// Era la ultima constante que decidia sobre que proyecto trabajaba el panel, y
// con varios proyectos por cuenta empezo a mentir: el test de un slot corria en
// el worktree de cualquier proyecto que estuviera en esa variable, no en el que
// el usuario estaba mirando. El endpoint de turnos ya resolvia el nombre real
// con `NombreSiEsMiembroAsync`; el del test era el unico que faltaba.
var audiencia = cfg["SUPABASE_JWT_AUD"] ?? "authenticated";

// El JWKS de Supabase viaja por la red y con el se verifican TODAS las
// sesiones: por http, cualquiera en el camino lo reemplaza por su propia clave
// y firma tokens validos. Fuera de Development se exige https, y se chequea ACA
// para que un SUPABASE_URL con http mate el proceso al arrancar. Sin este
// guard, la configuracion invalida no explota hasta el primer request, y ahi se
// lleva puesto hasta /health: el healthcheck de docker daria el contenedor por
// sano un rato y despues por muerto, sin decir por que.
var esDesarrollo = builder.Environment.IsDevelopment();
if (!esDesarrollo && !supabaseUrl.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
{
    throw new InvalidOperationException(
        $"SUPABASE_URL tiene que ser https fuera de Development (es {supabaseUrl}): " +
        "el JWKS que verifica las sesiones no puede viajar en claro");
}

// Los bearers de los otros servicios son secretos compartidos: un token corto
// es fuerza-bruteable, y uno vacio haria que `Bearer ` a secas autentique del
// otro lado. Mismo piso que el gateway y el servicio de login.
foreach (var (nombre, valor) in new[]
         {
             ("GATEWAY_TOKEN", gatewayToken),
             ("LOGIN_TOKEN", loginToken),
             ("BRIDGE_API_TOKEN", bridgeToken),
         })
{
    if (valor.Length < 16)
    {
        throw new InvalidOperationException($"{nombre} debe tener al menos 16 caracteres");
    }
}

// --- servicios ------------------------------------------------------------

builder.Services.Configure<JsonOptions>(o =>
{
    // camelCase para que el front reciba `tieneCredencial` y no `TieneCredencial`.
    o.SerializerOptions.PropertyNamingPolicy = System.Text.Json.JsonNamingPolicy.CamelCase;
    // Los campos opcionales (account, ultimoTest) se omiten en vez de viajar
    // como null: el front ya los trata como ausentes.
    o.SerializerOptions.DefaultIgnoreCondition =
        System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull;
});

/// <summary>
/// El tope del CLIENTE es el de su operacion mas larga, y las cortas ponen el
/// suyo por request (ver `Topes` en Clientes.cs).
///
/// Al reves no se puede: `HttpClient.Timeout` vale para todo el cliente, y un
/// mismo servicio tiene operaciones de escalas muy distintas. Con 20 segundos
/// para todo, el boton "probar" —que corre un turno de Claude, de minutos—
/// moria siempre con "The request was canceled due to the configured
/// HttpClient.Timeout of 20 seconds elapsing".
/// </summary>
static void ConBearer(HttpClient c, string baseUrl, string token, int minutos = 11)
{
    c.BaseAddress = new Uri(baseUrl);
    c.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
    c.Timeout = TimeSpan.FromMinutes(minutos);
}

builder.Services.AddHttpClient<IGatewayClient, GatewayClient>(c => ConBearer(c, gatewayUrl, gatewayToken))
    .AddTypedClient<IGatewayClient>((http, _) => new GatewayClient(http));
// El login tambien tarda: `start` levanta el CLI y espera a que imprima la URL,
// y `code` espera el intercambio completo con Anthropic. Con 20 segundos, el
// paso 2 del login fallaba justo cuando estaba por salir bien.
builder.Services.AddHttpClient<ILoginClient, LoginClient>(c => ConBearer(c, loginUrl, loginToken, 5));
// Once minutos, que es lo mismo que espera el bridge del gateway: por aca pasan
// los turnos del chat del panel.
builder.Services.AddHttpClient<IBridgeClient, BridgeClient>(c => ConBearer(c, bridgeUrl, bridgeToken));
builder.Services.AddHttpClient<IHistorialClient, HistorialClient>(c =>
    {
        // Sin Authorization por defecto: acá el bearer es el JWT del USUARIO y
        // se arma por request. Ver HistorialClient.
        c.BaseAddress = new Uri(supabaseUrl);
        c.Timeout = TimeSpan.FromSeconds(10);
    })
    .AddTypedClient<IHistorialClient>((http, sp) =>
        new HistorialClient(http, supabaseAnonKey, sp.GetRequiredService<ILogger<HistorialClient>>()));

builder.Services.AddHttpClient<IReposClient, ReposClient>(c =>
    {
        c.BaseAddress = new Uri(supabaseUrl);
        c.Timeout = TimeSpan.FromSeconds(10);
    })
    .AddTypedClient<IReposClient>((http, sp) =>
        new ReposClient(http, supabaseAnonKey, sp.GetRequiredService<ILogger<ReposClient>>()));

builder.Services.AddHttpClient<IDocumentosClient, DocumentosClient>(c =>
    {
        c.BaseAddress = new Uri(supabaseUrl);
        // Mas que los 10 del resto: aca viajan archivos de hasta 20 MB, y con el
        // tope corto una subida grande fallaba por lenta y no por rota.
        c.Timeout = TimeSpan.FromSeconds(60);
    })
    .AddTypedClient<IDocumentosClient>((http, sp) =>
        new DocumentosClient(http, supabaseAnonKey, sp.GetRequiredService<ILogger<DocumentosClient>>()));

if (!string.IsNullOrWhiteSpace(conversorUrl))
{
    builder.Services.AddHttpClient<IConversorClient, ConversorClient>(c =>
    {
        c.BaseAddress = new Uri(conversorUrl);
        // Convertir un PDF grande tarda. El conversor corta a los 60s por su
        // cuenta; este tope es un poco mayor para que el error que llegue sea el
        // suyo —que explica que paso— y no un timeout de aca, que no explica
        // nada. Mismo criterio que el nginx del front con el panel.
        c.Timeout = TimeSpan.FromSeconds(75);
    });
}
else
{
    builder.Services.AddSingleton<IConversorClient, SinConversor>();
}

builder.Services.AddHttpClient<IInstalacionesClient, InstalacionesClient>(c =>
    {
        c.BaseAddress = new Uri(supabaseUrl);
        c.Timeout = TimeSpan.FromSeconds(10);
    })
    .AddTypedClient<IInstalacionesClient>((http, sp) =>
        new InstalacionesClient(
            http, supabaseAnonKey, sp.GetRequiredService<ILogger<InstalacionesClient>>()));

// La App como singleton: adentro tiene el cache de tokens por instalacion, y uno
// por pedido lo tiraria en cada turno — que es justo lo que el cache evita.
//
// Null cuando no hay App configurada. Los endpoints que la necesitan contestan
// que no esta configurada; los turnos siguen andando por SSH.
GitHubApp? githubApp = null;
if (!string.IsNullOrWhiteSpace(githubAppId) && !string.IsNullOrWhiteSpace(githubAppKey))
{
    // Se construye ACA y no perezosamente: si la clave esta mal, el panel tiene
    // que no arrancar. Descubrirlo en el primer push del usuario es peor.
    githubApp = new GitHubApp(githubAppId, githubAppKey, () => DateTimeOffset.UtcNow);
}
builder.Services.AddSingleton(new AppDeGitHub(githubApp, githubAppSlug));
// El HttpClient con el que se le habla a la API de GitHub. Aparte del de
// Supabase: otro host, otro timeout, y que se caiga uno no puede afectar al otro.
builder.Services.AddHttpClient("github", c => c.Timeout = TimeSpan.FromSeconds(15));

builder.Services.AddHttpClient<INombresClient, NombresClient>(c =>
    {
        c.BaseAddress = new Uri(supabaseUrl);
        c.Timeout = TimeSpan.FromSeconds(10);
    })
    .AddTypedClient<INombresClient>((http, sp) =>
        new NombresClient(http, supabaseAnonKey, sp.GetRequiredService<ILogger<NombresClient>>()));

builder.Services.AddHttpClient<IProyectosClient, ProyectosClient>(c =>
    {
        c.BaseAddress = new Uri(supabaseUrl);
        c.Timeout = TimeSpan.FromSeconds(10);
    })
    .AddTypedClient<IProyectosClient>((http, sp) =>
        new ProyectosClient(http, supabaseAnonKey, sp.GetRequiredService<ILogger<ProyectosClient>>()));

builder.Services.AddHttpClient<IAgentesClient, AgentesClient>(c =>
    {
        c.BaseAddress = new Uri(supabaseUrl);
        c.Timeout = TimeSpan.FromSeconds(10);
    })
    .AddTypedClient<IAgentesClient>((http, sp) =>
        new AgentesClient(http, supabaseAnonKey, sp.GetRequiredService<ILogger<AgentesClient>>()));

builder.Services.AddScoped<PanoramaService>();

// --- autenticacion --------------------------------------------------------
//
// El JWT de Supabase se verifica LOCALMENTE contra el JWKS, que se trae una vez
// y se cachea. Si el panel llamara a Supabase en cada request, una caida de
// Supabase lo voltearia — y Supabase no puede estar en el camino del request.
builder.Services
    .AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(o =>
    {
        o.MetadataAddress = $"{supabaseUrl}/auth/v1/.well-known/openid-configuration";
        // Solo en Development, y el guard de arriba ya garantizo que en
        // cualquier otro entorno la URL es https.
        o.RequireHttpsMetadata = !esDesarrollo;
        o.TokenValidationParameters = new TokenValidationParameters
        {
            ValidIssuer = $"{supabaseUrl}/auth/v1",
            ValidAudience = audiencia,
            ValidateIssuer = true,
            ValidateAudience = true,
            ValidateLifetime = true,
            ValidateIssuerSigningKey = true,
            // Lista blanca explicita: sin esto un atacante reescribe el header a
            // `alg: none` o a HS256 usando como secreto la clave publica del
            // JWKS, que es publica por definicion.
            ValidAlgorithms = [SecurityAlgorithms.RsaSha256, SecurityAlgorithms.EcdsaSha256],
            ClockSkew = TimeSpan.FromSeconds(30),
        };
        o.MapInboundClaims = false;
        // Sin esto, GetTokenAsync devuelve null y el historial recibiria un JWT
        // vacio EN SILENCIO: Supabase lo rechazaria por RLS y el panel diria
        // "sin probar" para siempre sin ningun error visible.
        o.SaveToken = true;
    });
builder.Services.AddAuthorization();

var app = builder.Build();

// --- rutas ----------------------------------------------------------------

app.UseAuthentication();
app.UseAuthorization();

app.MapGet("/health", () => Results.Ok(new { status = "ok" }));

// Sin auth a proposito: el navegador necesita estos dos valores ANTES de poder
// autenticarse. La clave anon es publica por diseño (viaja al navegador); los
// bearers del gateway, del login y del bridge viven en este mismo proceso y NO
// pueden salir por aca.
app.MapGet("/config.json", () => Results.Ok(new ConfigFront(supabaseUrl, supabaseAnonKey)));

/// <remarks>
/// El token de GitHub de un proyecto, para el BRIDGE.
///
/// Existe por un pliegue del diseño: los turnos de Telegram entran por el
/// bridge, que no pasa por el panel, y firmar un token necesita la clave privada
/// de la App. La alternativa era duplicar la firma en TypeScript, y eso pone la
/// clave privada en dos servicios y deja dos implementaciones de la misma
/// criptografia que mantener sincronizadas. Asi la clave vive en UN solo lado.
///
/// Fuera de /api a proposito: /api exige el JWT de un USUARIO y aca no hay
/// usuario — es un servicio hablandole a otro. Se autentica con el
/// BRIDGE_API_TOKEN que los dos ya comparten.
///
/// El bridge le habla por la red interna de Docker (http://panel:8091), asi que
/// esto no se publica en ningun hostname. Aun asi lleva bearer: la contencion
/// por topologia y el bearer son capas distintas, y este endpoint devuelve una
/// credencial.
/// </remarks>
app.MapPost("/interno/github/token", async (
    CuerpoTokenInterno cuerpo, HttpContext ctx, AppDeGitHub gh,
    IHttpClientFactory clientes, CancellationToken ct) =>
{
    var header = ctx.Request.Headers.Authorization.ToString();
    var recibido = header.StartsWith("Bearer ", StringComparison.Ordinal)
        ? header["Bearer ".Length..]
        : "";
    // Comparacion en tiempo fijo: un `==` sobre strings corta en el primer byte
    // distinto, y eso deja adivinar el token de a un caracter midiendo el tiempo.
    if (!System.Security.Cryptography.CryptographicOperations.FixedTimeEquals(
            Encoding.UTF8.GetBytes(recibido), Encoding.UTF8.GetBytes(bridgeToken)))
    {
        return Results.Unauthorized();
    }

    if (gh.App is null || cuerpo.InstallationId <= 0)
    {
        // Sin token, y no es un error: el bridge sigue y el turno va por SSH.
        return Results.Ok(new { token = (string?)null });
    }

    try
    {
        // El panel FIRMA, no busca. Quien busca la instalacion es el bridge, en
        // su propio Postgres, donde conecta como `postgres` y no pasa por RLS.
        //
        // Es a proposito y no una division arbitraria: para leer la fila desde
        // aca sin un usuario, el panel necesitaria la service_role key — que
        // ademas de dar acceso total a la base administra auth, y el panel es el
        // unico servicio expuesto a internet. Esa credencial se le nego en el
        // diseño original (ver el comentario de HistorialClient) y no hay razon
        // para dársela ahora.
        var token = await gh.App.TokenDeInstalacionAsync(
            cuerpo.InstallationId, clientes.CreateClient("github"), ct);
        return Results.Ok(new { token });
    }
    catch (UpstreamException)
    {
        return Results.Ok(new { token = (string?)null });
    }
}).AllowAnonymous();

var api = app.MapGroup("/api").RequireAuthorization();

/// El JWT crudo del usuario, ya verificado por el middleware. Se lo reenvia a
/// Supabase para que RLS decida: el panel no tiene credencial de escritura.
/// <summary>
/// El token de instalacion del proyecto, o null.
///
/// Null en los tres casos normales, y ninguno es un error: no hay App
/// configurada en este despliegue, el proyecto no la instalo, o GitHub no
/// contesto. En los tres el turno sigue y el gateway usa SSH.
/// </summary>
static async Task<string?> TokenDeGitHub(
    AppDeGitHub gh,
    IInstalacionesClient instalaciones,
    IHttpClientFactory clientes,
    ILoggerFactory logs,
    string jwt,
    string proyectoId,
    CancellationToken ct)
{
    if (gh.App is null) return null;

    var inst = await instalaciones.DeProyectoAsync(jwt, proyectoId, ct);
    if (inst is null) return null;

    try
    {
        return await gh.App.TokenDeInstalacionAsync(inst.InstallationId, clientes.CreateClient("github"), ct);
    }
    catch (Exception ex) when (ex is UpstreamException or HttpRequestException or TaskCanceledException)
    {
        // Se loguea y se sigue. El caso tipico es que el usuario desinstalo la
        // App desde GitHub: la fila queda y el 404 llega aca.
        logs.CreateLogger("github").LogWarning(
            ex, "no se pudo firmar el token de {Proyecto}; el turno va por SSH", proyectoId);
        return null;
    }
}

static async Task<string> JwtDe(HttpContext ctx)
    => await ctx.GetTokenAsync("access_token") ?? "";

api.MapGet("/panorama", async (HttpContext ctx, PanoramaService svc, CancellationToken ct) =>
{
    try
    {
        return Results.Ok(await svc.VerAsync(await JwtDe(ctx), ct));
    }
    catch (Exception ex) when (ex is HttpRequestException or UpstreamException or TaskCanceledException)
    {
        // 503 y no 500: el panel esta bien, lo que no responde es el gateway.
        // El detalle va al log; al navegador le vuelve algo generico.
        app.Logger.LogError(ex, "no pude armar el panorama");
        return Results.Json(
            new { code = "gateway_unavailable", message = "no pude leer el estado de los agentes" },
            statusCode: StatusCodes.Status503ServiceUnavailable);
    }
});

// La forma de un nombre de repo, en un solo lugar. Es la misma que valida el
// CHECK de la tabla y la misma que `NombreDeRepo` en el gateway: este valor
// termina siendo un directorio en el disco de la VM.
static bool NombreDeRepoValido(string nombre)
    => nombre.Length is > 0 and <= 100
       && nombre is not ("." or "..")
       && System.Text.RegularExpressions.Regex.IsMatch(nombre, "^[A-Za-z0-9._-]+$");

// Un solo lugar donde se valida la forma del slot, para que ninguna ruta nueva
// se olvide de la mitad.
static IResult? SlotInvalido(string slot)
    => Slot.EsValido(slot)
        ? null
        : Results.NotFound(new { code = "unknown_agent", message = slot });

// Cuelga del proyecto, y no es cosmetico: el turno de prueba crea y actualiza
// el worktree de ESE proyecto en la VM. Con la ruta vieja —/slots/{slot}/test—
// el panel no tenia como decir cual, y el gateway recibia el valor de
// PANEL_PROJECT.
api.MapPost("/proyectos/{proyectoId}/slots/{slot}/test", async (
    string proyectoId, string slot, HttpContext ctx, IGatewayClient gateway,
    IProyectosClient proyectos, IReposClient repos, IHistorialClient historial,
    IInstalacionesClient instalaciones, IAgentesClient agentesDb, AppDeGitHub gh,
    IHttpClientFactory clientes, ILoggerFactory logs, CancellationToken ct) =>
{
    if (SlotInvalido(slot) is { } malo) return malo;

    // Misma razon que en el endpoint de turnos: el gateway no sabe que es un
    // proyecto ni un usuario, asi que la membresia se valida ACA. Sin esto se
    // puede pedir un turno —aunque sea trivial— sobre el worktree de un
    // proyecto ajeno.
    var jwt = await JwtDe(ctx);
    var nombre = await proyectos.NombreSiEsMiembroAsync(jwt, proyectoId, ct);
    if (nombre is null) return Results.Forbid();

    // Los mismos repos que en un turno de verdad: el test tiene que correr en el
    // mismo worktree, o deja de probar lo que importa.
    var vinculados = await repos.DeProyectoAsync(jwt, proyectoId, ct);
    // Y el mismo token: un test que clona distinto que un turno no prueba lo que
    // hace falta, y sin token el clon va por SSH y falla en repos que solo
    // conoce la App.
    var githubToken = await TokenDeGitHub(gh, instalaciones, clientes, logs, jwt, proyectoId, ct);
    var r = await gateway.ProbarAsync(nombre, slot, vinculados, githubToken, ct);

    // Quedarse sin cuota es un estado del SLOT, no un fallo del test: sigue
    // siendo cierto hasta la hora de reset aunque nadie vuelva a probar. Se
    // anota para que el panel pueda decir "vuelve a las 19:50" en vez de un
    // "el ultimo test fallo" que no dice que hacer.
    //
    // Y un test que SALE BIEN la limpia: es la prueba de que volvio la cuota.
    if (Cuota.EsSinCuota(r.Detalle))
    {
        await agentesDb.MarcarCuotaAsync(jwt, slot, Cuota.HoraDeReset(r.Detalle) ?? "pronto", ct);
    }
    else if (r.Ok)
    {
        await agentesDb.MarcarCuotaAsync(jwt, slot, null, ct);
    }
    // El fallo TAMBIEN se guarda, y es el registro que mas importa: es el que
    // te deja ver que c2 viene fallando desde el martes.
    await historial.GuardarAsync(jwt, slot, r, ct);
    // 200 aunque el test falle: el endpoint funciono y la respuesta es "este
    // slot no anda".
    return Results.Ok(r);
});

api.MapGet("/slots/{slot}/login/start", async (string slot, ILoginClient login, CancellationToken ct) =>
{
    if (SlotInvalido(slot) is { } malo) return malo;
    try
    {
        return Results.Ok(new { url = await login.IniciarAsync(slot, ct) });
    }
    catch (Exception ex) when (ex is UpstreamException or HttpRequestException)
    {
        return Results.BadRequest(new { code = "login_failed", message = ex.Message });
    }
});

api.MapPost("/slots/{slot}/login/code", async (
    string slot, CuerpoCodigo cuerpo, ILoginClient login, CancellationToken ct) =>
{
    if (SlotInvalido(slot) is { } malo) return malo;
    if (string.IsNullOrWhiteSpace(cuerpo.Code))
    {
        return Results.BadRequest(new { code = "login_failed", message = "falta el código" });
    }
    try
    {
        await login.CodigoAsync(slot, cuerpo.Code, ct);
        // Sin eco del codigo: es de un solo uso y es material de autenticacion.
        return Results.Ok(new { estado = "ok" });
    }
    catch (Exception ex) when (ex is UpstreamException or HttpRequestException)
    {
        return Results.BadRequest(new { code = "login_failed", message = ex.Message });
    }
});

api.MapPost("/slots/{slot}/login/token", async (
    string slot, CuerpoToken cuerpo, ILoginClient login, CancellationToken ct) =>
{
    if (SlotInvalido(slot) is { } malo) return malo;
    if (string.IsNullOrWhiteSpace(cuerpo.Token) || string.IsNullOrWhiteSpace(cuerpo.Account))
    {
        return Results.BadRequest(new { code = "login_failed", message = "falta el token o la cuenta" });
    }
    try
    {
        await login.TokenAsync(slot, cuerpo.Token, cuerpo.Account, ct);
        // El token NO vuelve, ni siquiera como confirmacion: el campo es de
        // solo escritura.
        return Results.Ok(new { estado = "ok" });
    }
    catch (Exception ex) when (ex is UpstreamException or HttpRequestException)
    {
        return Results.BadRequest(new { code = "login_failed", message = ex.Message });
    }
});

api.MapDelete("/slots/{slot}/login", async (string slot, ILoginClient login, CancellationToken ct) =>
{
    if (SlotInvalido(slot) is { } malo) return malo;
    try
    {
        await login.BorrarAsync(slot, ct);
        return Results.Ok(new { estado = "ok" });
    }
    catch (Exception ex) when (ex is UpstreamException or HttpRequestException)
    {
        return Results.BadRequest(new { code = "login_failed", message = ex.Message });
    }
});

// --- nombres de slot ------------------------------------------------------
//
// Los nombres los pone el usuario y viven en Supabase, no en el compose: el
// gateway descubre los slots por sus URLs y no sabe ni le importa como se
// llaman. Por eso son un recurso aparte y no un campo del panorama.

/// El limite es de presentacion: entra en la franja de la tarjeta sin cortarse.
const int LargoMaximoNombre = 60;

api.MapGet("/slots/nombres", async (HttpContext ctx, INombresClient nombres, CancellationToken ct) =>
    Results.Ok(await nombres.TodosAsync(await JwtDe(ctx), ct)));

api.MapPut("/slots/{slot}/nombre", async (
    string slot,
    NuevoNombre cuerpo,
    HttpContext ctx,
    INombresClient nombres,
    CancellationToken ct) =>
{
    if (SlotInvalido(slot) is { } malo) return malo;

    // Recortado antes de validar: "   " tiene largo 3 pero es un nombre vacio, y
    // guardarlo dejaria la tarjeta sin titulo.
    var nombre = cuerpo.Nombre?.Trim() ?? "";
    if (nombre.Length == 0)
    {
        return Results.BadRequest(new { code = "nombre_vacio", message = "el nombre no puede estar vacío" });
    }
    if (nombre.Length > LargoMaximoNombre)
    {
        return Results.BadRequest(new
        {
            code = "nombre_largo",
            message = $"el nombre no puede pasar de {LargoMaximoNombre} caracteres",
        });
    }

    try
    {
        await nombres.GuardarAsync(await JwtDe(ctx), slot, nombre, ct);
        return Results.Ok(new { slot, nombre });
    }
    catch (Exception ex) when (ex is UpstreamException or HttpRequestException)
    {
        app.Logger.LogError(ex, "no se pudo guardar el nombre de {Slot}", slot);
        return Results.Json(
            new { code = "nombre_no_guardado", message = "no se pudo guardar el nombre" },
            statusCode: StatusCodes.Status503ServiceUnavailable);
    }
});

// --- proyectos, miembros e invitaciones ------------------------------------

api.MapPost("/proyectos", async (
    CuerpoProyecto cuerpo,
    HttpContext ctx,
    IProyectosClient proyectos,
    CancellationToken ct) =>
{
    var nombre = cuerpo.Nombre?.Trim() ?? "";
    // El nombre termina en /srv/work/<agente>/<proyecto>: una barra lo sacaria
    // del directorio. Se valida aca ademas de en el CHECK de la tabla porque un
    // 400 explicado es mejor que un 500 con un error de Postgres adentro.
    if (!NombreDeProyecto().IsMatch(nombre) || nombre is "." or "..")
    {
        return Results.BadRequest(new
        {
            code = "nombre_invalido",
            message = "letras, números, punto, guión y guión bajo",
        });
    }

    try
    {
        // Crear el proyecto y quedar como dueño son UNA operacion, en la base:
        // un proyecto sin dueño no lo puede ver nadie, ni siquiera quien lo
        // creo, y no habria forma de arreglarlo desde la aplicacion.
        var id = await proyectos.CrearAsync(await JwtDe(ctx), nombre, ct);
        return Results.Created($"/api/proyectos/{id}", new { id, nombre });
    }
    catch (UpstreamException ex) when (ex.Message == "nombre_repetido")
    {
        return Results.Conflict(new { code = "nombre_repetido", message = "ya existe un proyecto con ese nombre" });
    }
    catch (Exception ex) when (ex is UpstreamException or HttpRequestException)
    {
        app.Logger.LogError(ex, "no se pudo crear el proyecto {Nombre}", nombre);
        return Results.Json(
            new { code = "proyecto_no_creado", message = "no se pudo crear el proyecto" },
            statusCode: StatusCodes.Status503ServiceUnavailable);
    }
});

api.MapPost("/proyectos/{proyectoId}/invitaciones", async (
    string proyectoId,
    CuerpoInvitacion cuerpo,
    HttpContext ctx,
    IProyectosClient proyectos,
    CancellationToken ct) =>
{
    var email = cuerpo.Email?.Trim() ?? "";
    if (email.Length == 0 || !email.Contains('@', StringComparison.Ordinal))
    {
        return Results.BadRequest(new { code = "email_invalido", message = "hace falta un mail" });
    }
    if (cuerpo.Rol is not ("dueño" or "miembro"))
    {
        return Results.BadRequest(new { code = "rol_invalido", message = "el rol es dueño o miembro" });
    }

    var jwt = await JwtDe(ctx);

    // Invitar es de dueños. Sin esto, un miembro suma gente al proyecto ajeno.
    // La funcion de la base lo vuelve a chequear —ese es el que no se puede
    // saltear— pero aca se puede contestar un 403 limpio en vez de un 503.
    var rol = await proyectos.RolDeAsync(jwt, proyectoId, ct);
    if (rol != "dueño") return Results.StatusCode(StatusCodes.Status403Forbidden);

    try
    {
        var token = await proyectos.InvitarAsync(jwt, proyectoId, email, cuerpo.Rol, ct);
        // El token se devuelve y se comparte a mano: mandar el mail pide un
        // proveedor y un dominio verificado, y es lo unico que falta para que
        // esto sea una invitacion de verdad.
        return Results.Ok(new { token });
    }
    catch (UpstreamException ex) when (ex.Message == "no_sos_dueño")
    {
        return Results.StatusCode(StatusCodes.Status403Forbidden);
    }
    catch (Exception ex) when (ex is UpstreamException or HttpRequestException)
    {
        app.Logger.LogError(ex, "no se pudo invitar a {Proyecto}", proyectoId);
        return Results.Json(
            new { code = "invitacion_fallo", message = "no se pudo crear la invitación" },
            statusCode: StatusCodes.Status503ServiceUnavailable);
    }
});

api.MapPost("/invitaciones/{token}/aceptar", async (
    string token,
    HttpContext ctx,
    IProyectosClient proyectos,
    CancellationToken ct) =>
{
    try
    {
        var proyectoId = await proyectos.AceptarAsync(await JwtDe(ctx), token, ct);
        return Results.Ok(new { proyectoId });
    }
    catch (Exception ex) when (ex is UpstreamException or HttpRequestException)
    {
        // Vencida, usada o inexistente se contestan igual: distinguirlas le
        // diria a alguien con un token al azar si existe o no.
        return Results.BadRequest(new
        {
            code = "invitacion_no_sirve",
            message = "esa invitación no sirve: puede estar vencida o ya usada",
        });
    }
});

// --- agentes de un proyecto -----------------------------------------------

/// <remarks>
/// Crear un agente es crear un contenedor, y el panel no toca Docker: le pide
/// el slot al gateway, que elige cual y se lo manda al dockerproxy. Recien
/// despues se anota la fila, porque una fila sin contenedor no significa nada.
/// </remarks>
// --- la GitHub App --------------------------------------------------------

/// <remarks>
/// Tres endpoints para un solo flujo: el panel te manda a GitHub, elegis los
/// repos con checkboxes, y GitHub vuelve al callback con el installation_id.
/// </remarks>
api.MapGet("/proyectos/{proyectoId}/github", async (
    string proyectoId, HttpContext ctx, AppDeGitHub gh,
    IProyectosClient proyectos, IInstalacionesClient instalaciones, CancellationToken ct) =>
{
    var jwt = await JwtDe(ctx);
    if (await proyectos.NombreSiEsMiembroAsync(jwt, proyectoId, ct) is null)
    {
        return Results.StatusCode(StatusCodes.Status403Forbidden);
    }

    var inst = await instalaciones.DeProyectoAsync(jwt, proyectoId, ct);
    return Results.Ok(new
    {
        // Si este despliegue no registro la App, la pantalla tiene que poder
        // decirlo en vez de mostrar un boton que no lleva a ningun lado.
        configurada = gh.EstaConfigurada,
        instalada = inst is not null,
        cuenta = inst?.Cuenta,
        // El `state` es el proyecto: es lo que hace que el callback sepa a cual
        // atribuir la instalacion. GitHub lo devuelve tal cual.
        url = gh.EstaConfigurada
            ? $"https://github.com/apps/{gh.Slug}/installations/new?state={proyectoId}"
            : null,
    });
});

/// <remarks>
/// A donde vuelve GitHub despues de instalar.
///
/// Es el unico endpoint de /api que NO exige sesion —lo abre el navegador
/// siguiendo un redirect de GitHub, sin el header de autorizacion— y por eso
/// tampoco puede escribir nada: guardar la instalacion pide saber quien sos, y
/// aca no se sabe. Lo unico que hace es rebotar al front con los datos en la
/// URL, y el front llama a POST /github con su sesion.
///
/// Sin esto habria que confiar en un `state` para autorizar una escritura, que
/// es exactamente el agujero de CSRF que este rodeo evita.
/// </remarks>
app.MapGet("/api/github/callback", (string? installation_id, string? state) =>
{
    if (string.IsNullOrWhiteSpace(installation_id) || string.IsNullOrWhiteSpace(state))
    {
        return Results.BadRequest(new { code = "callback_incompleto" });
    }
    // Los dos valores van a la URL, asi que se validan: llegan de afuera y
    // terminan en un header Location.
    if (!long.TryParse(installation_id, out var id) || id <= 0 || !Guid.TryParse(state, out _))
    {
        return Results.BadRequest(new { code = "callback_invalido" });
    }
    // A /configuracion y no a /proyectos: la seccion de GitHub vive ahi, que es
    // donde esta todo lo que se configura una vez. El front lee estos dos
    // parametros, guarda con el JWT del usuario y los limpia de la URL.
    return Results.Redirect($"/configuracion?instalacion={id}&proyecto={state}");
}).AllowAnonymous();

/// <remarks>
/// Los repos que la instalacion puede ver, con los ya vinculados marcados.
///
/// Es la pantalla que hace que la App valga la pena: sin esto el usuario tiene
/// que tipear `owner/nombre` a mano, que es el paso que la App venia a eliminar.
/// </remarks>
api.MapGet("/proyectos/{proyectoId}/github/repos", async (
    string proyectoId, HttpContext ctx, AppDeGitHub gh, IProyectosClient proyectos,
    IInstalacionesClient instalaciones, IReposClient repos, IHttpClientFactory clientes,
    CancellationToken ct) =>
{
    var jwt = await JwtDe(ctx);
    if (await proyectos.NombreSiEsMiembroAsync(jwt, proyectoId, ct) is null)
    {
        return Results.StatusCode(StatusCodes.Status403Forbidden);
    }
    if (gh.App is null) return Results.Ok(Array.Empty<object>());

    var inst = await instalaciones.DeProyectoAsync(jwt, proyectoId, ct);
    if (inst is null) return Results.Ok(Array.Empty<object>());

    try
    {
        var deGitHub = await gh.App.ReposDeInstalacionAsync(
            inst.InstallationId, clientes.CreateClient("github"), ct);
        // Los ya vinculados, para marcarlos. Se compara por `github_repo` y no
        // por nombre: dos repos de owners distintos pueden llamarse igual, y el
        // que decide de donde se clona es el owner/nombre.
        var vinculados = (await repos.DeProyectoAsync(jwt, proyectoId, ct))
            .Select(r => r.GithubRepo)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);

        return Results.Ok(deGitHub.Select(r => new
        {
            github_repo = r.FullName,
            nombre = r.Nombre,
            privado = r.Privado,
            vinculado = vinculados.Contains(r.FullName),
        }));
    }
    catch (UpstreamException ex)
    {
        // 404 de GitHub = la instalacion ya no existe (el usuario desinstalo la
        // App). Lista vacia y no un error: la pantalla muestra el boton de
        // conectar, que es lo que hay que hacer.
        return ex.Message == "github_404"
            ? Results.Ok(Array.Empty<object>())
            : Results.BadRequest(new { code = ex.Message, message = "no pudimos leer los repos de GitHub" });
    }
});

api.MapPost("/proyectos/{proyectoId}/github", async (
    string proyectoId, CuerpoInstalacion cuerpo, HttpContext ctx, AppDeGitHub gh,
    IInstalacionesClient instalaciones, IHttpClientFactory clientes, CancellationToken ct) =>
{
    if (gh.App is null) return Results.BadRequest(new { code = "app_no_configurada" });
    if (cuerpo.InstallationId <= 0) return Results.BadRequest(new { code = "instalacion_invalida" });

    var jwt = await JwtDe(ctx);

    // Se le pregunta a GITHUB de quien es la instalacion, y no se confia en lo
    // que llego. Sin esto, cualquiera puede postear el installation_id de otro y
    // apuntar su proyecto a la instalacion ajena — el `state` del callback viaja
    // por la URL del navegador y no prueba nada.
    //
    // Que el token se pueda firmar ES la prueba: solo la App puede hacerlo, y
    // solo para instalaciones que existen.
    string cuenta;
    try
    {
        // La cuenta sale de GitHub y NO del cuerpo del pedido: se muestra como
        // "instalada en X", y un dato que llega del navegador puede decir
        // cualquier cosa. La llamada es la verificacion y el dato a la vez.
        cuenta = await gh.App.CuentaDeInstalacionAsync(
            cuerpo.InstallationId, clientes.CreateClient("github"), ct);
    }
    catch (UpstreamException ex)
    {
        return Results.BadRequest(new { code = ex.Message, message = "esa instalación no es válida" });
    }

    try
    {
        // RLS deja escribir solo al dueño: ver docs/supabase-github-instalaciones.sql.
        await instalaciones.GuardarAsync(jwt, proyectoId, new Instalacion(cuerpo.InstallationId, cuenta), ct);
        return Results.Ok(new { estado = "ok" });
    }
    catch (UpstreamException ex)
    {
        return ex.Message == "no_sos_dueño"
            ? Results.StatusCode(StatusCodes.Status403Forbidden)
            : Results.BadRequest(new { code = ex.Message });
    }
});

// --- repos vinculados -----------------------------------------------------

api.MapGet("/proyectos/{proyectoId}/repos", async (
    string proyectoId, HttpContext ctx, IProyectosClient proyectos, IReposClient repos,
    CancellationToken ct) =>
{
    var jwt = await JwtDe(ctx);
    // La membresia se chequea igual aunque RLS ya filtre: sin esto, un proyecto
    // ajeno devuelve 200 con lista vacia, que le dice al usuario "no tenes
    // repos" en vez de "esto no es tuyo".
    if (await proyectos.NombreSiEsMiembroAsync(jwt, proyectoId, ct) is null)
    {
        return Results.StatusCode(StatusCodes.Status403Forbidden);
    }
    return Results.Ok(await repos.DeProyectoAsync(jwt, proyectoId, ct));
});

// --- documentos -----------------------------------------------------------

/// <remarks>
/// Los documentos de un proyecto: un pliego en PDF, una lista de precios en
/// Excel. El agente los lee en su worktree como un archivo mas — ya tiene Read,
/// Grep y Glob, asi que no hace falta ninguna herramienta nueva.
///
/// Ver el diseño en el repo de la VM:
/// docs/superpowers/specs/2026-09-01-documentos-vinculados-design.md
/// </remarks>
api.MapGet("/proyectos/{proyectoId}/documentos", async (
    string proyectoId, HttpContext ctx, IProyectosClient proyectos,
    IDocumentosClient documentos, CancellationToken ct) =>
{
    var jwt = await JwtDe(ctx);
    // Se chequea igual aunque RLS filtre: sin esto un proyecto ajeno devuelve
    // 200 con lista vacia, que le dice al usuario "no tenes documentos" en vez
    // de "esto no es tuyo".
    if (await proyectos.NombreSiEsMiembroAsync(jwt, proyectoId, ct) is null)
    {
        return Results.StatusCode(StatusCodes.Status403Forbidden);
    }
    return Results.Ok(await documentos.DeProyectoAsync(jwt, proyectoId, ct));
});

api.MapPost("/proyectos/{proyectoId}/documentos", async (
    string proyectoId, HttpContext ctx, IProyectosClient proyectos,
    IDocumentosClient documentos, IConversorClient conversor, CancellationToken ct) =>
{
    var jwt = await JwtDe(ctx);
    if (await proyectos.NombreSiEsMiembroAsync(jwt, proyectoId, ct) is null)
    {
        return Results.StatusCode(StatusCodes.Status403Forbidden);
    }

    if (!ctx.Request.HasFormContentType)
    {
        return Results.BadRequest(new { code = "sin_archivo", message = "falta el archivo" });
    }

    var form = await ctx.Request.ReadFormAsync(ct);
    var archivo = form.Files.FirstOrDefault();
    if (archivo is null || archivo.Length == 0)
    {
        return Results.BadRequest(new { code = "sin_archivo", message = "falta el archivo" });
    }
    if (archivo.Length > Documentos.MaximoBytes)
    {
        return Results.BadRequest(new
        {
            code = "muy_grande",
            message = $"el archivo pasa los {Documentos.MaximoBytes / (1024 * 1024)} MB",
        });
    }

    var tipo = Documentos.TipoDe(archivo.FileName);
    if (tipo is null)
    {
        return Results.BadRequest(new
        {
            code = "tipo_desconocido",
            message = $"no se leer archivos de ese tipo. Se puede: {string.Join(", ", Documentos.Tipos)}",
        });
    }

    // El nombre para el disco se DERIVA del original y no llega del cliente: es
    // lo que arma la ruta del worktree, y un `../` ahi escribe fuera de /srv.
    var nombre = Documentos.NombreDeArchivo(archivo.FileName, tipo);

    using var ms = new MemoryStream();
    await archivo.CopyToAsync(ms, ct);
    var datos = ms.ToArray();

    // Se convierte ACA, una vez, y no en el gateway antes de cada turno: el
    // error aparece con el archivo en la mano —"este PDF es un escaneo"— y no
    // como un turno raro tres capas mas abajo. Y el costo se paga una vez.
    var conversion = await conversor.ConvertirAsync(datos, tipo, ct);

    try
    {
        var doc = await documentos.SubirAsync(
            jwt, proyectoId, nombre, archivo.FileName, tipo, datos,
            conversion.Texto, conversion.Error, ct);
        // 200 aunque la conversion falle: el documento se guardo y el `error`
        // viaja adentro para que la pantalla lo muestre al lado del archivo. Un
        // 400 aca haria perder el original que la persona ya subio.
        return Results.Ok(doc);
    }
    catch (UpstreamException ex)
    {
        return ex.Message == "no_sos_miembro"
            ? Results.StatusCode(StatusCodes.Status403Forbidden)
            : Results.BadRequest(new { code = ex.Message, message = "no se pudo guardar el documento" });
    }
}).DisableAntiforgery();

api.MapGet("/proyectos/{proyectoId}/documentos/{nombre}/descarga", async (
    string proyectoId, string nombre, HttpContext ctx, IProyectosClient proyectos,
    IDocumentosClient documentos, CancellationToken ct) =>
{
    var jwt = await JwtDe(ctx);
    if (await proyectos.NombreSiEsMiembroAsync(jwt, proyectoId, ct) is null)
    {
        return Results.StatusCode(StatusCodes.Status403Forbidden);
    }
    if (!Documentos.NombreValido(nombre))
    {
        return Results.BadRequest(new { code = "nombre_invalido", message = "ese nombre no es valido" });
    }

    // El archivo por aca y no una URL firmada: desde que los documentos viven
    // en el disco del servidor, no hay a donde mandar al navegador. El tope de
    // subida son 20 MB y una descarga la pide alguien a mano, asi que el costo
    // de hacer de proxy esta acotado.
    var datos = await documentos.DescargarAsync(jwt, proyectoId, nombre, ct);
    return datos is null
        ? Results.NotFound(new { code = "no_esta", message = "ese documento no existe" })
        : Results.File(datos, "application/octet-stream", nombre);
});

api.MapDelete("/proyectos/{proyectoId}/documentos/{nombre}", async (
    string proyectoId, string nombre, HttpContext ctx, IProyectosClient proyectos,
    IDocumentosClient documentos, CancellationToken ct) =>
{
    var jwt = await JwtDe(ctx);
    if (await proyectos.NombreSiEsMiembroAsync(jwt, proyectoId, ct) is null)
    {
        return Results.StatusCode(StatusCodes.Status403Forbidden);
    }
    if (!Documentos.NombreValido(nombre))
    {
        return Results.BadRequest(new { code = "nombre_invalido", message = "ese nombre no es valido" });
    }

    try
    {
        await documentos.BorrarAsync(jwt, proyectoId, nombre, ct);
        return Results.Ok(new { estado = "ok" });
    }
    catch (UpstreamException ex)
    {
        return Results.BadRequest(new { code = ex.Message, message = "no se pudo borrar el documento" });
    }
});

api.MapPost("/proyectos/{proyectoId}/repos", async (
    string proyectoId, CuerpoRepo cuerpo, HttpContext ctx,
    IProyectosClient proyectos, IReposClient repos, CancellationToken ct) =>
{
    var nombre = cuerpo.Nombre?.Trim() ?? "";
    var github = cuerpo.GithubRepo?.Trim() ?? "";

    // La misma forma que valida el CHECK de la tabla. Duplicado a proposito:
    // aca da un mensaje legible, y el constraint impide que una fila mal formada
    // entre por otro camino (el SQL editor, un script). El nombre arma una ruta
    // en disco del lado del gateway.
    if (!NombreDeRepoValido(nombre))
    {
        return Results.BadRequest(
            new { code = "nombre_invalido", message = "el nombre no puede tener barras ni puntos suspensivos" });
    }
    if (!System.Text.RegularExpressions.Regex.IsMatch(github, "^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$"))
    {
        return Results.BadRequest(
            new { code = "github_invalido", message = "escribilo como owner/nombre" });
    }

    var jwt = await JwtDe(ctx);
    if (await proyectos.NombreSiEsMiembroAsync(jwt, proyectoId, ct) is null)
    {
        return Results.StatusCode(StatusCodes.Status403Forbidden);
    }

    try
    {
        await repos.VincularAsync(jwt, proyectoId, new Repo(nombre, github), ct);
        return Results.Ok(new { estado = "ok" });
    }
    catch (UpstreamException ex)
    {
        return Results.BadRequest(new { code = ex.Message, message = "no se pudo vincular el repo" });
    }
});

api.MapDelete("/proyectos/{proyectoId}/repos/{nombre}", async (
    string proyectoId, string nombre, HttpContext ctx,
    IProyectosClient proyectos, IReposClient repos, CancellationToken ct) =>
{
    var jwt = await JwtDe(ctx);
    if (await proyectos.NombreSiEsMiembroAsync(jwt, proyectoId, ct) is null)
    {
        return Results.StatusCode(StatusCodes.Status403Forbidden);
    }
    // Desvincular NO borra el espejo de /srv/repos ni nada de GitHub: saca la
    // fila y listo. Borrar el disco desde una pantalla web es una asimetria
    // peligrosa entre lo que el boton dice y lo que hace.
    await repos.DesvincularAsync(jwt, proyectoId, nombre, ct);
    return Results.Ok(new { estado = "ok" });
});

api.MapPost("/proyectos/{proyectoId}/agentes", async (
    string proyectoId,
    HttpContext ctx,
    IProyectosClient proyectos,
    IGatewayClient gateway,
    IAgentesClient agentes,
    CancellationToken ct) =>
{
    var jwt = await JwtDe(ctx);

    // La membresia se valida ACA. El gateway no sabe que es un proyecto ni un
    // usuario —es deliberado, ver el spec— asi que si el panel no chequea, no
    // chequea nadie. En la practica la respuesta la da RLS: un proyecto ajeno
    // devuelve cero filas.
    var nombre = await proyectos.NombreSiEsMiembroAsync(jwt, proyectoId, ct);
    if (nombre is null)
    {
        return Results.StatusCode(StatusCodes.Status403Forbidden);
    }

    try
    {
        // El gateway recibe el NOMBRE y no el id: es lo que termina en la
        // etiqueta del contenedor y en la ruta del worktree, y es lo unico del
        // proyecto que ese lado del sistema entiende.
        var slot = await gateway.CrearSlotAsync(nombre, ct);
        await agentes.RegistrarAsync(jwt, proyectoId, slot, ct);
        return Results.Created($"/api/proyectos/{proyectoId}/agentes/{slot}", new { slot });
    }
    catch (UpstreamException ex) when (ex.Message == "sin_slots")
    {
        return Results.Conflict(new { code = "sin_slots", message = "no quedan slots libres" });
    }
    catch (Exception ex) when (ex is UpstreamException or HttpRequestException)
    {
        app.Logger.LogError(ex, "no se pudo crear un agente en {Proyecto}", proyectoId);
        return Results.Json(
            new { code = "agente_no_creado", message = "no se pudo crear el agente" },
            statusCode: StatusCodes.Status503ServiceUnavailable);
    }
});

// --- el chat con los agentes ----------------------------------------------

/// <remarks>
/// El turno se lo pide al bridge y no al gateway, aunque el gateway sea quien
/// tiene al agente: el bridge es el que sabe crear el job, colgar el poller de
/// aprobaciones y guardar la sesion del hilo. Sin eso, el chat del panel seria
/// una conversacion distinta de la de Telegram.
/// </remarks>
api.MapPost("/proyectos/{proyectoId}/agentes/{slot}/turnos", async (
    string proyectoId,
    string slot,
    CuerpoTurno cuerpo,
    HttpContext ctx,
    IProyectosClient proyectos,
    IReposClient repos,
    IDocumentosClient documentos,
    IInstalacionesClient instalaciones,
    AppDeGitHub gh,
    IHttpClientFactory clientes,
    IBridgeClient bridge,
    ILoggerFactory logs,
    CancellationToken ct) =>
{
    if (SlotInvalido(slot) is { } malo) return malo;

    var prompt = cuerpo.Prompt?.Trim() ?? "";
    if (prompt.Length == 0)
    {
        return Results.BadRequest(new { code = "prompt_vacio", message = "escribí algo" });
    }

    var usuarioId = ctx.User.FindFirst("sub")?.Value;
    if (string.IsNullOrWhiteSpace(usuarioId)) return Results.Unauthorized();

    var jwt = await JwtDe(ctx);

    // Aca y solo aca: el bridge confia en que el panel ya valido, porque su
    // endpoint vive detras del bearer y no lo alcanza el navegador. Chequearlo
    // tambien alla obligaria al bridge a conocer proyectos y usuarios, que es
    // justo lo que el spec decidio evitar.
    var nombre = await proyectos.NombreSiEsMiembroAsync(jwt, proyectoId, ct);
    if (nombre is null) return Results.StatusCode(StatusCodes.Status403Forbidden);

    // Los repos vinculados, con el JWT del usuario: RLS decide, asi que un repo
    // de un proyecto ajeno no aparece. Viajan con el turno porque el gateway no
    // le habla a Supabase — sin esto cae a su catalogo local, que solo conoce
    // `demo` y `sincroresto`.
    var vinculados = await repos.DeProyectoAsync(jwt, proyectoId, ct);

    // El token de instalacion de la GitHub App, si el proyecto la instalo.
    //
    // Que falle NO corta el turno: sin token el gateway va por SSH con la deploy
    // key, que es como funcionaba antes de la App. Un problema con GitHub tiene
    // que degradar el push, no impedir que el agente trabaje.
    var githubToken = await TokenDeGitHub(
        gh, instalaciones, clientes, logs, jwt, proyectoId, ct);

    try
    {
        // Los documentos del proyecto, con URLs firmadas. Aparte de los repos
        // porque son otra cosa: los repos se clonan y versionan, los documentos
        // se bajan y se leen.
        var docs = await documentos.ParaElTurnoAsync(jwt, proyectoId, ct);

        var r = await bridge.TurnoAsync(
            proyectoId, nombre, slot, usuarioId, prompt, vinculados, githubToken, docs, ct);
        return Results.Ok(r);
    }
    catch (Exception ex) when (ex is UpstreamException or HttpRequestException or TaskCanceledException)
    {
        // El `code` que vuelve es el del agente (agent_unavailable,
        // sin_credencial…): se propaga, porque es lo que le dice al usuario que
        // hacer. 502 y no 500: lo que fallo esta del otro lado.
        var code = ex is UpstreamException ? ex.Message : "turno_fallo";
        app.Logger.LogError(ex, "fallo el turno de {Slot} en {Proyecto}", slot, proyectoId);
        return Results.Json(
            new { code, message = "el agente no pudo contestar" },
            statusCode: StatusCodes.Status502BadGateway);
    }
});

// --- aprobaciones ---------------------------------------------------------

api.MapPost("/aprobaciones/{id}/decision", async (
    string id,
    CuerpoDecision cuerpo,
    HttpContext ctx,
    IBridgeClient bridge,
    CancellationToken ct) =>
{
    if (cuerpo.Decision is not ("allow" or "deny"))
    {
        return Results.BadRequest(new { code = "decision_invalida", message = "allow o deny" });
    }

    // El usuarioId sale del JWT, igual que en la vinculacion: confiar en lo que
    // el navegador manda seria dejar que cualquiera firme la decision de otro.
    var usuarioId = ctx.User.FindFirst("sub")?.Value;
    if (string.IsNullOrWhiteSpace(usuarioId)) return Results.Unauthorized();

    try
    {
        await bridge.DecidirAsync(id, cuerpo.Decision, cuerpo.Feedback, usuarioId, ct);
        return Results.Ok(new { estado = "ok" });
    }
    catch (UpstreamException ex) when (ex.Message == "ya_decidida")
    {
        return Results.Conflict(new { code = "ya_decidida", message = "alguien la decidió antes" });
    }
    catch (UpstreamException ex) when (ex.Message == "desconocida")
    {
        return Results.NotFound(new { code = "desconocida", message = "esa aprobación no existe" });
    }
    catch (Exception ex) when (ex is UpstreamException or HttpRequestException)
    {
        app.Logger.LogError(ex, "no se pudo decidir la aprobacion {Id}", id);
        return Results.Json(
            new { code = "decision_fallo", message = "no se pudo registrar la decisión" },
            statusCode: StatusCodes.Status503ServiceUnavailable);
    }
});

// --- vinculacion de telegram ----------------------------------------------

api.MapPost("/telegram/vincular", async (
    CuerpoVinculo cuerpo,
    HttpContext ctx,
    IBridgeClient bridge,
    CancellationToken ct) =>
{
    if (string.IsNullOrWhiteSpace(cuerpo.Codigo))
    {
        return Results.BadRequest(new { code = "codigo_vacio", message = "el codigo no puede estar vacio" });
    }

    // El usuarioId sale del JWT: confiar en lo que el usuario envia seria un
    // agujero. El JWT ya esta verificado por el middleware de autenticacion.
    var usuarioId = ctx.User.FindFirst("sub")?.Value;
    if (string.IsNullOrWhiteSpace(usuarioId))
    {
        return Results.Unauthorized();
    }

    try
    {
        await bridge.CanjearVinculoAsync(cuerpo.Codigo, usuarioId, ct);
        return Results.Ok(new { estado = "ok" });
    }
    catch (Exception ex) when (ex is UpstreamException or HttpRequestException)
    {
        // Un codigo vencido, usado o desconocido no es un error del endpoint:
        // el endpoint funciono y devolvio la razon especifica por la que fallo.
        return Results.BadRequest(new { code = "vinculo_fallo", message = ex.Message });
    }
});

// --- el front -------------------------------------------------------------
//
// En el despliegue de hoy esto NO sirve nada: el front vive en su propio repo y
// en su propia imagen, y es el nginx de esa imagen el que sirve el bundle y
// hace de proxy hacia aca. La imagen de este servicio ya no tiene wwwroot, asi
// que estas tres lineas son inertes y el fallback devuelve 404.
//
// Se dejan igual porque siguen siendo utiles corriendo el panel a mano con un
// wwwroot al lado, que es lo mas rapido para reproducir un bug de integracion
// sin levantar los dos contenedores. Van DESPUES de las rutas para que ningun
// archivo estatico pueda tapar una de /api.
app.UseDefaultFiles();
app.UseStaticFiles();
// Angular maneja el ruteo del lado del cliente: cualquier ruta que no sea /api
// ni un archivo existente devuelve el index para que la SPA la resuelva.
app.MapFallbackToFile("index.html");

app.Run();

/// <summary>Existe para que WebApplicationFactory pueda tipar el host en los tests.</summary>
public partial class Program
{
    /// <summary>
    /// La forma de un nombre de proyecto.
    ///
    /// Espeja el CHECK `proyectos_nombre_forma` de la tabla: los dos tienen que
    /// moverse juntos. Existe del lado del panel solo para poder contestar un
    /// 400 explicado en vez de un 500 con un error de Postgres adentro.
    /// </summary>
    [System.Text.RegularExpressions.GeneratedRegex(@"\A[a-zA-Z0-9._-]+\z")]
    private static partial System.Text.RegularExpressions.Regex NombreDeProyecto();
}
