/** Types for `server.mjs`, for the TypeScript that starts it (Helm's end-to-end tests). */

export interface SampleItem {
  id: string
  title: string
  body: string
  read: boolean
  created: number
}

/** One request the server was asked, with the headers a test checks. */
export interface SeenRequest {
  method: string
  path: string
  authorization: string | null
  cookie: string | null
}

export interface SampleServer {
  url: string
  port: number
  requests: SeenRequest[]
  items: SampleItem[]
  close(): Promise<void>
}

export function startSampleServer(options: { port?: number; host?: string; token: string }): Promise<SampleServer>
