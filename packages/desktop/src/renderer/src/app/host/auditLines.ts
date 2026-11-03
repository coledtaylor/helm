import type { SettingsAuditEntry } from '@helm/ui'
import type * as P from '../../../../shared/host/protocol'

/**
 * A host's audit entry as Settings > Devices draws it: when, what happened
 * in one plain sentence, the device it is about, and whether that was from
 * another computer.
 *
 * Every word comes from the entry's fixed fields; a device's name, as it
 * gave it, is the one free text, and it is drawn as text. The device of an
 * admin action or a presence confirmation is the one who asked.
 */

const ROLE: Record<P.DeviceRole, string> = { admin: 'admin', operator: 'operator', viewer: 'viewer' }

/** Who asked, as a sentence ends with it. */
function actor(by: P.AuditActor): string {
  return by.kind === 'hostShell' ? 'floti devices on the host' : by.name
}

const OUTCOME: Record<P.AdminOutcome, string> = {
  done: 'done',
  refusedForRole: 'refused for its role',
  refusedForPresence: 'refused, presence not confirmed'
}

/** The device fields of a line about `device`. */
function about(device: P.AuditDevice): Pick<SettingsAuditEntry, 'device' | 'fingerprint'> {
  return { device: device.name ?? null, fingerprint: device.fingerprint }
}

/** The device fields of a line about whoever asked. */
function asker(by: P.AuditActor): Pick<SettingsAuditEntry, 'device' | 'fingerprint'> {
  return by.kind === 'hostShell'
    ? { device: 'floti devices on the host', fingerprint: null }
    : { device: by.name, fingerprint: by.fingerprint }
}

/** What `event` says happened, and who it was about. */
function describe(event: P.AuditEvent): Omit<SettingsAuditEntry, 'number' | 'at'> {
  switch (event.kind) {
    case 'connected':
      return { what: 'Attached', ...about(event.device), away: event.away }
    case 'disconnected':
      return { what: 'Detached', ...about(event.device), away: event.away }
    case 'refused':
      return { what: `Refused: ${event.reason}`, device: null, fingerprint: event.fingerprint ?? null, away: event.away }
    case 'pairingAsked':
      return { what: 'Asked to pair', ...about(event.device), away: event.away }
    case 'pairingApproved': {
      const role = event.device.role === undefined ? '' : ` as ${ROLE[event.device.role]}`
      return { what: `Paired${role}, approved by ${actor(event.by)}`, ...about(event.device), away: event.away }
    }
    case 'pairingEnded':
      return {
        what: event.why === 'expired' ? 'Request to pair expired' : 'Request to pair withdrawn',
        ...about(event.device),
        away: null
      }
    case 'enrolled':
      return { what: 'Enrolled as the first admin', ...about(event.device), away: false }
    case 'roleChanged':
      return {
        what: `Role changed from ${ROLE[event.from]} to ${ROLE[event.to]} by ${actor(event.by)}`,
        ...about(event.device),
        away: event.away
      }
    case 'revoked': {
      const itself = event.by.kind === 'device' && event.by.fingerprint === event.device.fingerprint
      return { what: itself ? 'Revoked itself' : `Revoked by ${actor(event.by)}`, ...about(event.device), away: event.away }
    }
    case 'presenceConfirmed':
      return { what: 'Confirmed its presence', ...about(event.device), away: event.away }
    case 'adminAction':
      return { what: `${event.doing}: ${OUTCOME[event.outcome]}`, ...asker(event.by), away: event.away }
  }
}

export function auditLine(entry: P.AuditEntry): SettingsAuditEntry {
  return { number: entry.number, at: entry.at, ...describe(entry.event) }
}
