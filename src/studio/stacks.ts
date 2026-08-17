/**
 * Tech stack registry — 15+ stacks with scaffold commands, detection, and metadata.
 */

import type { Tier } from './state.js';

export interface StackDefinition {
  id: string;
  name: string;
  /** CLI command to bootstrap the project. Use {{projectDir}} as the target path placeholder. */
  scaffoldCommand: string;
  /** npm packages to install after scaffold (if not already included) */
  dependencies: string[];
  devDependencies: string[];
  buildCommand: string;
  testCommand: string;
  devCommand: string;
  typeCheckCommand: string;
  /** Patterns in requirements text that suggest this stack */
  detectionPatterns: RegExp[];
  /** Detection priority weight (higher = preferred when tied) */
  weight: number;
  suitableFor: Tier[];
  /** Descriptive tags for filtering */
  tags: string[];
  /** Human-readable short description */
  description: string;
}

// ── Stack Registry ────────────────────────────────────────────────────────────

export const STACK_REGISTRY: StackDefinition[] = [
  {
    id: 'nextjs-postgresql',
    name: 'Next.js 15 + PostgreSQL',
    description: 'Next.js App Router + Prisma ORM + PostgreSQL + Tailwind + shadcn/ui',
    scaffoldCommand: 'npx create-next-app@latest {{projectDir}} --typescript --tailwind --eslint --app --src-dir --import-alias "@/*" --yes',
    dependencies: ['@prisma/client', 'prisma', 'bcryptjs', 'jsonwebtoken', 'zod', 'lucide-react'],
    devDependencies: ['@types/bcryptjs', '@types/jsonwebtoken', 'vitest', '@vitejs/plugin-react', '@testing-library/react'],
    buildCommand: 'npm run build',
    testCommand: 'npm test',
    devCommand: 'npm run dev',
    typeCheckCommand: 'npx tsc --noEmit',
    detectionPatterns: [/next\.?js/i, /vercel/i, /app.?router/i, /server.?component/i],
    weight: 90,
    suitableFor: ['medium', 'enterprise'],
    tags: ['react', 'fullstack', 'ssr', 'postgres', 'prisma'],
  },
  {
    id: 'nextjs-sqlite',
    name: 'Next.js 15 + SQLite',
    description: 'Next.js App Router + Prisma ORM + SQLite + Tailwind (for small projects)',
    scaffoldCommand: 'npx create-next-app@latest {{projectDir}} --typescript --tailwind --eslint --app --src-dir --import-alias "@/*" --yes',
    dependencies: ['@prisma/client', 'prisma', 'bcryptjs', 'jsonwebtoken', 'zod', 'lucide-react'],
    devDependencies: ['@types/bcryptjs', '@types/jsonwebtoken', 'vitest', '@vitejs/plugin-react'],
    buildCommand: 'npm run build',
    testCommand: 'npm test',
    devCommand: 'npm run dev',
    typeCheckCommand: 'npx tsc --noEmit',
    detectionPatterns: [/next\.?js.*simple/i, /simple.*next\.?js/i],
    weight: 70,
    suitableFor: ['small'],
    tags: ['react', 'fullstack', 'ssr', 'sqlite', 'prisma'],
  },
  {
    id: 'vite-react-express',
    name: 'Vite + React + Express + PostgreSQL',
    description: 'React SPA (Vite) + Express.js API + PostgreSQL + Prisma + Tailwind',
    scaffoldCommand: 'npm create vite@latest {{projectDir}} -- --template react-ts',
    dependencies: ['axios', 'react-router-dom', 'zod', 'lucide-react', '@tanstack/react-query'],
    devDependencies: ['vitest', '@testing-library/react', '@testing-library/user-event', 'tailwindcss', 'autoprefixer', 'postcss'],
    buildCommand: 'npm run build',
    testCommand: 'npm test',
    devCommand: 'npm run dev',
    typeCheckCommand: 'npx tsc --noEmit',
    detectionPatterns: [/react.*express/i, /express.*react/i, /SPA/i, /single.?page/i],
    weight: 80,
    suitableFor: ['medium'],
    tags: ['react', 'spa', 'express', 'rest-api', 'postgres'],
  },
  {
    id: 'vite-react-node-sqlite',
    name: 'Vite + React + Express + SQLite',
    description: 'React SPA + Express.js API + SQLite — simple full-stack setup',
    scaffoldCommand: 'npm create vite@latest {{projectDir}} -- --template react-ts',
    dependencies: ['axios', 'react-router-dom', 'zod', 'lucide-react'],
    devDependencies: ['vitest', '@testing-library/react', 'tailwindcss', 'autoprefixer', 'postcss'],
    buildCommand: 'npm run build',
    testCommand: 'npm test',
    devCommand: 'npm run dev',
    typeCheckCommand: 'npx tsc --noEmit',
    detectionPatterns: [/simple.*react/i, /react.*simple/i, /todo/i, /expense/i],
    weight: 65,
    suitableFor: ['small'],
    tags: ['react', 'spa', 'express', 'sqlite'],
  },
  {
    id: 'nestjs-postgresql',
    name: 'NestJS + PostgreSQL',
    description: 'NestJS API + TypeORM + PostgreSQL — enterprise-grade backend',
    scaffoldCommand: 'npx @nestjs/cli new {{projectDir}} --package-manager npm --skip-git',
    dependencies: ['@nestjs/typeorm', 'typeorm', 'pg', 'bcryptjs', 'jsonwebtoken', '@nestjs/jwt', '@nestjs/passport', 'passport-jwt', 'class-validator', 'class-transformer'],
    devDependencies: ['@types/bcryptjs', '@types/jsonwebtoken', '@nestjs/testing', 'supertest', '@types/supertest'],
    buildCommand: 'npm run build',
    testCommand: 'npm test',
    devCommand: 'npm run start:dev',
    typeCheckCommand: 'npx tsc --noEmit',
    detectionPatterns: [/nest\.?js/i, /nestjs/i, /enterprise.*api/i, /api.*enterprise/i],
    weight: 85,
    suitableFor: ['enterprise'],
    tags: ['nestjs', 'api', 'postgres', 'typeorm', 'enterprise'],
  },
  {
    id: 'express-ts',
    name: 'Express.js + TypeScript',
    description: 'Pure Express.js REST API with TypeScript — no frontend',
    scaffoldCommand: 'mkdir -p {{projectDir}} && cd {{projectDir}} && npm init -y',
    dependencies: ['express', 'cors', 'helmet', 'dotenv', 'bcryptjs', 'jsonwebtoken', 'zod'],
    devDependencies: ['@types/express', '@types/cors', '@types/bcryptjs', '@types/jsonwebtoken', 'typescript', 'ts-node', 'nodemon', 'vitest', 'supertest', '@types/supertest'],
    buildCommand: 'npx tsc',
    testCommand: 'npx vitest run',
    devCommand: 'npx nodemon --exec ts-node src/index.ts',
    typeCheckCommand: 'npx tsc --noEmit',
    detectionPatterns: [/express.*api/i, /rest.*api.*only/i, /backend.*only/i, /api.*only/i],
    weight: 60,
    suitableFor: ['small', 'medium'],
    tags: ['express', 'rest-api', 'backend-only', 'typescript'],
  },
  {
    id: 'vite-vue-express',
    name: 'Vue 3 + Vite + Express',
    description: 'Vue 3 SPA (Vite + Composition API) + Express.js API + PostgreSQL',
    scaffoldCommand: 'npm create vite@latest {{projectDir}} -- --template vue-ts',
    dependencies: ['axios', 'vue-router', 'pinia', 'zod'],
    devDependencies: ['vitest', '@vue/test-utils', 'tailwindcss', 'autoprefixer', 'postcss'],
    buildCommand: 'npm run build',
    testCommand: 'npm test',
    devCommand: 'npm run dev',
    typeCheckCommand: 'npx tsc --noEmit',
    detectionPatterns: [/\bvue\b/i, /vuejs/i, /pinia/i],
    weight: 75,
    suitableFor: ['small', 'medium'],
    tags: ['vue', 'spa', 'express', 'pinia'],
  },
  {
    id: 'vite-angular-nestjs',
    name: 'Angular + NestJS + PostgreSQL',
    description: 'Angular SPA + NestJS API + PostgreSQL — enterprise full-stack',
    scaffoldCommand: 'npx @angular/cli new {{projectDir}} --routing --style=scss --skip-git --strict',
    dependencies: ['@angular/material', '@angular/cdk', 'rxjs'],
    devDependencies: ['jasmine', 'karma'],
    buildCommand: 'npm run build',
    testCommand: 'npm test -- --no-watch --no-progress',
    devCommand: 'npm start',
    typeCheckCommand: 'npx tsc --noEmit',
    detectionPatterns: [/angular/i, /rxjs/i, /angular.*enterprise/i],
    weight: 72,
    suitableFor: ['enterprise'],
    tags: ['angular', 'nestjs', 'enterprise', 'postgres'],
  },
  {
    id: 't3-stack',
    name: 'T3 Stack (tRPC + Next.js + Prisma)',
    description: 'create-t3-app: Next.js + tRPC + Prisma + NextAuth + Tailwind — type-safe fullstack',
    scaffoldCommand: 'npx create-t3-app@latest {{projectDir}} --CI --trpc --prisma --nextAuth --tailwind --appRouter',
    dependencies: [],
    devDependencies: ['vitest', '@testing-library/react'],
    buildCommand: 'npm run build',
    testCommand: 'npm test',
    devCommand: 'npm run dev',
    typeCheckCommand: 'npx tsc --noEmit',
    detectionPatterns: [/\bt3\b|tRPC|trpc/i, /type.?safe.*full.?stack/i],
    weight: 88,
    suitableFor: ['medium'],
    tags: ['nextjs', 'trpc', 'prisma', 'nextauth', 'tailwind', 'type-safe'],
  },
  {
    id: 'mern',
    name: 'MERN Stack',
    description: 'MongoDB + Express + React (Vite) + Node.js',
    scaffoldCommand: 'npm create vite@latest {{projectDir}}/client -- --template react-ts',
    dependencies: ['axios', 'react-router-dom', 'mongoose', 'cors', 'helmet', 'dotenv', 'bcryptjs', 'jsonwebtoken'],
    devDependencies: ['@types/cors', '@types/bcryptjs', '@types/jsonwebtoken', '@types/mongoose', 'vitest'],
    buildCommand: 'npm run build',
    testCommand: 'npm test',
    devCommand: 'npm run dev',
    typeCheckCommand: 'npx tsc --noEmit',
    detectionPatterns: [/MERN/i, /mongodb/i, /mongoose/i, /mongo.*react/i],
    weight: 70,
    suitableFor: ['medium'],
    tags: ['react', 'express', 'mongodb', 'mongoose'],
  },
  {
    id: 'expo-react-native',
    name: 'Expo + React Native',
    description: 'Cross-platform mobile app with Expo + React Native + Supabase',
    scaffoldCommand: 'npx create-expo-app@latest {{projectDir}} --template blank-typescript',
    dependencies: ['@supabase/supabase-js', 'expo-router', 'react-native-safe-area-context', 'react-native-screens'],
    devDependencies: ['jest', '@testing-library/react-native'],
    buildCommand: 'npx expo export',
    testCommand: 'npm test',
    devCommand: 'npx expo start',
    typeCheckCommand: 'npx tsc --noEmit',
    detectionPatterns: [/mobile.*app/i, /react.?native/i, /expo/i, /iOS.*android|android.*iOS/i],
    weight: 80,
    suitableFor: ['small', 'medium'],
    tags: ['react-native', 'expo', 'mobile', 'cross-platform'],
  },
  {
    id: 'electron-react',
    name: 'Electron + React',
    description: 'Desktop app with Electron + React (Vite) + SQLite',
    scaffoldCommand: 'npm create vite@latest {{projectDir}} -- --template react-ts',
    dependencies: ['electron', 'better-sqlite3', 'electron-is-dev'],
    devDependencies: ['electron-builder', '@electron-forge/cli', 'vitest', '@testing-library/react'],
    buildCommand: 'npm run build',
    testCommand: 'npm test',
    devCommand: 'npm run dev',
    typeCheckCommand: 'npx tsc --noEmit',
    detectionPatterns: [/desktop.*app/i, /electron/i, /cross.?platform.*desktop/i],
    weight: 75,
    suitableFor: ['small', 'medium'],
    tags: ['electron', 'react', 'desktop', 'sqlite'],
  },
  {
    id: 'fastapi-react',
    name: 'FastAPI + React (Vite)',
    description: 'Python FastAPI backend + Vite+React frontend + PostgreSQL',
    scaffoldCommand: 'npm create vite@latest {{projectDir}}/frontend -- --template react-ts',
    dependencies: ['axios', 'react-router-dom', '@tanstack/react-query', 'lucide-react'],
    devDependencies: ['vitest', '@testing-library/react', 'tailwindcss'],
    buildCommand: 'npm run build',
    testCommand: 'npm test',
    devCommand: 'npm run dev',
    typeCheckCommand: 'npx tsc --noEmit',
    detectionPatterns: [/fastapi/i, /python.*backend/i, /\bpython\b.*\breact\b/i],
    weight: 72,
    suitableFor: ['medium'],
    tags: ['python', 'fastapi', 'react', 'postgres'],
  },
  {
    id: 'flask-react',
    name: 'Flask + React (Vite)',
    description: 'Python Flask API + Vite+React frontend + SQLite',
    scaffoldCommand: 'npm create vite@latest {{projectDir}}/frontend -- --template react-ts',
    dependencies: ['axios', 'react-router-dom'],
    devDependencies: ['vitest', '@testing-library/react', 'tailwindcss'],
    buildCommand: 'npm run build',
    testCommand: 'npm test',
    devCommand: 'npm run dev',
    typeCheckCommand: 'npx tsc --noEmit',
    detectionPatterns: [/flask/i, /\bflask\b.*\breact\b/i],
    weight: 62,
    suitableFor: ['small'],
    tags: ['python', 'flask', 'react', 'sqlite'],
  },
  {
    id: 'spring-react',
    name: 'Spring Boot + React (Vite)',
    description: 'Java Spring Boot API + Vite+React frontend + PostgreSQL — enterprise Java stack',
    scaffoldCommand: 'npm create vite@latest {{projectDir}}/frontend -- --template react-ts',
    dependencies: ['axios', 'react-router-dom', '@tanstack/react-query'],
    devDependencies: ['vitest', '@testing-library/react', 'tailwindcss'],
    buildCommand: 'npm run build',
    testCommand: 'npm test',
    devCommand: 'npm run dev',
    typeCheckCommand: 'npx tsc --noEmit',
    detectionPatterns: [/spring.*boot/i, /\bjava\b.*backend/i],
    weight: 70,
    suitableFor: ['enterprise'],
    tags: ['java', 'spring-boot', 'react', 'postgres', 'enterprise'],
  },
];

// ── Detection ─────────────────────────────────────────────────────────────────

/** Detect the best stack for given requirements and tier. */
export function detectStack(requirements: string, tier: Tier): StackDefinition {
  const suitable = STACK_REGISTRY.filter(s => s.suitableFor.includes(tier));

  let bestStack = suitable[0];
  let bestScore = -1;

  for (const stack of suitable) {
    let score = stack.weight;
    for (const pattern of stack.detectionPatterns) {
      if (pattern.test(requirements)) score += 20;
    }
    if (score > bestScore) {
      bestScore = score;
      bestStack = stack;
    }
  }

  return bestStack;
}

export function getStack(id: string): StackDefinition | undefined {
  return STACK_REGISTRY.find(s => s.id === id);
}

export function listStacks(): StackDefinition[] {
  return STACK_REGISTRY;
}

/** Replace {{projectDir}} placeholder in scaffold command. */
export function interpolateCommand(cmd: string, projectDir: string): string {
  return cmd.replace(/\{\{projectDir\}\}/g, projectDir);
}
