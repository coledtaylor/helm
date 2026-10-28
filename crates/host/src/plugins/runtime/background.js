// What a plugin's background script is given beyond the web's data types:
// the `floti` global for the background surface, BroadcastChannel, and
// setTimeout, setInterval, clearTimeout and clearInterval.
//
// `floti` is shaped like the SDK's bridge (`HelmBridge`), apiVersion 2. Every
// method goes through the host's call layer: the arguments cross as protocol
// payloads, and the host answers them, never this file. The methods that need
// a client (a window, a dialog, a click) reject as unavailable with a
// sentence saying so.
//
// BroadcastChannel delivers within this isolate, to every other channel of
// the same name, and hands each message to the host as well, which is where
// the plugin's pages will hear it. A message is limited to what the protocol
// carries; anything else throws a DataCloneError, as structured clone does.
//
// Everything here is captured as this module is evaluated, before the engine
// confines the isolate: what the script can reach afterwards is the globals
// named at the bottom and nothing that made them.

import { core, primordials } from "ext:core/mod.js";
import {
  op_floti_bg_broadcast,
  op_floti_bg_call,
  op_floti_bg_cancel,
  op_floti_bg_context,
  op_floti_bg_next,
  op_floti_bg_tool_result,
} from "ext:core/ops";

const {
  ArrayBufferIsView,
  ArrayBufferPrototypeSlice,
  ArrayIsArray,
  ArrayPrototypeIncludes,
  ArrayPrototypeJoin,
  ArrayPrototypeMap,
  ArrayPrototypePush,
  Error,
  JSONParse,
  JSONStringify,
  Number,
  ObjectDefineProperty,
  ObjectFreeze,
  ObjectGetPrototypeOf,
  ObjectKeys,
  ObjectPrototype,
  ObjectPrototypeIsPrototypeOf,
  Promise,
  PromisePrototypeThen,
  PromiseReject,
  PromiseResolve,
  ReflectApply,
  SafeMap,
  SafeSet,
  String,
  StringPrototypeToUpperCase,
  Symbol,
  SymbolFor,
  TypeError,
  Uint8Array,
} = primordials;

// The web's types, as web.js put them on the global object.
const {
  AbortController,
  DOMException,
  EventTarget,
  Headers,
  MessageEvent,
  TextDecoder,
  TextEncoder,
  URL,
  URLSearchParams,
  console,
  structuredClone,
} = globalThis;
const ArrayBufferPrototype = globalThis.ArrayBuffer.prototype;

/** The longest answer a tool may give, in UTF-16 code units, as today's bridge counts it. */
const TOOL_ANSWER_MAX_CHARS = 1_000_000;

/** Statuses a response has no body for. */
const NULL_BODY = [101, 103, 204, 205, 304];

/** Methods `fetch` writes in capitals, as the Fetch standard normalizes them. */
const NORMALIZED_METHODS = ["DELETE", "GET", "HEAD", "OPTIONS", "POST", "PUT"];
const METHOD_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const REDIRECTS = ["follow", "manual", "error"];

/** What an uncaught error in a callback does: logged, and the script goes on, as in a browser. */
function report(error) {
  console.error("Uncaught", error);
}

core.setUnhandledPromiseRejectionHandler((_promise, reason) => {
  console.error("Uncaught (in promise)", reason);
  return true;
});

function messageOf(error) {
  if (ObjectPrototypeIsPrototypeOf(Error.prototype, error)) return error.message;
  return typeof error === "string" ? error : String(error);
}

function flotiError(code, message) {
  const error = new Error(message);
  error.name = "FlotiError";
  error.code = code;
  return error;
}

function abortError(signal, message = "The operation was aborted.") {
  return signal?.reason ?? new DOMException(message, "AbortError");
}

// ---------------------------------------------------------------------------
// What the protocol carries
// ---------------------------------------------------------------------------

function cannotClone(what) {
  return new DOMException(`${what} cannot be sent: a message is limited to what the protocol carries`, "DataCloneError");
}

/**
 * `value` as a protocol payload: null, booleans, numbers, strings, bytes,
 * arrays and plain objects. undefined is sent as null, and an object's
 * undefined properties are left out. Anything else throws a DataCloneError.
 */
