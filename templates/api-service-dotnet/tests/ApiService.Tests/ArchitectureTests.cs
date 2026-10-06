using ApiService.Features.Auth;
using ApiService.Features.Items;
using NetArchTest.Rules;

namespace ApiService.Tests;

/// <summary>
/// The structure rules from docs/ARCHITECTURE.md, executable. They are what keeps "one project with feature
/// folders" from decaying into a tangle, and what makes the later split into modules (or projects) a move
/// of files instead of an untangling. A failing rule names the offending types.
/// </summary>
public sealed class ArchitectureTests
{
    private const string Root = "ApiService";
    private static readonly System.Reflection.Assembly App = typeof(Program).Assembly;

    private static PredicateList AppTypes() => Types.InAssembly(App).That().DoNotResideInNamespace($"{Root}.Persistence.Migrations");

    private static void Holds(NetArchTest.Rules.TestResult result, string rule) =>
        Assert.True(result.IsSuccessful, $"{rule}. Offending types: {string.Join(", ", result.FailingTypeNames ?? [])}");

    [Fact]
    public void Features_do_not_reach_into_each_other()
    {
        Holds(
            AppTypes().And().ResideInNamespace($"{Root}.Features.Items").ShouldNot().HaveDependencyOn($"{Root}.Features.Auth").GetResult(),
            "Items must not depend on Auth");
        Holds(
            AppTypes().And().ResideInNamespace($"{Root}.Features.Auth").ShouldNot().HaveDependencyOn($"{Root}.Features.Items").GetResult(),
            "Auth must not depend on Items");
    }

    [Fact]
    public void The_shared_kernel_depends_on_nothing_of_the_application()
    {
        Holds(
            AppTypes().And().ResideInNamespace($"{Root}.SharedKernel").ShouldNot()
                .HaveDependencyOnAny($"{Root}.Features", $"{Root}.Persistence", $"{Root}.Platform").GetResult(),
            "SharedKernel is the bottom layer");
    }

    [Fact]
    public void The_platform_knows_no_feature_and_no_persistence()
    {
        Holds(
            AppTypes().And().ResideInNamespace($"{Root}.Platform").ShouldNot()
                .HaveDependencyOnAny($"{Root}.Features", $"{Root}.Persistence").GetResult(),
            "Platform is cross-cutting infrastructure; features plug into it, never the reverse");
    }

    [Fact]
    public void Entities_are_free_of_web_framework_types()
    {
        foreach (var entity in new[] { typeof(Item), typeof(User), typeof(RefreshToken) })
        {
            Holds(
                Types.InAssembly(App).That().HaveName(entity.Name).And().ResideInNamespace(entity.Namespace!).ShouldNot().HaveDependencyOn("Microsoft.AspNetCore").GetResult(),
                $"{entity.Name} is domain logic: no ASP.NET Core types");
        }
    }

    [Fact]
    public void Endpoints_talk_to_services_never_to_the_database()
    {
        Holds(
            AppTypes().And().ResideInNamespace($"{Root}.Features").And().HaveNameEndingWith("Endpoints", StringComparison.Ordinal).ShouldNot().HaveDependencyOn($"{Root}.Persistence").GetResult(),
            "Endpoints translate HTTP; queries live in the service");
    }

    [Fact]
    public void Services_know_nothing_of_http()
    {
        Holds(
            AppTypes().And().ResideInNamespace($"{Root}.Features").And().HaveNameEndingWith("Service", StringComparison.Ordinal).ShouldNot().HaveDependencyOn("Microsoft.AspNetCore.Http").GetResult(),
            "A service is callable from a job or a test with no HttpContext");
    }

    [Fact]
    public void Concrete_classes_are_sealed()
    {
        Holds(
            AppTypes().And().AreClasses().And().AreNotAbstract().And().AreNotStatic().And().DoNotHaveName("Program")
                .And().DoNotHaveNameMatching("^<.*").And().DoNotHaveNameMatching(".*Display.*").Should().BeSealed().GetResult(),
            "Seal by default; unseal on purpose");
    }

    [Fact]
    public void Only_request_dtos_are_public()
    {
        var publicTypes = App.GetExportedTypes().Where(t => t.Namespace?.EndsWith("Migrations", StringComparison.Ordinal) != true).Select(t => t.Name).Order(StringComparer.Ordinal).ToArray();

        Assert.Equal(["ItemRequest", "LoginRequest", "Program", "RefreshRequest", "RegisterRequest"], publicTypes);
    }
}
