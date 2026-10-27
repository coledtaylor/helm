import { describe, expect, it } from 'vitest'
import { signatureProblem } from '../../scripts/verify-mac-artifact.mjs'

/**
 * How the macOS artefact check reads `codesign -d --verbose=2`, which reports
 * on stderr. The reports are codesign's own shape: an ad-hoc signature, one
 * made with a Developer ID certificate, and an app with none.
 */

const ADHOC = `Executable=/Volumes/Helm 2.3.3-arm64/Helm.app/Contents/MacOS/Helm
Identifier=dev.coletaylor.helm
Format=app bundle with Mach-O thin (arm64)
CodeDirectory v=20400 size=1234 flags=0x2(adhoc) hashes=28+7 location=embedded
Signature=adhoc
Info.plist entries=29
TeamIdentifier=not set
Sealed Resources version=2 rules=13 files=104
Internal requirements count=0 size=12
`

const DEVELOPER_ID = `Executable=/Applications/Helm.app/Contents/MacOS/Helm
Identifier=dev.coletaylor.helm
Format=app bundle with Mach-O thin (arm64)
CodeDirectory v=20500 size=1234 flags=0x10000(runtime) hashes=28+7 location=embedded
Signature size=9041
Authority=Developer ID Application: Someone (ABCDE12345)
Authority=Developer ID Certification Authority
Authority=Apple Root CA
Timestamp=27 Oct 2026 at 08:12:59
TeamIdentifier=ABCDE12345
`

describe('the macOS artefact check, reading codesign', () => {
  it('takes an ad-hoc signature, said either way codesign says it', () => {
    expect(signatureProblem(ADHOC)).toBeNull()
    expect(signatureProblem(ADHOC.replace('Signature=adhoc\n', ''))).toBeNull()
    expect(signatureProblem(ADHOC.replace('flags=0x2(adhoc)', 'flags=0x0(none)'))).toBeNull()
  })

  it('refuses a signature made with a certificate, naming it and showing the whole report', () => {
    const problem = signatureProblem(DEVELOPER_ID)
    expect(problem).toMatch(/^the signature is made with a certificate \(Authority=Developer ID Application: Someone \(ABCDE12345\)\), not ad-hoc:/)
    expect(problem).toContain('TeamIdentifier=ABCDE12345')
  })

  it('refuses an unsigned app, and a report that says neither, with what codesign printed', () => {
    expect(signatureProblem('/Volumes/Helm/Helm.app: code object is not signed at all\n')).toBe(
      'the app is not signed:\n/Volumes/Helm/Helm.app: code object is not signed at all'
    )
    const neither = ADHOC.replace('Signature=adhoc\n', 'Signature size=4442\n').replace('flags=0x2(adhoc)', 'flags=0x0(none)')
    expect(signatureProblem(neither)).toBe(`the signature is not ad-hoc:\n${neither.trim()}`)
  })

  it('says codesign printed nothing rather than ending a sentence at a colon', () => {
    expect(signatureProblem('')).toBe('codesign printed nothing about the signature')
    expect(signatureProblem(' \n')).toBe('codesign printed nothing about the signature')
  })
})
