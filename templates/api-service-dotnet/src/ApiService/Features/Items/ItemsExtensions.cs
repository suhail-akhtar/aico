namespace ApiService.Features.Items;

/// <summary>The Items feature's public surface to the composition root: one registration call and one mapping call.</summary>
internal static class ItemsExtensions
{
    public static WebApplicationBuilder AddItemsFeature(this WebApplicationBuilder builder)
    {
        ArgumentNullException.ThrowIfNull(builder);
        builder.Services.AddScoped<ItemService>();
        return builder;
    }
}
