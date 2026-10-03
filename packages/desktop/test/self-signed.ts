import { createSign, generateKeyPairSync } from 'node:crypto'

/**
 * An X.509 leaf certificate for `localhost` / `127.0.0.1`, minted at run time.
 *
 * Node can generate a key pair and sign bytes but cannot mint a certificate,
 * and the two obvious ways round that are both wrong here. Committing a PEM
 * puts a private key in the repository, which is a thing this project does not
 * do whatever the key is for. Shelling out to `openssl` makes the test pass or
 * fail on whether a machine happens to have one on PATH.
 *
 * So the DER is written out here. It is about eighty lines of ASN.1 and it runs
 * once per test file, against loopback.
 */
export function selfSignedCertificate(): { key: string; cert: string } {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const spki = publicKey.export({ type: 'spki', format: 'der' })

  const tbs = der(0x30, [
    // [0] EXPLICIT version, v3
    der(0xa0, [der(0x02, Buffer.from([2]))]),
    // serialNumber. DER integers are minimal: a leading zero is required only
    // when the top bit of the first byte is set, and adding one anyway is an
    // encoding error rather than a harmless belt (INVALID_INTEGER). 0x4c has
    // the top bit clear, so these four bytes are the whole of it.
    der(0x02, Buffer.from([0x4c, 0x9a, 0x11, 0x07])),
    ALGORITHM,
    name('Helm test fixture'),
    der(0x30, [utcTime(Date.now() - 60 * 60 * 1000), utcTime(Date.now() + 365 * 24 * 60 * 60 * 1000)]),
    name('localhost'),
    spki,
    // [3] EXPLICIT extensions
    der(0xa3, [
      der(0x30, [
        // basicConstraints, critical, CA false (an empty SEQUENCE)
        der(0x30, [oid('2.5.29.19'), der(0x01, Buffer.from([0xff])), der(0x04, der(0x30, []))]),
        // subjectAltName: DNS:localhost, IP:127.0.0.1
        der(0x30, [
          oid('2.5.29.17'),
          der(0x04, der(0x30, [der(0x82, Buffer.from('localhost', 'ascii')), der(0x87, Buffer.from([127, 0, 0, 1]))]))
        ])
      ])
    ])
  ])

  const signature = createSign('sha256').update(tbs).sign(privateKey)
  const certificate = der(0x30, [
    tbs,
    ALGORITHM,
    // BIT STRING with zero unused bits
    der(0x03, Buffer.concat([Buffer.from([0x00]), signature]))
  ])

  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    cert: pem('CERTIFICATE', certificate)
  }
}

/** A DER TLV. `content` is either raw bytes or a list of already-encoded values. */
function der(tag: number, content: Buffer | Buffer[]): Buffer {
  const body = Array.isArray(content) ? Buffer.concat(content) : content
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body])
}

function derLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length])
  const bytes: number[] = []
  let left = length
  while (left > 0) {
    bytes.unshift(left & 0xff)
    left >>= 8
  }
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

function oid(dotted: string): Buffer {
  const parts = dotted.split('.').map(Number)
  const bytes: number[] = [40 * (parts[0] ?? 0) + (parts[1] ?? 0)]
  for (const part of parts.slice(2)) {
    const chunk: number[] = []
    let left = part
    do {
      chunk.unshift(left & 0x7f)
      left >>= 7
    } while (left > 0)
    for (let i = 0; i < chunk.length - 1; i++) chunk[i] = (chunk[i] ?? 0) | 0x80
    bytes.push(...chunk)
  }
  return der(0x06, Buffer.from(bytes))
}

/** sha256WithRSAEncryption, with the NULL parameters the RFC asks for. */
const ALGORITHM = der(0x30, [oid('1.2.840.113549.1.1.11'), Buffer.from([0x05, 0x00])])

/** An RDNSequence carrying one commonName. */
function name(commonName: string): Buffer {
  return der(0x30, [der(0x31, [der(0x30, [oid('2.5.4.3'), der(0x0c, Buffer.from(commonName, 'utf8'))])])])
}

function utcTime(at: number): Buffer {
  const when = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  const text =
    pad(when.getUTCFullYear() % 100) +
    pad(when.getUTCMonth() + 1) +
    pad(when.getUTCDate()) +
    pad(when.getUTCHours()) +
    pad(when.getUTCMinutes()) +
    pad(when.getUTCSeconds()) +
    'Z'
  return der(0x17, Buffer.from(text, 'ascii'))
}

function pem(label: string, body: Buffer): string {
  const base64 = body.toString('base64').replace(/(.{64})/g, '$1\n')
  return `-----BEGIN ${label}-----\n${base64}\n-----END ${label}-----\n`
}
