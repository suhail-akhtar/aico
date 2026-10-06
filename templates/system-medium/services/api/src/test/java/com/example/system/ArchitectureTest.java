package com.example.system;

import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.classes;
import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.noClasses;
import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.noFields;

import com.tngtech.archunit.core.importer.ImportOption;
import com.tngtech.archunit.junit.AnalyzeClasses;
import com.tngtech.archunit.junit.ArchTest;
import com.tngtech.archunit.lang.ArchRule;
import com.tngtech.archunit.library.GeneralCodingRules;

/**
 * The structure rules from docs/ARCHITECTURE.md, as tests. Inside a module the layers point one way
 * (api -> app -> domain <- infra); the shared kernel knows no module. Which module may use which is
 * Spring Modulith's job (ModularityTest, from the allowedDependencies declarations). A new feature
 * that copies the tasks package is checked by the same rules with no edit here (the patterns use a
 * wildcard for the feature name).
 */
@AnalyzeClasses(
    packages = "com.example.system",
    importOptions = ImportOption.DoNotIncludeTests.class)
class ArchitectureTest {

  private static final String DOMAIN = "com.example.system.*.domain..";
  private static final String APP = "com.example.system.*.app..";
  private static final String API = "com.example.system.*.api..";
  private static final String INFRA = "com.example.system.*.infra..";

  @ArchTest
  static final ArchRule domainIsFrameworkFree =
      classes()
          .that()
          .resideInAPackage(DOMAIN)
          .should()
          .onlyDependOnClassesThat()
          .resideInAnyPackage(
              "java..",
              "org.jspecify..",
              // Only the module-boundary marker annotation on the events package.
              "org.springframework.modulith..",
              "com.example.system.shared.error..",
              "com.example.system.shared.page..",
              DOMAIN)
          .because("domain rules must run and be tested without Spring, JPA or HTTP");

  @ArchTest
  static final ArchRule applicationLayerKnowsNeitherHttpNorStorage =
      noClasses()
          .that()
          .resideInAPackage(APP)
          .should()
          .dependOnClassesThat()
          .resideInAnyPackage(API, INFRA, "jakarta.persistence..", "jakarta.servlet..")
          .because("use cases talk to ports, never to controllers or JPA");

  @ArchTest
  static final ArchRule apiNeverTouchesInfrastructure =
      noClasses()
          .that()
          .resideInAPackage(API)
          .should()
          .dependOnClassesThat()
          .resideInAnyPackage(INFRA, "jakarta.persistence..", "org.springframework.data..")
          .because("controllers go through the application layer");

  @ArchTest
  static final ArchRule infrastructureIsReachedOnlyThroughPorts =
      noClasses()
          .that()
          .resideOutsideOfPackage(INFRA)
          .should()
          .dependOnClassesThat()
          .resideInAPackage(INFRA)
          .because("adapters are wired by Spring and used through domain ports");

  @ArchTest
  static final ArchRule jpaStaysInInfrastructure =
      noClasses()
          .that()
          .resideOutsideOfPackage(INFRA)
          .should()
          .dependOnClassesThat()
          .resideInAnyPackage("jakarta.persistence..", "org.springframework.data.jpa..")
          .because("persistence mapping is an adapter detail");

  @ArchTest
  static final ArchRule sharedKernelKnowsNoFeature =
      noClasses()
          .that()
          .resideInAPackage("com.example.system.shared..")
          .should()
          .dependOnClassesThat()
          .resideInAnyPackage(
              "com.example.system.tasks..",
              "com.example.system.identity..",
              "com.example.system.notifications..",
              "com.example.system.audit..")
          .because("the kernel must stay reusable by any feature");

  @ArchTest
  static final ArchRule noFieldInjection =
      noFields()
          .should()
          .beAnnotatedWith("org.springframework.beans.factory.annotation.Autowired")
          .because("constructor injection keeps dependencies explicit and testable");

  @ArchTest
  static final ArchRule noStandardStreams =
      GeneralCodingRules.NO_CLASSES_SHOULD_ACCESS_STANDARD_STREAMS;

  @ArchTest
  static final ArchRule noJavaUtilLogging =
      GeneralCodingRules.NO_CLASSES_SHOULD_USE_JAVA_UTIL_LOGGING;

  @ArchTest
  static final ArchRule noGenericExceptions =
      GeneralCodingRules.NO_CLASSES_SHOULD_THROW_GENERIC_EXCEPTIONS;

  @ArchTest
  static final ArchRule controllersLiveInApi =
      classes()
          .that()
          .areAnnotatedWith("org.springframework.web.bind.annotation.RestController")
          .should()
          .resideInAPackage(API)
          .andShould()
          .haveSimpleNameEndingWith("Controller");

  @ArchTest
  static final ArchRule entitiesLiveInInfrastructure =
      classes()
          .that()
          .areAnnotatedWith("jakarta.persistence.Entity")
          .should()
          .resideInAPackage(INFRA)
          .andShould()
          .notBePublic();
}
