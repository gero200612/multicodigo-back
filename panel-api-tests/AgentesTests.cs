using System.Net;
using System.Net.Http.Headers;

namespace MultiCodigo.Panel.Tests;

/// <summary>
/// Borrar un agente: DELETE /api/proyectos/{proyectoId}/agentes/{slot}.
///
/// Borra la fila de `agentes` — el slot queda libre para que el gateway lo
/// reasigne — y no toca el contenedor Docker ni el historial de jobs/test_runs
/// de ese slot, que es cosa de otras piezas del sistema.
/// </summary>
public class AgentesTests(PanelFactory f) : IClassFixture<PanelFactory>
{
    private const string ProyectoDePrueba = "22222222-2222-4222-8222-222222222222";

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
    public async Task Borrar_agente_sin_sesion_da_401()
    {
        var r = await Cliente(conSesion: false)
            .DeleteAsync($"/api/proyectos/{ProyectoDePrueba}/agentes/c1");
        Assert.Equal(HttpStatusCode.Unauthorized, r.StatusCode);
    }

    [Fact]
    public async Task Borrar_agente_devuelve_204_y_no_cuerpo()
    {
        var r = await Cliente().DeleteAsync($"/api/proyectos/{ProyectoDePrueba}/agentes/c1");

        Assert.Equal(HttpStatusCode.NoContent, r.StatusCode);
        Assert.Contains(f.Agentes.Borrados, b => b.ProyectoId == ProyectoDePrueba && b.Slot == "c1");
    }

    /// <summary>Un slot con forma inválida ni siquiera llega a pedirle nada a Supabase.</summary>
    [Fact]
    public async Task Borrar_agente_con_slot_invalido_da_404_unknown_agent()
    {
        var r = await Cliente().DeleteAsync($"/api/proyectos/{ProyectoDePrueba}/agentes/x1");

        Assert.Equal(HttpStatusCode.NotFound, r.StatusCode);
        var texto = await r.Content.ReadAsStringAsync();
        Assert.Contains("unknown_agent", texto, StringComparison.Ordinal);
        Assert.Empty(f.Agentes.Borrados);
    }

    /// <summary>
    /// Slot con forma válida pero sin fila en ese proyecto: ya se había
    /// borrado, o es de otro proyecto (RLS lo deja igual que "no existe").
    /// </summary>
    [Fact]
    public async Task Borrar_agente_que_no_existe_da_404_agente_no_encontrado()
    {
        f.Agentes.NoEncontrado = true;
        try
        {
            var r = await Cliente().DeleteAsync($"/api/proyectos/{ProyectoDePrueba}/agentes/c9");

            Assert.Equal(HttpStatusCode.NotFound, r.StatusCode);
            var texto = await r.Content.ReadAsStringAsync();
            Assert.Contains("agente_no_encontrado", texto, StringComparison.Ordinal);
        }
        finally
        {
            f.Agentes.NoEncontrado = false;
        }
    }

    [Fact]
    public async Task Borrar_agente_si_supabase_falla_da_502()
    {
        f.Agentes.FallaBorrar = true;
        try
        {
            var r = await Cliente().DeleteAsync($"/api/proyectos/{ProyectoDePrueba}/agentes/c1");

            Assert.Equal(HttpStatusCode.BadGateway, r.StatusCode);
            var texto = await r.Content.ReadAsStringAsync();
            Assert.Contains("agente_no_borrado", texto, StringComparison.Ordinal);
        }
        finally
        {
            f.Agentes.FallaBorrar = false;
        }
    }
}
