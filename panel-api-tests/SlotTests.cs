using MultiCodigo.Panel;

namespace MultiCodigo.Panel.Tests;

public class SlotTests
{
    [Theory]
    [InlineData("c1")]
    [InlineData("c2")]
    [InlineData("c9")]
    [InlineData("c10")]
    [InlineData("c42")]
    [InlineData("c99")]
    public void AceptaFormasValidas(string id) => Assert.True(Slot.EsValido(id));

    /// <summary>
    /// La MISMA lista que el test de AgentId en TypeScript.
    ///
    /// Hay dos implementaciones de una sola regla —una en zod y otra acá— y eso
    /// es una fuente de divergencia. Que los dos tests corran contra los mismos
    /// casos es lo que hace que separarse duela enseguida en vez de aparecer en
    /// producción como un slot que un servicio acepta y el otro no.
    /// </summary>
    [Theory]
    [InlineData("")]
    [InlineData("c0")]     // no hay slot cero
    [InlineData("c01")]    // cero a la izquierda: dos strings para el mismo slot
    [InlineData("c100")]   // fuera del rango de dos dígitos
    [InlineData("c1/x")]
    [InlineData("../c1")]
    [InlineData("c1/../c2")]
    [InlineData("c-1")]
    [InlineData("C1")]     // mayúscula: otro string para el mismo slot
    [InlineData("c1 ")]
    [InlineData("c1\n")]   // el ancla $ de .NET acepta un \n final si no se cuida
    [InlineData("gateway")]
    [InlineData("c1;rm")]
    public void RechazaFormasInvalidas(string id) => Assert.False(Slot.EsValido(id));

    [Fact]
    public void RechazaNull() => Assert.False(Slot.EsValido(null));
}
