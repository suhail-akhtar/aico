using ApiService.Features.Auth;
using Microsoft.Extensions.Options;

namespace ApiService.Tests;

/// <summary>
/// Pins the password-hashing policy. The numbers are a security decision (OWASP Password Storage Cheat
/// Sheet: Argon2id with at least 19 MiB, 2 iterations, 1 lane; RFC 9106 second profile m=64 MiB, t=3);
/// lowering them must fail a test and be argued in a pull request, never slip in as a refactor.
/// </summary>
public sealed class PasswordHasherTests
{
    private static Argon2idPasswordHasher Hasher(PasswordHashingOptions? options = null) =>
        new(Options.Create(options ?? new PasswordHashingOptions()));

    [Fact]
    public void Policy_defaults_are_pinned_at_or_above_the_OWASP_minimum()
    {
        var policy = new PasswordHashingOptions();

        Assert.Equal(64 * 1024, policy.MemoryKiB);
        Assert.Equal(3, policy.Iterations);
        Assert.Equal(1, policy.Parallelism);
        Assert.Equal(16, policy.SaltBytes);
        Assert.Equal(32, policy.HashBytes);

        // And explicitly not below OWASP's floor (19 MiB, t=2, p=1).
        Assert.True(policy.MemoryKiB >= 19 * 1024);
        Assert.True(policy.Iterations >= 2);
    }

    [Fact]
    public async Task A_hash_is_a_phc_string_carrying_its_parameters_and_verifies()
    {
        var hasher = Hasher();
        var hash = await hasher.HashAsync("correct horse battery staple");

        Assert.StartsWith("$argon2id$v=19$m=65536,t=3,p=1$", hash, StringComparison.Ordinal);
        Assert.Equal(PasswordVerification.Success, await hasher.VerifyAsync(hash, "correct horse battery staple"));
        Assert.Equal(PasswordVerification.Failed, await hasher.VerifyAsync(hash, "correct horse battery stapleX"));
    }

    [Fact]
    public async Task Two_hashes_of_one_password_differ_because_each_has_its_own_salt()
    {
        var hasher = Hasher(Cheap());

        Assert.NotEqual(await hasher.HashAsync("same password"), await hasher.HashAsync("same password"));
    }

    [Fact]
    public async Task A_hash_made_under_a_weaker_policy_verifies_and_asks_to_be_upgraded()
    {
        var old = await Hasher(Cheap()).HashAsync("legacy password value");

        var result = await Hasher(Cheap(memory: 128, iterations: 2)).VerifyAsync(old, "legacy password value");

        Assert.Equal(PasswordVerification.SuccessRehashNeeded, result);
    }

    [Theory]
    [InlineData("")]
    [InlineData("plaintext")]
    [InlineData("$argon2i$v=19$m=64,t=1,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNoaGFzaA")]
    [InlineData("$argon2id$v=18$m=64,t=1,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNoaGFzaA")]
    [InlineData("$argon2id$v=19$m=64,t=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNoaGFzaA")]
    [InlineData("$argon2id$v=19$m=99999999,t=1,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNoaGFzaA")]
    [InlineData("$argon2id$v=19$m=64,t=0,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNoaGFzaA")]
    [InlineData("$argon2id$v=19$m=64,t=1,p=1$!!!$aGFzaGhhc2hoYXNoaGFzaA")]
    public async Task Malformed_or_hostile_stored_hashes_fail_closed_without_work(string stored)
    {
        Assert.Equal(PasswordVerification.Failed, await Hasher(Cheap()).VerifyAsync(stored, "anything"));
    }

    private static PasswordHashingOptions Cheap(int memory = 64, int iterations = 1) => new() { MemoryKiB = memory, Iterations = iterations };
}