function toWire(value, path = new SafeSet()) {
  switch (typeof value) {
    case "undefined":
      return null;
    case "boolean":
    case "number":
    case "string":
      return value;
    case "bigint":
      throw cannotClone("A BigInt");
    case "symbol":
      throw cannotClone("A symbol");
    case "function":
      throw cannotClone("A function");
  }
  if (value === null) return null;
  if (ArrayBufferIsView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
  }
  if (ObjectPrototypeIsPrototypeOf(ArrayBufferPrototype, value)) {
    return new Uint8Array(ArrayBufferPrototypeSlice(value, 0));
  }
  if (path.has(value)) throw cannotClone("A cyclic object");
  path.add(value);
  try {
    if (ArrayIsArray(value)) return ArrayPrototypeMap(value, (item) => toWire(item, path));
    const prototype = ObjectGetPrototypeOf(value);
    if (prototype !== ObjectPrototype && prototype !== null) {
      throw cannotClone(`A ${value.constructor?.name ?? "non-plain"} object`);
    }
    const out = {};
    for (const key of ObjectKeys(value)) {
      const item = value[key];
      if (item !== undefined) out[key] = toWire(item, path);
    }
    return out;
  } finally {
    path.delete(value);
  }
}

// ---------------------------------------------------------------------------
// Calls to the host
// ---------------------------------------------------------------------------

let nextCall = 1;

/** Calls `method` on the host; aborting `signal` cancels it there. */
function call(method, args, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    let wire;
    try {
      wire = toWire(args);
    } catch (error) {
      reject(flotiError("invalid", `floti.${method}'s arguments cannot be sent: ${messageOf(error)}`));
      return;
    }
    const id = nextCall;
    nextCall = nextCall >= 0x3fffffff ? 1 : nextCall + 1;
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      op_floti_bg_cancel(id);
      reject(abortError(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    PromisePrototypeThen(
      op_floti_bg_call(id, method, wire),
      (outcome) => {
        signal?.removeEventListener("abort", onAbort);
        if (settled) return;
        settled = true;
        if (outcome.ok) resolve(outcome.value);
        else if (outcome.code === "aborted") reject(abortError(undefined, outcome.message));
        else reject(flotiError(outcome.code, outcome.message));
      },
      (error) => {
        signal?.removeEventListener("abort", onAbort);
        if (settled) return;
        settled = true;
        reject(flotiError("unavailable", messageOf(error)));
      },
    );
  });
}

/** A method that answers nothing resolves with undefined. */
const nothing = (promise) => PromisePrototypeThen(promise, () => undefined);

function needsClient(method, why) {
  return () => PromiseReject(flotiError("unavailable", `floti.${method} needs a client: ${why}`));
}

// ---------------------------------------------------------------------------
// fetch
// ---------------------------------------------------------------------------

/** A body as the bytes sent, and the content type it implies. */
function readBody(body) {
  if (body === undefined || body === null) return [null, null];
  if (typeof body === "string") return [new TextEncoder().encode(body), "text/plain;charset=UTF-8"];
  if (ObjectPrototypeIsPrototypeOf(URLSearchParams.prototype, body)) {
    return [new TextEncoder().encode(String(body)), "application/x-www-form-urlencoded;charset=UTF-8"];
  }
  if (ArrayBufferIsView(body)) return [new Uint8Array(body.buffer, body.byteOffset, body.byteLength).slice(), null];
  if (ObjectPrototypeIsPrototypeOf(ArrayBufferPrototype, body)) {
    return [new Uint8Array(ArrayBufferPrototypeSlice(body, 0)), null];
  }
  throw new TypeError("A fetch body in a background script is a string, bytes or URLSearchParams");
}

/** `fetch`'s arguments, taken apart as the host's PluginFetchRequest. */
function readRequest(input, init) {
  const from = typeof input === "object" && input !== null && !ObjectPrototypeIsPrototypeOf(URL.prototype, input) ? input : null;
  const url = new URL(from === null ? String(input) : String(from.url)).href;
  let method = String(init.method ?? from?.method ?? "GET");
  if (!METHOD_TOKEN.test(method)) throw new TypeError(`'${method}' is not a valid HTTP method`);
  const upper = StringPrototypeToUpperCase(method);
  if (ArrayPrototypeIncludes(NORMALIZED_METHODS, upper)) method = upper;
  const headers = new Headers(init.headers ?? from?.headers ?? undefined);
  const [body, type] = readBody(init.body ?? from?.body);
  if (body !== null && (method === "GET" || method === "HEAD")) {
    throw new TypeError(`A ${method} request cannot have a body`);
  }
  if (type !== null && !headers.has("content-type")) headers.set("content-type", type);
  const redirect = String(init.redirect ?? from?.redirect ?? "follow");
  if (!ArrayPrototypeIncludes(REDIRECTS, redirect)) {
    throw new TypeError(`redirect is one of ${ArrayPrototypeJoin(REDIRECTS, ", ")}`);
  }
  const pairs = [];
  for (const pair of headers) ArrayPrototypePush(pairs, pair);
  return { url, method, headers: pairs, body, redirect };
}

