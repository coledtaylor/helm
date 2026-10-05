/** A file bundled into one classic script, as text. See `inline-script.ts`. */
declare module '*?script' {
  const source: string
  export default source
}

/** A file's text, as Vite's `?raw` gives it. */
declare module '*?raw' {
  const text: string
  export default text
}
