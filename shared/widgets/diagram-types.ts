/**
 * Every diagram this build can actually draw, with a working example of each.
 *
 * ## Why this list is measured rather than copied
 *
 * The prompt used to name six mermaid diagram types: flowchart, sequence, ER,
 * state, class and gantt. The bundled mermaid draws twenty-six. The other
 * twenty existed, worked, and were never mentioned, so they may as well not
 * have — a capability the model is not told about is one it cannot use, and it
 * routes around the gap instead. That is exactly how a request for an
 * architecture diagram turned into a hand-built HTML page.
 *
 * Copying the list out of mermaid's documentation would have been the obvious
 * fix and the wrong one. Docs describe the project; what matters is the
 * version in `package.json`, where a type can be missing, renamed, or still
 * behind a `-beta` suffix that changes between minors. `zenuml` is the case in
 * point: documented, and not renderable here without a separate package.
 *
 * So every entry carries a `sample`, and `scripts/diagram-matrix.mjs` renders
 * all of them through the real mermaid in a real browser. The list cannot claim
 * a diagram the build cannot draw without the check going red.
 *
 * ## Samples are documentation, not fixtures
 *
 * Each one is the shortest thing that renders *and* shows the syntax that is
 * easy to get wrong — the arrow forms, where quoting is required, how nesting
 * is expressed. They are what `WidgetSpec` hands back when asked, so a wrong
 * sample is a wrong answer, not just a failing test.
 *
 * @module shared/widgets/diagram-types
 */

export interface DiagramType {
  /** Stable id. Also the matrix check's name for it. */
  id: string;
  /** The opening keyword mermaid dispatches on. */
  syntax: string;
  /** What it is, in the words someone would ask for it. */
  label: string;
  /** When to reach for this one rather than a neighbour. */
  use: string;
  /** A minimal diagram that renders. Doubles as the worked example. */
  sample: string;
  /**
   * Further shapes that must keep rendering, but are not shown to the model.
   *
   * For rules found the hard way — a label form that fails unquoted, a syntax
   * a mermaid upgrade might tighten. They belong in the check rather than the
   * index: the model needs one good example, not a list of everything that
   * once went wrong.
   */
  alsoRenders?: readonly string[];
}