/** What a background script's fetch resolves with: a Response as far as reading one goes. */
class Response {
  #status;
  #statusText;
  #headers;
  #url;
  #redirected;
  #body;
  #used = false;

  constructor(answer) {
    this.#status = answer.status;
    this.#statusText = answer.statusText;
    this.#url = answer.url;
    this.#redirected = answer.redirected;
    this.#body = ArrayIncludesStatus(answer.status) ? null : answer.body;
    const headers = new Headers();
    for (const [name, value] of answer.headers) {
      try {
        headers.append(name, value);
      } catch {
        // A header a Response does not hold; fetch would not have shown it either.
      }
    }
    this.#headers = headers;
  }

  get status() {
    return this.#status;
  }
  get statusText() {
    return this.#statusText;
  }
  get ok() {
    return this.#status >= 200 && this.#status <= 299;
  }
  get headers() {
    return this.#headers;
  }
  get url() {
    return this.#url;
  }
  get redirected() {
    return this.#redirected;
  }
  get type() {
    return "basic";
  }
  get body() {
    return null;
  }
  get bodyUsed() {
    return this.#used;
  }

  #consume() {
    if (this.#used) throw new TypeError("The response's body has already been read");
    this.#used = true;
    return this.#body ?? new Uint8Array(0);
  }

