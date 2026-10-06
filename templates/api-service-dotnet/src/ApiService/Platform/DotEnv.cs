namespace ApiService.Platform;

/// <summary>
/// Loads <c>.env.local</c> then <c>.env</c> into the process environment, for local development only.
/// .NET reads no .env file by itself, and AICO writes the generated secrets of a new app to
/// <c>.env.local</c>. It never overrides a variable that is already set (the real environment wins)
/// and it does nothing outside the Development environment, so production config is only ever the
/// environment. Deliberately tiny: KEY=VALUE lines, optional quotes, # comments, no interpolation.
/// </summary>
internal static class DotEnv
{
    private static readonly string[] FileNames = [".env.local", ".env"];

    public static void LoadForDevelopment(Func<string, string?> getVariable, Action<string, string> setVariable, string startDirectory)
    {
        ArgumentNullException.ThrowIfNull(getVariable);
        ArgumentNullException.ThrowIfNull(setVariable);

        var environment = getVariable("ASPNETCORE_ENVIRONMENT") ?? getVariable("DOTNET_ENVIRONMENT");
        if (!string.Equals(environment, "Development", StringComparison.OrdinalIgnoreCase))
        {
            return;
        }

        var directory = new DirectoryInfo(startDirectory);
        for (var depth = 0; directory is not null && depth < 4; depth++, directory = directory.Parent)
        {
            foreach (var name in FileNames)
            {
                var path = Path.Combine(directory.FullName, name);
                if (File.Exists(path))
                {
                    Apply(File.ReadAllLines(path), getVariable, setVariable);
                }
            }

            // The solution root marks where the project ends: never read a stranger's .env above it.
            if (directory.EnumerateFiles("*.slnx").Any() || directory.EnumerateFiles("*.sln").Any())
            {
                return;
            }
        }
    }

    internal static void Apply(IEnumerable<string> lines, Func<string, string?> getVariable, Action<string, string> setVariable)
    {
        foreach (var raw in lines)
        {
            var line = raw.Trim();
            if (line.Length == 0 || line[0] == '#')
            {
                continue;
            }

            var eq = line.IndexOf('=', StringComparison.Ordinal);
            if (eq <= 0)
            {
                continue;
            }

            var key = line[..eq].Trim();
            var value = line[(eq + 1)..].Trim();
            if (value.Length >= 2 && (value[0] == '"' || value[0] == '\'') && value[^1] == value[0])
            {
                value = value[1..^1];
            }

            if (getVariable(key) is null)
            {
                setVariable(key, value);
            }
        }
    }
}