export const DIAGRAM_TYPES: readonly DiagramType[] = [
  // ── Behaviour and flow ────────────────────────────────────────────
  {
    id: 'flowchart',
    syntax: 'flowchart',
    label: 'Flowchart / activity / workflow',
    use: 'any process with decisions and branches — business workflow, activity '
      + 'diagram, request path, deployment steps. The default when unsure.',
    sample: `flowchart TD
  A[Start] --> B{Approved?}
  B -->|yes| C[Deploy]
  B -->|no| D[Revise]
  D --> B
  C --> E([End])`,
  },
  {
    id: 'sequence',
    syntax: 'sequenceDiagram',
    label: 'Sequence',
    use: 'ordered interaction between participants over time — API calls, '
      + 'handshakes, protocol exchanges. Use when *order* is the message.',
    sample: `sequenceDiagram
  autonumber
  participant U as User
  participant API
  participant DB
  U->>API: POST /order
  API->>DB: insert
  DB-->>API: ok
  API-->>U: 201 Created`,
  },
  {
    id: 'state',
    syntax: 'stateDiagram-v2',
    label: 'State machine',
    use: 'the states a thing can be in and what moves it between them — order '
      + 'lifecycle, connection status, approval workflow.',
    sample: `stateDiagram-v2
  [*] --> Draft
  Draft --> Review : submit
  Review --> Approved : accept
  Review --> Draft : reject
  Approved --> [*]`,
  },

  // ── Structure ─────────────────────────────────────────────────────
  {
    id: 'class',
    syntax: 'classDiagram',
    label: 'Class / domain model (LLD)',
    use: 'types, their fields and how they relate — low-level design, domain '
      + 'models, an existing codebase\'s shape.',
    sample: `classDiagram
  class Order {
    +String id
    +Money total()
  }
  class Customer
  Customer "1" --> "*" Order : places`,
  },
  {
    id: 'er',
    syntax: 'erDiagram',
    label: 'Entity relationship',
    use: 'database schema and cardinality. Prefer this to a class diagram when '
      + 'the subject is tables rather than objects.',
    sample: `erDiagram
  CUSTOMER ||--o{ ORDER : places
  ORDER ||--|{ LINE_ITEM : contains
  CUSTOMER {
    string id PK
    string email
  }`,
  },
  {
    id: 'block',
    syntax: 'block-beta',
    label: 'Block / layered architecture',
    use: 'boxes in a deliberate grid — layer cakes, tiers, anything where the '
      + '*position* of a box carries meaning that a graph layout would lose.',
    sample: `block-beta
  columns 3
  web["Web"] api["API"] db[("Database")]
  web --> api
  api --> db`,
  },

  // ── Architecture ──────────────────────────────────────────────────
  {
    id: 'c4context',
    syntax: 'C4Context',
    label: 'C4 level 1 — system context (HLD)',
    use: 'the system as one box, its users, and the systems it talks to. The '
      + 'right first diagram for high-level design.',
    sample: `C4Context
  title System context
  Person(user, "Customer", "Buys things")
  System(shop, "Shop", "Sells things")
  System_Ext(pay, "Payment provider")
  Rel(user, shop, "Uses")
  Rel(shop, pay, "Charges via", "HTTPS")`,
  },
  {
    id: 'c4container',
    syntax: 'C4Container',
    label: 'C4 level 2 — containers (HLD)',
    use: 'the deployable pieces inside the system — apps, services, databases — '
      + 'and the protocols between them.',
    sample: `C4Container
  title Containers
  Person(user, "Customer")
  Container(web, "Web app", "React")
  Container(api, "API", "Node")
  ContainerDb(db, "Database", "Postgres")
  Rel(user, web, "Uses", "HTTPS")
  Rel(web, api, "JSON/HTTPS")
  Rel(api, db, "Reads/writes", "SQL")`,
  },
  {
    id: 'c4component',
    syntax: 'C4Component',
    label: 'C4 level 3 — components (LLD)',
    use: 'inside one container: its modules and their dependencies.',
    sample: `C4Component
  title API components
  Container_Boundary(api, "API") {
    Component(ctl, "Controller", "Express")
    Component(svc, "Order service", "TypeScript")
    Rel(ctl, svc, "calls")
  }`,
  },
  {
    id: 'c4deployment',
    syntax: 'C4Deployment',
    label: 'C4 deployment (infrastructure)',
    use: 'what runs where — regions, clusters, nodes, and the containers on '
      + 'them. The one for infrastructure planning.',
    sample: `C4Deployment
  title Production deployment
  Deployment_Node(aws, "AWS", "eu-west-1") {
    Deployment_Node(ecs, "ECS cluster", "Fargate") {
      Container(api, "API", "Node")
    }
    Deployment_Node(rds, "RDS", "Multi-AZ") {
      ContainerDb(db, "Database", "Postgres")
    }
  }
  Rel(api, db, "SQL")`,
  },
  {
    id: 'c4dynamic',
    syntax: 'C4Dynamic',
    label: 'C4 dynamic',
    use: 'a numbered walkthrough of one scenario across an architecture — the '
      + 'C4 answer to "show me how a request flows".',
    sample: `C4Dynamic
  title Order submission
  Container(web, "Web app")
  Container(api, "API")
  ContainerDb(db, "Database")
  Rel(web, api, "1. POST /order")
  Rel(api, db, "2. insert")`,
  },
  {
    id: 'architecture',
    syntax: 'architecture-beta',
    label: 'Cloud / service architecture',
    use: 'infrastructure with grouped services and iconography. Built-in icons: '
      + 'cloud, database, disk, server, internet. QUOTE every label that is not '
      + 'plain letters and spaces — a CIDR, a region, a dotted name or anything '
      + 'with a dash, dot, slash, colon, comma or bracket fails to parse unquoted, '
      + 'which is most real infrastructure labels.',
    // Deliberately realistic, and therefore deliberately quoted. The unquoted
    // form parses only for labels made of letters and spaces, so a sample using
    // "Production VPC" would teach a habit that breaks on the first CIDR. That
    // is not hypothetical: a model given the unquoted sample wrote
    // `group vpc(cloud)[VPC 10.0.0.0/16]` and the diagram failed. The variants
    // in `alsoRenders` hold that rule down.
    sample: `architecture-beta
  group vpc(cloud)["Production VPC 10.0.0.0/16"]
  service lb(internet)["Load balancer"] in vpc
  service api(server)["Order API"] in vpc
  service db(database)["RDS PostgreSQL"] in vpc
  service files(disk)["S3 bucket"] in vpc
  lb:R --> L:api
  api:R --> L:db
  api:B --> T:files`,
    alsoRenders: [
      // The exact shapes that failed unquoted, now quoted. If a mermaid upgrade
      // changes the lexer either way, this says so.
      `architecture-beta
  group r(cloud)["eu-west-1"]
  service s(server)["api.internal:8080"] in r`,
      `architecture-beta
  group r(cloud)["VPC (prod), 10.0.0.0/16"]
  service s(database)["orders-db"] in r`,
    ],
  },
  {
    id: 'packet',
    syntax: 'packet-beta',
    label: 'Packet / wire format',
    use: 'byte and bit layout of a protocol message or binary format.',
    sample: `packet-beta
  0-15: "Source port"
  16-31: "Destination port"
  32-63: "Sequence number"`,
  },

  // ── Planning and delivery ─────────────────────────────────────────
  {
    id: 'gantt',
    syntax: 'gantt',
    label: 'Gantt (schedule)',
    use: 'dated plan with durations and dependencies — SDLC phases, release '
      + 'schedule, migration plan.',
    sample: `gantt
  title Release plan
  dateFormat YYYY-MM-DD
  section Build
    Design     :a1, 2026-01-01, 14d
    Implement  :a2, after a1, 21d
  section Ship
    Harden     :after a2, 10d`,
  },
  {
    id: 'timeline',
    syntax: 'timeline',
    label: 'Timeline / roadmap',
    use: 'events in order without durations. Use instead of a gantt when the '
      + 'dates are milestones rather than work.',
    sample: `timeline
  title Roadmap
  Q1 : Discovery : Prototype
  Q2 : Private beta
  Q3 : General availability`,
  },
  {
    id: 'kanban',
    syntax: 'kanban',
    label: 'Kanban board',
    use: 'work in columns by state — sprint board, migration checklist.',
    sample: `kanban
  Todo
    [Write the spec]
  Doing
    [Build the API]
  Done
    [Set up CI]`,
  },
  {
    id: 'mindmap',
    syntax: 'mindmap',
    label: 'Mindmap',
    use: 'hierarchical breakdown with no flow — scope, feature trees, taxonomy. '
      + 'Indentation is the structure.',
    sample: `mindmap
  root((Platform))
    Frontend
      Web
      Mobile
    Backend
      API
      Workers`,
  },
  {
    id: 'quadrant',
    syntax: 'quadrantChart',
    label: 'Quadrant (prioritisation)',
    use: 'items scored on two axes — effort vs impact, risk vs value.',
    sample: `quadrantChart
  title Reach versus effort
  x-axis Low effort --> High effort
  y-axis Low reach --> High reach
  quadrant-1 Do now
  quadrant-2 Plan
  quadrant-3 Drop
  quadrant-4 Quick wins
  Auth rewrite: [0.75, 0.80]
  Dark mode: [0.30, 0.40]`,
  },
  {
    id: 'requirement',
    syntax: 'requirementDiagram',
    label: 'Requirements traceability',
    use: 'requirements and what satisfies, verifies or derives from them. For '
      + 'compliance and formal specs.',
    // The id is bare, not quoted and not hyphenated. `REQ-1` is what anyone
    // would reach for and mermaid's parser rejects it — caught by the matrix
    // check, which is the whole reason samples are rendered rather than
    // eyeballed.
    sample: `requirementDiagram
  requirement auth {
    id: 1
    text: The system shall authenticate users.
    risk: high
    verifymethod: test
  }
  element login {
    type: component
  }
  login - satisfies -> auth`,
  },
  {
    id: 'gitgraph',
    syntax: 'gitGraph',
    label: 'Git branching',
    use: 'branching and merge strategy — trunk-based, git-flow, a release train.',
    sample: `gitGraph
  commit
  branch feature
  checkout feature
  commit
  checkout main
  merge feature`,
  },
  {
    id: 'journey',
    syntax: 'journey',
    label: 'User journey',
    use: 'steps a person takes with a satisfaction score per step. For UX work, '
      + 'not for system flow.',
    sample: `journey
  title Checkout
  section Browse
    Find item: 5: Customer
    Compare: 3: Customer
  section Pay
    Enter card: 2: Customer`,
  },

  // ── Quantities ────────────────────────────────────────────────────
  {
    id: 'sankey',
    syntax: 'sankey-beta',
    label: 'Sankey (flow volume)',
    use: 'where quantity goes as it moves through stages — traffic, spend, '
      + 'conversion. Widths are the values.',
    sample: `sankey-beta
Requests,Cache hit,600
Requests,Origin,400
Origin,Database,250
Origin,Static,150`,
  },
  {
    id: 'treemap',
    syntax: 'treemap-beta',
    label: 'Treemap',
    use: 'part-of-whole where the parts nest — bundle size by module, cost by '
      + 'service, lines of code by directory.',
    sample: `treemap-beta
"Codebase"
    "src"
        "server": 1200
        "ui": 900
    "tests": 600`,
  },
  {
    id: 'xychart',
    syntax: 'xychart-beta',
    label: 'XY chart',
    use: 'a quick bar or line inside a diagram block. For real charts prefer '
      + '```chart or ```viz — this exists so a diagram can carry one.',
    sample: `xychart-beta
  title "Throughput"
  x-axis [jan, feb, mar]
  y-axis "requests/sec" 0 --> 500
  bar [120, 260, 410]`,
  },
  {
    id: 'radar',
    syntax: 'radar-beta',
    label: 'Radar (capability)',
    use: 'several measures on one shape — capability assessment, scorecard.',
    sample: `radar-beta
  title Team capability
  axis a["Testing"], b["Design"], c["Operations"]
  curve now{3, 4, 2}
  max 5
  min 0`,
  },
  {
    id: 'pie',
    syntax: 'pie',
    label: 'Pie',
    use: 'shares of a whole, at most five slices. A bar chart is usually better.',
    sample: `pie title Effort split
  "Build" : 45
  "Test" : 30
  "Docs" : 25`,
  },
];

/** The catalogue's diagram list, generated so it cannot drift from the samples. */
export function diagramIndex(): string {
  return DIAGRAM_TYPES
    .map(d => `  ${d.syntax.padEnd(20)} ${d.label} — ${d.use}`)
    .join('\n');
}

/** One diagram type by id or by the keyword it opens with. */
export function diagramType(name: string): DiagramType | undefined {
  const wanted = name.trim().toLowerCase();
  return DIAGRAM_TYPES.find(d => d.id === wanted || d.syntax.toLowerCase() === wanted);
}
