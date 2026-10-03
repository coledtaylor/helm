import { readFileSync } from 'node:fs'
import { request, type IncomingHttpHeaders } from 'node:http'

/**
 * Just enough of an MCP client to talk to Helm's tool endpoint the way a
 * session's `claude` does: JSON-RPC over HTTP POST, with the bearer token from
 * the `--mcp-config` document Helm wrote for it.
 *
 * Every request opens a connection of its own (`agent: false`), so a test that
 * stops the endpoint is never answered by a pooled socket the server has
 * already closed.
 */

/** One server in a `--mcp-config` document. */
export interface McpServerEntry {
  type: string
  url: string
  headers: Record<string, string>
}

export interface McpConfig {
  mcpServers: Record<string, McpServerEntry>
}

export interface HttpAnswer {
  status: number
  headers: IncomingHttpHeaders
  text: string
  /** The body parsed as JSON, or null when it was empty or not JSON. */
  json: unknown
}

export interface ToolAnswer {
  /** Every text part of the answer, joined with newlines. */
  text: string
  isError: boolean
  images: { data: string; mimeType: string }[]
}

export function readMcpConfig(file: string): McpConfig {
  return JSON.parse(readFileSync(file, 'utf8')) as McpConfig
}

/** The token out of an `Authorization: Bearer <token>` header. */
export function bearerOf(entry: McpServerEntry): string {
  const match = /^Bearer (\S+)$/.exec(entry.headers['Authorization'] ?? '')
  if (!match?.[1]) throw new Error(`no bearer token in ${JSON.stringify(entry.headers)}`)
  return match[1]
}

/** One HTTP request to the endpoint, answered whatever its status. */
export function send(
  url: string,
  options: { method?: string; body?: string; headers?: Record<string, string> } = {}
): Promise<HttpAnswer> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: options.method ?? 'POST',
        agent: false,
        headers: { 'content-type': 'application/json', ...options.headers }
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('error', reject)
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json: parseJson(text) })
        })
      }
    )
    req.on('error', reject)
    req.end(options.body)
  })
}

function parseJson(text: string): unknown {
  if (text === '') return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

let nextId = 1

/** A JSON-RPC request, with the token when there is one. */
export function rpc(
  url: string,
  token: string | null,
  method: string,
  params?: unknown,
  headers: Record<string, string> = {}
): Promise<HttpAnswer> {
  return send(url, {
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, ...(params === undefined ? {} : { params }) }),
    headers: { ...(token === null ? {} : { Authorization: `Bearer ${token}` }), ...headers }
  })
}

/** The `result` of a JSON-RPC request that must succeed. */
export async function rpcResult<T>(url: string, token: string, method: string, params?: unknown): Promise<T> {
  const answer = await rpc(url, token, method, params)
  const body = answer.json as { result?: T; error?: { message: string } } | null
  if (answer.status !== 200 || body?.result === undefined) {
    throw new Error(`${method} answered ${String(answer.status)}: ${answer.text}`)
  }
  return body.result
}

/** `tools/list`, as the tool names. */
export async function toolNames(url: string, token: string): Promise<string[]> {
  const { tools } = await rpcResult<{ tools: { name: string }[] }>(url, token, 'tools/list')
  return tools.map((tool) => tool.name)
}

/** `tools/call`. A tool that refused is an answer with `isError`, not a throw. */
export async function callTool(
  url: string,
  token: string,
  name: string,
  args: Record<string, unknown> = {}
): Promise<ToolAnswer> {
  const result = await rpcResult<{
    content: { type: string; text?: string; data?: string; mimeType?: string }[]
    isError?: boolean
  }>(url, token, 'tools/call', { name, arguments: args })
  return {
    text: result.content.flatMap((part) => (part.type === 'text' && part.text !== undefined ? [part.text] : [])).join('\n'),
    isError: result.isError === true,
    images: result.content.flatMap((part) =>
      part.type === 'image' && part.data !== undefined && part.mimeType !== undefined
        ? [{ data: part.data, mimeType: part.mimeType }]
        : []
    )
  }
}
