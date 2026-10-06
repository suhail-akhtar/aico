package com.example.system;

import org.junit.jupiter.api.Test;
import org.springframework.modulith.core.ApplicationModules;
import org.springframework.modulith.docs.Documenter;

/**
 * Spring Modulith's own verification: no cycles between modules, and no module reaches into
 * another's internals. It also writes the module diagram to {@code target/spring-modulith-docs}
 * (PlantUML), which docs/ARCHITECTURE.md refers to.
 */
class ModularityTest {

  private static final ApplicationModules MODULES = ApplicationModules.of(Application.class);

  @Test
  void modulesAreAcyclicAndEncapsulated() {
    MODULES.verify();
  }

  @Test
  void writesTheModuleDocumentation() {
    new Documenter(MODULES).writeModulesAsPlantUml().writeIndividualModulesAsPlantUml();
  }
}
