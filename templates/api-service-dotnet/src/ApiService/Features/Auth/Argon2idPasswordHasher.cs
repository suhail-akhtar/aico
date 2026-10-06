using System.Security.Cryptography;
using System.Text;
using Konscious.Security.Cryptography;
using Microsoft.Extensions.Options;

namespace ApiService.Features.Auth;

/// <summary>Cost parameters for Argon2id, set in code on purpose: they are a security policy reviewed in a pull request, not an operational toggle.</summary>
internal sealed class PasswordHashingOptions
{
    /// <summary>64 MiB. OWASP minimum is 19 MiB with t=2, p=1; this is RFC 9106's second recommended profile with p=1 (m=64 MiB, t=3).</summary>
    public int MemoryKiB { get; set; } = 64 * 1024;

    public int Iterations { get; set; } = 3;

    public int Parallelism { get; set; } = 1;

    public int SaltBytes { get; set; } = 16;

    public int HashBytes { get; set; } = 32;
}

internal enum PasswordVerification
{
    Failed,
    Success,

    /// <summary>The password is right but the stored hash used weaker parameters than today's policy: re-hash it and save.</summary>
    SuccessRehashNeeded,
}

internal interface IPasswordHasher
{
    Task<string> HashAsync(string password);

    Task<PasswordVerification> VerifyAsync(string storedHash, string password);
}

/// <summary>
/// Argon2id (OWASP's first choice for password storage) producing the standard PHC string
/// <c>$argon2id$v=19$m=65536,t=3,p=1$salt$hash</c>. The parameters travel inside every hash, so raising
/// the policy later never locks anyone out: old hashes still verify and are upgraded at next login.
/// Verification is constant-time. Source for the figures: OWASP Password Storage Cheat Sheet
/// (https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html) and RFC 9106 section 4.
/// </summary>
internal sealed class Argon2idPasswordHasher(IOptions<PasswordHashingOptions> options) : IPasswordHasher
{
    private const int Argon2Version = 19; // 0x13, the only version the library implements.
    private const int MaxAcceptedMemoryKiB = 1024 * 1024; // refuse absurd stored parameters instead of allocating 4 GiB.

    public async Task<string> HashAsync(string password)
    {
        ArgumentNullException.ThrowIfNull(password);
        var policy = options.Value;
        var salt = RandomNumberGenerator.GetBytes(policy.SaltBytes);
        var hash = await Derive(password, salt, policy.MemoryKiB, policy.Iterations, policy.Parallelism, policy.HashBytes);
        return $"$argon2id$v={Argon2Version}$m={policy.MemoryKiB},t={policy.Iterations},p={policy.Parallelism}${Base64(salt)}${Base64(hash)}";
    }

    public async Task<PasswordVerification> VerifyAsync(string storedHash, string password)
    {
        ArgumentNullException.ThrowIfNull(storedHash);
        ArgumentNullException.ThrowIfNull(password);
        if (!TryParse(storedHash, out var parsed))
        {
            return PasswordVerification.Failed;
        }

        var actual = await Derive(password, parsed.Salt, parsed.MemoryKiB, parsed.Iterations, parsed.Parallelism, parsed.Hash.Length);
        if (!CryptographicOperations.FixedTimeEquals(actual, parsed.Hash))
        {
            return PasswordVerification.Failed;
        }

        var policy = options.Value;
        var weaker = parsed.MemoryKiB < policy.MemoryKiB || parsed.Iterations < policy.Iterations || parsed.Parallelism != policy.Parallelism || parsed.Hash.Length < policy.HashBytes;
        return weaker ? PasswordVerification.SuccessRehashNeeded : PasswordVerification.Success;
    }

    private static async Task<byte[]> Derive(string password, byte[] salt, int memoryKiB, int iterations, int parallelism, int length)
    {
        using var argon = new Argon2id(Encoding.UTF8.GetBytes(password))
        {
            Salt = salt,
            MemorySize = memoryKiB,
            Iterations = iterations,
            DegreeOfParallelism = parallelism,
        };
        return await argon.GetBytesAsync(length);
    }

    private static bool TryParse(string encoded, out (byte[] Salt, byte[] Hash, int MemoryKiB, int Iterations, int Parallelism) parsed)
    {
        parsed = default;
        var parts = encoded.Split('$');
        // "", "argon2id", "v=19", "m=..,t=..,p=..", salt, hash
        if (parts.Length != 6 || parts[0].Length != 0 || parts[1] != "argon2id" || parts[2] != $"v={Argon2Version}")
        {
            return false;
        }

        var cost = parts[3].Split(',');
        if (cost.Length != 3
            || !TryNumber(cost[0], "m=", out var memory)
            || !TryNumber(cost[1], "t=", out var iterations)
            || !TryNumber(cost[2], "p=", out var parallelism)
            || memory is < 8 or > MaxAcceptedMemoryKiB
            || iterations is < 1 or > 100
            || parallelism is < 1 or > 64)
        {
            return false;
        }

        try
        {
            parsed = (FromBase64(parts[4]), FromBase64(parts[5]), memory, iterations, parallelism);
            return parsed.Salt.Length >= 8 && parsed.Hash.Length >= 16;
        }
        catch (FormatException)
        {
            return false;
        }
    }

    private static bool TryNumber(string part, string prefix, out int value)
    {
        value = 0;
        return part.StartsWith(prefix, StringComparison.Ordinal)
            && int.TryParse(part.AsSpan(prefix.Length), System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out value);
    }

    private static string Base64(byte[] bytes) => Convert.ToBase64String(bytes).TrimEnd('=');

    private static byte[] FromBase64(string text) => Convert.FromBase64String(text.PadRight(text.Length + ((4 - (text.Length % 4)) % 4), '='));
}
