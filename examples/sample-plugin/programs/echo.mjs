// @ts-check

/**
 * The sample's program, run by `helm.exec('echo', [...])`: says what it was
 * given. It reports only whether the secret reached it - a program that
 * printed a token would put it in the page's hands, which is what keeping it
 * in the environment exists to avoid.
 */
console.log(
  JSON.stringify({
    args: process.argv.slice(2),
    token: process.env['SAMPLE_TOKEN'] ? 'set' : 'not set'
  })
)
