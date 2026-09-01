using MultiCodigo.Panel;

namespace MultiCodigo.Panel.Tests;

/// <summary>
/// Cuándo un slot está sin cuota, y hasta cuándo.
///
/// El aviso lo escribe Anthropic en el texto de la respuesta y llega hasta acá
/// como el detalle de un test fallido. Sacarle la hora es lo que permite mostrar
/// "vuelve a las 19:50" en vez de un "sin cuota" que no dice si son diez minutos
/// o seis horas — que es la diferencia entre esperar y cargar otra cuenta.
/// </summary>
public class CuotaTests
{
    [Theory]
    // La forma real, vista en producción.
    [InlineData("usage_limit: You've hit your limit · resets 10:50pm (UTC)", "10:50pm")]
    [InlineData("usage_limit: You have hit your usage limit. Resets 5pm.", "5pm")]
    [InlineData("You've hit your limit · resets 11:05am (UTC)", "11:05am")]
    public void SacaLaHoraDelAviso(string detalle, string esperado)
    {
        Assert.Equal(esperado, Cuota.HoraDeReset(detalle));
    }

    [Theory]
    [InlineData("usage_limit: sin hora en el mensaje")]
    [InlineData("auth_expired: la credencial vencio")]
    [InlineData("")]
    [InlineData(null)]
    public void SinHoraDevuelveNull(string? detalle)
    {
        Assert.Null(Cuota.HoraDeReset(detalle));
    }

    [Theory]
    [InlineData("usage_limit: You've hit your limit", true)]
    [InlineData("usage_limit", true)]
    [InlineData("auth_expired: la credencial vencio", false)]
    [InlineData("git_failed", false)]
    [InlineData("", false)]
    [InlineData(null, false)]
    public void ReconoceElFalloPorCuota(string? detalle, bool esperado)
    {
        Assert.Equal(esperado, Cuota.EsSinCuota(detalle));
    }
}
