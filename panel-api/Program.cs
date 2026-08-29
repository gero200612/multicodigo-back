using System.Net.Http.Headers;
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
var supabaseUrl = Requerido("SUPABASE_URL").TrimEnd('/');
var supabaseAnonKey = Requerido("SUPABASE_ANON_KEY");
var proyecto = cfg["PANEL_PROJECT"] ?? "demo";
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

static void ConBearer(HttpClient c, string baseUrl, string token)
{
    c.BaseAddress = new Uri(baseUrl);
    c.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
    // Corto: esto lo pide una pagina que se refresca sola. Un servicio colgado
    // no puede hacer esperar a la pagina entera.
    c.Timeout = TimeSpan.FromSeconds(20);
}

builder.Services.AddHttpClient<IGatewayClient, GatewayClient>(c => ConBearer(c, gatewayUrl, gatewayToken))
    .AddTypedClient<IGatewayClient>((http, _) => new GatewayClient(http, proyecto));
builder.Services.AddHttpClient<ILoginClient, LoginClient>(c => ConBearer(c, loginUrl, loginToken));
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

var api = app.MapGroup("/api").RequireAuthorization();

/// El JWT crudo del usuario, ya verificado por el middleware. Se lo reenvia a
/// Supabase para que RLS decida: el panel no tiene credencial de escritura.
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

// Un solo lugar donde se valida la forma del slot, para que ninguna ruta nueva
// se olvide de la mitad.
static IResult? SlotInvalido(string slot)
    => Slot.EsValido(slot)
        ? null
        : Results.NotFound(new { code = "unknown_agent", message = slot });

api.MapPost("/slots/{slot}/test", async (
    string slot, HttpContext ctx, IGatewayClient gateway, IHistorialClient historial, CancellationToken ct) =>
{
    if (SlotInvalido(slot) is { } malo) return malo;

    var r = await gateway.ProbarAsync(slot, ct);
    // El fallo TAMBIEN se guarda, y es el registro que mas importa: es el que
    // te deja ver que c2 viene fallando desde el martes.
    await historial.GuardarAsync(await JwtDe(ctx), slot, r, ct);
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

// --- agentes de un proyecto -----------------------------------------------

/// <remarks>
/// Crear un agente es crear un contenedor, y el panel no toca Docker: le pide
/// el slot al gateway, que elige cual y se lo manda al dockerproxy. Recien
/// despues se anota la fila, porque una fila sin contenedor no significa nada.
/// </remarks>
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
public partial class Program;
