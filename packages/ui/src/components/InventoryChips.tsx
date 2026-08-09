import type { JSX } from 'react'
import type { ClaudeInventory } from '@helm/core'
import { Chip } from './Chip'
import { AgentIcon, CommandIcon, SparkIcon } from './icons'
import { cn } from '../lib/cn'

export interface InventoryChipsProps {
  inventory: ClaudeInventory
  className?: string | undefined
}

/**
 * What a project would contribute to a session. These counts are the whole
 * argument of SPEC 1 - the ~43 skills and ~96 agents a harness-root launch
 * silently drops - so a project with none shows nothing rather than three zeros.
 */
export function InventoryChips({
  inventory,
  className
}: InventoryChipsProps): JSX.Element | null {
  const { skills, agents, commands } = inventory
  if (skills === 0 && agents === 0 && commands === 0) return null

  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      {skills > 0 && (
        <Chip icon={<SparkIcon />} title={`${skills} skill${skills === 1 ? '' : 's'}`}>
          {skills}
        </Chip>
      )}
      {agents > 0 && (
        <Chip icon={<AgentIcon />} title={`${agents} agent${agents === 1 ? '' : 's'}`}>
          {agents}
        </Chip>
      )}
      {commands > 0 && (
        <Chip icon={<CommandIcon />} title={`${commands} command${commands === 1 ? '' : 's'}`}>
          {commands}
        </Chip>
      )}
    </span>
  )
}
