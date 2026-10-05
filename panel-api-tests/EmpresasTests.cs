using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;

namespace MultiCodigo.Panel.Tests;

/// <summary>
/// Lo que el panel agrega para empresas (spec 2026-10-04-empresas-design.md):
/// crear proyectos es de admins y con visibilidad, el lector no escribe, aprobar
/// es escribir, y el alta de una cuenta entra sin sesión.
///
/// Las reglas en sí las decide la base (y se prueban en el bridge contra
/// Postgres); acá se prueba que el panel las consulte y conteste bien.
/// </summary>
public class EmpresasTests(PanelFactory f) : IClassFixture<PanelFactory>
{
    private const string Proyecto = "55555555-5555-4555-8555-555555555555";

    private HttpClient Cliente(bool conSesion = true)
    {
        var c = f.CreateClient();
        if (conSesion)
        {
            c.DefaultRequestHeaders.Authorization =
                new AuthenticationHeaderValue("Bearer", AuthDePrueba.TokenValido);
        }
        return c;
    }

    [Fact]
    public async Task CrearProyectoPasaLaVisibilidad()
    {
        var r = await Cliente().PostAsJsonAsync("/api/proyectos", new { nombre = "acme-web", visibilidad = "publico" });
        Assert.Equal(HttpStatusCode.Created, r.StatusCode);
        Assert.Contains("publico", f.Proyectos.Visibilidades);
    }

    [Fact]
    public async Task SinVisibilidadElProyectoEsPrivado()
    {
        var antes = f.Proyectos.Visibilidades.Count;
        var r = await Cliente().PostAsJsonAsync("/api/proyectos", new { nombre = "acme-privado" });
        Assert.Equal(HttpStatusCode.Created, r.StatusCode);
        Assert.Equal("privado", f.Proyectos.Visibilidades[antes]);
    }

    [Fact]
    public async Task UnaVisibilidadInventadaEsUn400()
    {
        var r = await Cliente().PostAsJsonAsync("/api/proyectos", new { nombre = "x1", visibilidad = "secreto" });
        Assert.Equal(HttpStatusCode.BadRequest, r.StatusCode);
    }

    [Fact]
    public async Task QuienNoEsAdminNoCreaProyectos()
    {
        var c = new PanelFactory();
        c.Proyectos.NoEsAdmin = true;
        var cliente = c.CreateClient();
        cliente.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", AuthDePrueba.TokenValido);

        var r = await cliente.PostAsJsonAsync("/api/proyectos", new { nombre = "x2" });
        Assert.Equal(HttpStatusCode.Forbidden, r.StatusCode);
        Assert.Contains("solo_admin", await r.Content.ReadAsStringAsync(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task ElLectorNoEscribeEnElProyecto()
    {
        f.Proyectos.SoloLectura.Add(Proyecto);
        try
        {
            var turno = await Cliente().PostAsJsonAsync(
                $"/api/proyectos/{Proyecto}/agentes/c1/turnos", new { prompt = "hola" });
            Assert.Equal(HttpStatusCode.Forbidden, turno.StatusCode);
            Assert.Contains("solo_lectura", await turno.Content.ReadAsStringAsync(), StringComparison.Ordinal);

            var agente = await Cliente().PostAsync($"/api/proyectos/{Proyecto}/agentes", null);
            Assert.Equal(HttpStatusCode.Forbidden, agente.StatusCode);

            // Leer no pasa por el filtro: lo que ve lo decide RLS.
            var leer = await Cliente().GetAsync($"/api/proyectos/{Proyecto}/github");
            Assert.DoesNotContain("solo_lectura", await leer.Content.ReadAsStringAsync(), StringComparison.Ordinal);
        }
        finally
        {
            f.Proyectos.SoloLectura.Remove(Proyecto);
        }
    }

    [Fact]
    public async Task SinPermisoNoSeDecideUnaAprobacion()
    {
        const string aprobacion = "66666666-6666-4666-8666-666666666666";
        f.Proyectos.SinDecidir.Add(aprobacion);
        try
        {
            var r = await Cliente().PostAsJsonAsync($"/api/aprobaciones/{aprobacion}/decision", new { decision = "allow" });
            Assert.Equal(HttpStatusCode.Forbidden, r.StatusCode);
            Assert.DoesNotContain(f.Bridge.Decisiones, d => d.Id == aprobacion);
        }
        finally
        {
            f.Proyectos.SinDecidir.Remove(aprobacion);
        }
    }

    [Fact]
    public async Task ElAltaEntraSinSesionYDevuelveElMail()
    {
        var r = await Cliente(conSesion: false).PostAsJsonAsync("/api/altas/un-token", new { clave = "una-clave-larga" });
        Assert.Equal(HttpStatusCode.OK, r.StatusCode);
        Assert.Contains("pedro@multicodigo.app", await r.Content.ReadAsStringAsync(), StringComparison.Ordinal);
        Assert.Contains(("un-token", "una-clave-larga"), f.Bridge.Altas);
    }

    [Fact]
    public async Task ElRechazoDelBridgeLlegaConSuMensaje()
    {
        var c = new PanelFactory();
        c.Bridge.RespuestaAlta = new ResultadoAlta(false, null, "alta_vencida", "ese link venció");
        var r = await c.CreateClient().PostAsJsonAsync("/api/altas/viejo", new { clave = "una-clave-larga" });
        Assert.Equal(HttpStatusCode.BadRequest, r.StatusCode);
        var texto = await r.Content.ReadAsStringAsync();
        Assert.Contains("alta_vencida", texto, StringComparison.Ordinal);
        Assert.Contains("venció", texto, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ElTrabajoEnCursoEsDelUsuarioDelJwt()
    {
        var c = new PanelFactory();
        c.Bridge.Trabajo = [new TrabajoEnCurso("c3", null, "web", "claude/c3/trabajo", ["src/a.ts"], true)];
        var cliente = c.CreateClient();
        cliente.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", AuthDePrueba.TokenValido);

        var r = await cliente.GetAsync("/api/trabajo");
        Assert.Equal(HttpStatusCode.OK, r.StatusCode);
        var texto = await r.Content.ReadAsStringAsync();
        Assert.Contains("src/a.ts", texto, StringComparison.Ordinal);
        Assert.Equal([AuthDePrueba.Usuario], c.Bridge.TrabajoPedido);
        Assert.Equal(HttpStatusCode.Unauthorized, (await c.CreateClient().GetAsync("/api/trabajo")).StatusCode);
    }

    [Fact]
    public async Task UnAltaSinClaveNoLlegaAlBridge()
    {
        var antes = f.Bridge.Altas.Count;
        var r = await Cliente(conSesion: false).PostAsJsonAsync("/api/altas/un-token", new { clave = "" });
        Assert.Equal(HttpStatusCode.BadRequest, r.StatusCode);
        Assert.Equal(antes, f.Bridge.Altas.Count);
    }
}
