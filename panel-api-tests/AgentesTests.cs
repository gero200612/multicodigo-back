using System.Net;
using System.Net.Http.Headers;

namespace MultiCodigo.Panel.Tests;

/// <summary>
/// Borrar un agente: DELETE /api/proyectos/{proyectoId}/agentes/{slot}.
///
/// Borra la fila de `agentes`, el contenedor (el numero queda libre), la cuenta
/// de Claude cargada y las conversaciones. El historial de jobs/test_runs queda.
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
        // f.Agentes vive en el fixture de la clase entera: sin este Clear, un
        // Borrado que dejo otro [Fact] (p.ej. el de 204) hace que la lista ya
        // no este vacia y el assert de abajo falle sin que este test rompa nada.
        f.Agentes.Borrados.Clear();

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

    /// <summary>"Si borro el c9 se borra": contenedor, cuenta y conversaciones.</summary>
    [Fact]
    public async Task Borrar_agente_borra_contenedor_cuenta_y_conversaciones()
    {
        f.Gateway.SlotsBorrados.Clear();
        var r = await Cliente().DeleteAsync($"/api/proyectos/{ProyectoDePrueba}/agentes/c2");

        Assert.Equal(HttpStatusCode.NoContent, r.StatusCode);
        Assert.Contains("c2", f.Gateway.SlotsBorrados);
        Assert.Contains("c2", f.Login.HomesVaciados);
        Assert.Contains("c2", f.Bridge.SesionesBorradas);
    }

    /// <summary>Trabajando no se borra: no se tocó ni la fila ni la cuenta.</summary>
    [Fact]
    public async Task Borrar_agente_trabajando_da_409_y_lo_deja_como_estaba()
    {
        f.Gateway.SlotOcupado = true;
        f.Agentes.Borrados.Clear();
        f.Login.HomesVaciados.Clear();
        try
        {
            var r = await Cliente().DeleteAsync($"/api/proyectos/{ProyectoDePrueba}/agentes/c1");

            Assert.Equal(HttpStatusCode.Conflict, r.StatusCode);
            Assert.Contains("agente_ocupado", await r.Content.ReadAsStringAsync(), StringComparison.Ordinal);
            Assert.Empty(f.Agentes.Borrados);
            Assert.DoesNotContain("c1", f.Login.HomesVaciados);
        }
        finally
        {
            f.Gateway.SlotOcupado = false;
        }
    }

    /// <summary>El Claude de otra persona: 403 y no se toca nada (migración 048).</summary>
    [Fact]
    public async Task Borrar_el_claude_de_otro_da_403_y_no_toca_nada()
    {
        f.Agentes.NoEsTuyo = true;
        f.Gateway.SlotsBorrados.Clear();
        f.Agentes.Borrados.Clear();
        try
        {
            var r = await Cliente().DeleteAsync($"/api/proyectos/{ProyectoDePrueba}/agentes/c1");
            Assert.Equal(HttpStatusCode.Forbidden, r.StatusCode);
            Assert.Contains("no_es_tu_claude", await r.Content.ReadAsStringAsync(), StringComparison.Ordinal);
            Assert.Empty(f.Gateway.SlotsBorrados);
            Assert.Empty(f.Agentes.Borrados);
        }
        finally
        {
            f.Agentes.NoEsTuyo = false;
        }
    }

    /// <summary>Un agente que no es del proyecto no llega a tocar el contenedor.</summary>
    [Fact]
    public async Task Borrar_agente_ajeno_no_toca_el_contenedor()
    {
        f.Agentes.NoEncontrado = true;
        f.Gateway.SlotsBorrados.Clear();
        try
        {
            var r = await Cliente().DeleteAsync($"/api/proyectos/{ProyectoDePrueba}/agentes/c9");
            Assert.Equal(HttpStatusCode.NotFound, r.StatusCode);
            Assert.Empty(f.Gateway.SlotsBorrados);
        }
        finally
        {
            f.Agentes.NoEncontrado = false;
        }
    }

}
