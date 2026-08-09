import { sql } from 'drizzle-orm'
import type { ClaudeInventory, GitState, Project, ProjectKind } from '../types'
import { EMPTY_INVENTORY } from '../types'
import type { Store } from './db'
import { projects } from './schema'

/**
 * The discovery cache. The launcher reads this first so it can paint before a
 * scan finishes; a scan then overwrites the rows it saw and leaves the rest
 * alone, which is what lets a project that has gone missing be shown as stale
 * rather than disappearing.
 */

export function cacheProjects(store: Store, found: Project[]): void {
  const seenAt = new Date().toISOString()
  const write = store.raw.transaction(() => {
    for (const project of found) {
      store.db
        .insert(projects)
        .values({
          path: project.path,
          name: project.name,
          kind: project.kind,
          harnessPath: project.harnessPath,
          hasClaudeDir: project.hasClaudeDir,
          inventory: project.inventory,
          git: project.git,
          lastSeenAt: seenAt
        })
        .onConflictDoUpdate({
          target: projects.path,
          set: {
            name: project.name,
            kind: project.kind,
            harnessPath: project.harnessPath,
            hasClaudeDir: project.hasClaudeDir,
            inventory: project.inventory,
            git: project.git,
            lastSeenAt: seenAt
          }
        })
        .run()
    }
  })
  write()
}

export interface CachedProject extends Project {
  lastSeenAt: string
}

export function readCachedProjects(store: Store): CachedProject[] {
  return store.db
    .select()
    .from(projects)
    .orderBy(sql`${projects.path} COLLATE NOCASE`)
    .all()
    .map((row) => ({
      path: row.path,
      name: row.name,
      kind: row.kind as ProjectKind,
      harnessPath: row.harnessPath,
      hasClaudeDir: row.hasClaudeDir,
      inventory: (row.inventory as ClaudeInventory | null) ?? EMPTY_INVENTORY,
      git: (row.git as GitState | null) ?? null,
      lastSeenAt: row.lastSeenAt
    }))
}