  arrayBuffer() {
    try {
      const bytes = this.#consume();
      return PromiseResolve(ArrayBufferPrototypeSlice(bytes.buffer, bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    } catch (error) {
      return PromiseReject(error);
    }
  }

  bytes() {
    try {
      return PromiseResolve(this.#consume().slice());
    } catch (error) {
      return PromiseReject(error);
    }
  }

  text() {
    try {
      return PromiseResolve(new TextDecoder().decode(this.#consume()));
    } catch (error) {
      return PromiseReject(error);
    }
  }

  json() {
    return PromisePrototypeThen(this.text(), (text) => JSONParse(text));
  }

  clone() {
    if (this.#used) throw new TypeError("A response whose body has been read cannot be cloned");
    return new Response({
      status: this.#status,
      statusText: this.#statusText,
      headers: [...this.#headers],
      body: this.#body === null ? null : this.#body.slice(),
      url: this.#url,
      redirected: this.#redirected,
    });
  }
}

function ArrayIncludesStatus(status) {
  return ArrayPrototypeIncludes(NULL_BODY, status);
}

// ---------------------------------------------------------------------------
// Events and tools
// ---------------------------------------------------------------------------

const listeners = new SafeMap();

function emit(name, data) {
  const set = listeners.get(name);
  if (set === undefined) return;
  for (const listener of [...set]) {
    try {
      listener(data);
    } catch (error) {
      report(error);
    }
  }
}

const handlers = new SafeMap();
const awaitingHandler = new SafeMap();
const answering = new SafeMap();

/** The handler for `name`, once one is registered; null when none is within `waitMs` or the call is aborted. */
function handlerFor(name, signal, waitMs) {
  const now = handlers.get(name);
  if (now !== undefined) return PromiseResolve(now);
  return new Promise((resolve) => {
    const waiters = awaitingHandler.get(name) ?? new SafeSet();
    let timer = null;
    const done = () => {
      if (timer !== null) core.cancelTimer(timer);
      signal.removeEventListener("abort", done);
      waiters.delete(done);
      if (waiters.size === 0) awaitingHandler.delete(name);
      resolve(signal.aborted ? null : (handlers.get(name) ?? null));
    };
    timer = core.createTimer(done, waitMs > 0 ? waitMs : 1, undefined, false, true);
    signal.addEventListener("abort", done, { once: true });
    waiters.add(done);
    awaitingHandler.set(name, waiters);
  });
}

/**
 * A handler's answer as the text a session reads: a string as it is, nothing
 * as `Done.`, and anything else as JSON.
 */
function toolText(value) {
  let text;
  if (typeof value === "string") text = value;
  else if (value === undefined) text = "Done.";
  else {
    try {
      text = JSONStringify(value, null, 2);
    } catch (error) {
      throw new Error(`The tool's answer could not be written as JSON: ${messageOf(error)}`);
    }
    if (text === undefined) throw new Error(`The tool answered with a ${typeof value}, which is not text or JSON.`);
  }
  if (text.length > TOOL_ANSWER_MAX_CHARS) {
    throw new Error(
      `The tool's answer is ${text.length} characters, and a tool may answer with ${TOOL_ANSWER_MAX_CHARS} at most.`,
    );
  }
  return text;
}

async function answerTool(message) {
  const controller = new AbortController();
  answering.set(message.id, controller);
  let ok = false;
  let text = "";
  try {
    const handler = await handlerFor(message.name, controller.signal, message.waitMs);
    if (controller.signal.aborted) return;
    if (handler === null) {
      throw new Error(
        `The plugin's background script has no handler for ${message.name}. It registers one with floti.tools.handle('${message.name}', ...) as it starts.`,
      );
    }
    const value = await handler(message.args, { session: message.session, signal: controller.signal });
    text = toolText(value);
    ok = true;
  } catch (error) {
    text = messageOf(error);
  } finally {
    answering.delete(message.id);
  }
  // Nobody is waiting for it: the call was cancelled while the handler ran.
  if (!controller.signal.aborted) op_floti_bg_tool_result(message.id, ok, text);
}

// ---------------------------------------------------------------------------
// BroadcastChannel
// ---------------------------------------------------------------------------

const ON_MESSAGE = SymbolFor("floti.onmessage");
const ON_MESSAGE_ERROR = SymbolFor("floti.onmessageerror");
const DELIVER = Symbol("deliver");
const open = new SafeMap();

class BroadcastChannel extends EventTarget {
  #name;
  #closed = false;

  constructor(name) {
    super();
    if (arguments.length === 0) throw new TypeError("BroadcastChannel needs a name");
    this.#name = String(name);
    let set = open.get(this.#name);
    if (set === undefined) {
      set = new SafeSet();
      open.set(this.#name, set);
    }
    set.add(this);
  }

  get name() {
    return this.#name;
  }

  get onmessage() {
    return this[ON_MESSAGE] ?? null;
  }
  set onmessage(handler) {
    this[ON_MESSAGE] = typeof handler === "function" ? handler : null;
  }

  get onmessageerror() {
    return this[ON_MESSAGE_ERROR] ?? null;
  }
  set onmessageerror(handler) {
    this[ON_MESSAGE_ERROR] = typeof handler === "function" ? handler : null;
  }

  postMessage(message) {
    if (arguments.length === 0) throw new TypeError("postMessage needs a message");
    if (this.#closed) throw new DOMException("The BroadcastChannel is closed", "InvalidStateError");
    const wire = toWire(message);
    deliver(this.#name, wire, this);
    op_floti_bg_broadcast(this.#name, wire);
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    const set = open.get(this.#name);
    set?.delete(this);
    if (set?.size === 0) open.delete(this.#name);
  }

  [DELIVER](wire) {
    if (this.#closed) return;
    this.dispatchEvent(new MessageEvent("message", { data: structuredClone(wire) }));
  }
}

/** Queues `wire` for every open channel named `name` but `sender`, as a task of its own. */
function deliver(name, wire, sender) {
  const set = open.get(name);
  if (set === undefined) return;
  const targets = [];
  for (const channel of set) if (channel !== sender) ArrayPrototypePush(targets, channel);
  if (targets.length === 0) return;
  core.createTimer(
    () => {
      for (const channel of targets) {
        try {
          channel[DELIVER](wire);
        } catch (error) {
          report(error);
        }
      }
    },
    1,
    undefined,
    false,
    true,
  );
}

// ---------------------------------------------------------------------------
// Timers
// ---------------------------------------------------------------------------

const timers = new SafeMap();
let nextTimer = 1;

function startTimer(repeat, callback, delay, args) {
  if (typeof callback !== "function") {
    throw new TypeError(`${repeat ? "setInterval" : "setTimeout"} takes a function`);
  }
  const id = nextTimer++;
  const ms = Number(delay);
  const timer = core.createTimer(
    () => {
      if (!repeat) timers.delete(id);
      try {
        ReflectApply(callback, globalThis, args);
      } catch (error) {
        report(error);
      }
    },
    ms >= 1 ? ms : 1,
    undefined,
    repeat,
    true,
  );
  timers.set(id, timer);
  return id;
}

function clearTimer(id) {
  const key = Number(id);
  const timer = timers.get(key);
  if (timer === undefined) return;
  timers.delete(key);
  core.cancelTimer(timer);
}

function setTimeout(callback, delay = 0, ...args) {
  return startTimer(false, callback, delay, args);
}

function setInterval(callback, delay = 0, ...args) {
  return startTimer(true, callback, delay, args);
}

function clearTimeout(id) {
  clearTimer(id);
}

function clearInterval(id) {
  clearTimer(id);
}

// ---------------------------------------------------------------------------
// floti
// ---------------------------------------------------------------------------

const { plugin } = op_floti_bg_context();
const context = ObjectFreeze({ plugin, surface: "background", name: "background", params: ObjectFreeze({}) });

const floti = ObjectFreeze({
  apiVersion: 2,
  context,
  visible: false,

  fetch(input, init = {}) {
    let request;
    try {
      request = readRequest(input, init ?? {});
    } catch (error) {
      return PromiseReject(error);
    }
    const signal = init?.signal ?? input?.signal;
    return PromisePrototypeThen(call("fetch", [request], signal), (answer) => new Response(answer));
  },

  exec(command, args, options) {
    return call("exec", [command, args === undefined ? [] : args, options ?? {}]);
  },

  open: needsClient("open", "a background script has no Browser tab to open a link in"),

  tabs: ObjectFreeze({
    open: needsClient("tabs.open", "a background script has no window to open a tab in"),
  }),

  surface: ObjectFreeze({
    setTitle() {},
    keep() {},
  }),

  status: ObjectFreeze({
    set: (item) => nothing(call("status.set", [item])),
  }),

  badge: ObjectFreeze({
    set: (count) => nothing(call("badge.set", [count])),
  }),

  settings: ObjectFreeze({
    get: () => call("settings.get", []),
  }),

  secrets: ObjectFreeze({
    state: (key) => call("secrets.state", [key]),
    request: needsClient("secrets.request", "only a plugin's page can show the dialog that asks the user for a secret"),
  }),

  sessions: ObjectFreeze({
    start: needsClient("sessions.start", "only a click in a plugin's page can ask the user to start a session"),
    list: needsClient("sessions.list", "a background script hears the sessions through floti.on('sessions')"),
  }),

  tools: ObjectFreeze({
    handle(name, handler) {
      if (typeof name !== "string" || name === "") throw flotiError("invalid", "floti.tools.handle needs the name of a tool");
      if (typeof handler !== "function") throw flotiError("invalid", "floti.tools.handle needs a function to answer the tool");
      handlers.set(name, handler);
      for (const wake of [...(awaitingHandler.get(name) ?? [])]) wake();
      return () => {
        if (handlers.get(name) === handler) handlers.delete(name);
      };
    },
  }),

  on(event, listener) {
    if (typeof listener !== "function") throw flotiError("invalid", "floti.on needs a function to call");
    const name = String(event);
    let set = listeners.get(name);
    if (set === undefined) {
      set = new SafeSet();
      listeners.set(name, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  },
});

// ---------------------------------------------------------------------------
// What the host sends
// ---------------------------------------------------------------------------

function receive(message) {
  switch (message.t) {
    case "tool":
      PromisePrototypeThen(answerTool(message), undefined, report);
      return;
    case "toolCancel":
      answering.get(message.id)?.abort();
      return;
    case "event":
      emit(message.name, message.data);
      return;
    case "broadcast":
      deliver(message.name, message.data, null);
      return;
  }
}

async function pump() {
  for (;;) {
    const message = await op_floti_bg_next();
    if (message === null || message === undefined) return;
    try {
      receive(message);
    } catch (error) {
      report(error);
    }
  }
}

PromisePrototypeThen(pump(), undefined, () => {});

// ---------------------------------------------------------------------------
// The globals
// ---------------------------------------------------------------------------

ObjectDefineProperty(globalThis, "floti", { value: floti, enumerable: true, configurable: false, writable: false });
for (const [name, value] of [
  ["BroadcastChannel", BroadcastChannel],
  ["setTimeout", setTimeout],
  ["setInterval", setInterval],
  ["clearTimeout", clearTimeout],
  ["clearInterval", clearInterval],
]) {
  ObjectDefineProperty(globalThis, name, { value, writable: true, configurable: true, enumerable: false });
}
