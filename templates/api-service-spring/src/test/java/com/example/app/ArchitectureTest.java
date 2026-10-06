package com.example.app;

import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.classes;
import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.noClasses;
import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.noFields;
import static com.tngtech.archunit.library.dependencies.SlicesRuleDefinition.slices;

import com.tngtech.archunit.core.domain.JavaClass;
import com.tngtech.archunit.core.importer.ImportOption;
import com.tngtech.archunit.junit.AnalyzeClasses;
import com.tngtech.archunit.junit.ArchTest;
import com.tngtech.archunit.lang.ArchRule;
import com.tngtech.archunit.library.GeneralCodingRules;

/**
 * The structure rules from docs/ARCHITECTURE.md, as tests. Inside a feature the layers point one
 * way (api -> app -> domain <- infra); features do not reach into each other; the shared kernel
 * knows no feature. A new feature that copies the items package is checked by the same rules with
 * no edit here (the patterns use a wildcard for the feature name).
 */
@AnalyzeClasses(packages = "com.example.app", importOptions = ImportOption.DoNotIncludeTests.class)
class ArchitectureTest {

  private static final String DOMAIN = "com.example.app.*.domain..";
  private static final String APP = "com.example.app.*.app..";
  private static final String API = "com.example.app.*.api..";
  private static final String INFRA = "com.example.app.*.infra..";

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
              "com.example.app.shared.error..",
              "com.example.app.shared.page..",
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
  static final ArchRule featuresAreIndependent =
      slices()
          .matching("com.example.app.(*)..")
          .should()
          .notDependOnEachOther()
          .ignoreDependency(
              com.tngtech.archunit.base.DescribedPredicate.describe(
                  "any feature",
                  (JavaClass c) -> !c.getPackageName().startsWith("com.example.app.shared")),
              com.tngtech.archunit.base.DescribedPredicate.describe(
                  "the shared kernel",
                  (JavaClass c) -> c.getPackageName().startsWith("com.example.app.shared")))
          .ignoreDependency(
              com.tngtech.archunit.base.DescribedPredicate.describe(
                  "the composition root",
                  (JavaClass c) -> c.getName().equals("com.example.app.Application")),
              com.tngtech.archunit.base.DescribedPredicate.alwaysTrue())
          .because("features meet only in the container and the shared kernel");

  @ArchTest
  static final ArchRule sharedKernelKnowsNoFeature =
      noClasses()
          .that()
          .resideInAPackage("com.example.app.shared..")
          .should()
          .dependOnClassesThat()
          .resideInAnyPackage("com.example.app.items..", "com.example.app.identity..")
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
