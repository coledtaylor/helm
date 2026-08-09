import { defineConfig } from 'drizzle-kit'

/**
 * drizzle-kit is a build-time tool only: it turns `schema.ts` into versioned
 * SQL under `drizzle/`. Nothing at runtime reads that directory - `pnpm
 * db:generate` embeds the SQL into `src/store/migrations.generated.ts` so a
 * packaged exe carries its migrations in the bundle rather than needing files
 * beside it. See `migrate.ts`.
 */
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/store/schema.ts',
  out: './drizzle'
})
