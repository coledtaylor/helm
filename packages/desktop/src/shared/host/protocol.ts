/**
 * The protocol's types and constants, as the floti-protocol crate generates
 * them. Everything the desktop says to the host is typed by these; nothing
 * here restates a shape by hand.
 */
export * from '../../../../../crates/floti-protocol/generated/floti-protocol.generated'

/**
 * The largest `streamData` the desktop sends at once, so one busy stream
 * cannot fill a frame the others wait behind. The crate's `MAX_DATA_CHUNK`
 * (`flow.rs`), which the generated file does not carry.
 */
export const MAX_DATA_CHUNK = 64 * 1024
