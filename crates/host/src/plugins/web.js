// The web's data types, for a plugin isolate: URL and URLSearchParams,
// Headers, TextEncoder and TextDecoder, Event, EventTarget, AbortController
// and AbortSignal, DOMException, structuredClone and console.
//
// Only data types. Nothing here reaches the network, the disk, a timer or a
// process: what a plugin may do beyond computing is what the host gives it
// later, as `floti.*`. URL parsing and form encoding are the `url` crate's,
// so a URL reads the same here as anywhere else in the host. console writes
// to the host's log for the plugin, never to the host's own output.
//
// `confine` runs once the host has installed everything else it gives the
// isolate: it removes every global that is neither ECMAScript's, one of
// these, nor one the host names, so nothing deno_core keeps for itself
// (`Deno`, `__bootstrap`) is left in reach of a plugin's script.

import { core, primordials } from "ext:core/mod.js";
import {
  op_floti_console,
  op_floti_form_parse,
  op_floti_form_serialize,
  op_floti_url_parse,
  op_floti_url_set,
  op_floti_utf8_decode,
} from "ext:core/ops";

const {
  ArrayBufferIsView,
  ArrayIsArray,
  ArrayPrototypeFilter,
  ArrayPrototypeIncludes,
  ArrayPrototypeIndexOf,
  ArrayPrototypeJoin,
  ArrayPrototypeMap,
  ArrayPrototypePush,
  ArrayPrototypeSlice,
  ArrayPrototypeSplice,
  DateNow,
  Error,
  JSONStringify,
  MapPrototypeGet,
  MapPrototypeSet,
  ObjectDefineProperty,
  ObjectEntries,
  ObjectFreeze,
  ObjectPrototypeIsPrototypeOf,
  RangeError,
  ReflectDeleteProperty,
  ReflectOwnKeys,
  SafeMap,
  SafeSet,
  SetPrototypeHas,
  String,
  StringPrototypeCharCodeAt,
  StringPrototypeReplace,
  StringPrototypeSlice,
  StringPrototypeToLowerCase,
  StringPrototypeTrim,
  Symbol,
  SymbolFor,
  SymbolIterator,
  SymbolToStringTag,
  TypeError,
  Uint8Array,
} = primordials;

// ---------------------------------------------------------------------------
// DOMException
// ---------------------------------------------------------------------------

const DOM_CODES = ObjectFreeze({
  IndexSizeError: 1,
  HierarchyRequestError: 3,
  WrongDocumentError: 4,
  InvalidCharacterError: 5,
  NoModificationAllowedError: 7,
  NotFoundError: 8,
  NotSupportedError: 9,
  InvalidStateError: 11,
  SyntaxError: 12,
  InvalidModificationError: 13,
  NamespaceError: 14,
  InvalidAccessError: 15,
  TypeMismatchError: 17,
  SecurityError: 18,
  NetworkError: 19,
  AbortError: 20,
  URLMismatchError: 21,
  QuotaExceededError: 22,
  TimeoutError: 23,
  InvalidNodeTypeError: 24,
  DataCloneError: 25,
});

class DOMException extends Error {
  #name;
  #code;

  constructor(message = "", name = "Error") {
    super(String(message));
    this.#name = String(name);
    this.#code = DOM_CODES[this.#name] ?? 0;
  }

  get name() {
    return this.#name;
  }

  get code() {
    return this.#code;
  }
}

for (const [name, code] of ObjectEntries(DOM_CODES)) {
  const constant = StringPrototypeReplace(name, /([a-z])([A-Z])/g, "$1_$2")
    .toUpperCase()
    .replace(/_ERROR$/, "_ERR");
  ObjectDefineProperty(DOMException, constant, { value: code, enumerable: true });
}

// ---------------------------------------------------------------------------
// Event and EventTarget
// ---------------------------------------------------------------------------

const setTarget = Symbol("setTarget");
const stopped = Symbol("stopped");

class Event {
  #type;
  #bubbles;
  #cancelable;
  #composed;
  #defaultPrevented = false;
  #target = null;
  #currentTarget = null;
  #timeStamp = DateNow();
  [stopped] = false;

  constructor(type, init = {}) {
    if (arguments.length === 0) throw new TypeError("Event needs a type");
    this.#type = String(type);
    this.#bubbles = !!init?.bubbles;
    this.#cancelable = !!init?.cancelable;
    this.#composed = !!init?.composed;
  }

  get type() {
    return this.#type;
  }
  get bubbles() {
    return this.#bubbles;
  }
  get cancelable() {
    return this.#cancelable;
  }
  get composed() {
    return this.#composed;
  }
  get defaultPrevented() {
    return this.#defaultPrevented;
  }
  get target() {
    return this.#target;
  }
  get srcElement() {
    return this.#target;
  }
  get currentTarget() {
    return this.#currentTarget;
  }
  get eventPhase() {
    return this.#currentTarget === null ? 0 : 2;
  }
  get timeStamp() {
    return this.#timeStamp;
  }
  get isTrusted() {
    return false;
  }
  get returnValue() {
    return !this.#defaultPrevented;
  }
  composedPath() {
    return this.#currentTarget === null ? [] : [this.#currentTarget];
  }
  preventDefault() {
    if (this.#cancelable) this.#defaultPrevented = true;
  }
  stopPropagation() {}
  stopImmediatePropagation() {
    this[stopped] = true;
  }

  [setTarget](target, current) {
    if (this.#target === null) this.#target = target;
    this.#currentTarget = current;
  }
}

ObjectDefineProperty(Event, "NONE", { value: 0 });
ObjectDefineProperty(Event, "CAPTURING_PHASE", { value: 1 });
ObjectDefineProperty(Event, "AT_TARGET", { value: 2 });
ObjectDefineProperty(Event, "BUBBLING_PHASE", { value: 3 });

class MessageEvent extends Event {
  #data;
  #origin;
  #lastEventId;

  constructor(type, init = {}) {
    super(type, init);
    this.#data = init?.data ?? null;
    this.#origin = String(init?.origin ?? "");
    this.#lastEventId = String(init?.lastEventId ?? "");
  }

  get data() {
    return this.#data;
  }
  get origin() {
    return this.#origin;
  }
  get lastEventId() {
    return this.#lastEventId;
  }
  get source() {
    return null;
  }
  get ports() {
    return [];
  }
}

/** Reports a listener's exception the way a browser does: logged, and the dispatch goes on. */
function reportError(error) {
  globalConsole.error("Uncaught", error);
}

class EventTarget {
  #listeners = new SafeMap();

  addEventListener(type, callback, options) {
    if (callback === null || callback === undefined) return;
    const capture = typeof options === "boolean" ? options : !!options?.capture;
    const once = typeof options === "object" && options !== null && !!options.once;
    const signal = typeof options === "object" && options !== null ? options.signal : undefined;
    if (signal?.aborted) return;
    const key = String(type);
    let list = MapPrototypeGet(this.#listeners, key);
    if (list === undefined) {
      list = [];
      MapPrototypeSet(this.#listeners, key, list);
    }
    for (const listener of list) {
      if (listener.callback === callback && listener.capture === capture) return;
    }
    const listener = { callback, capture, once, removed: false };
    ArrayPrototypePush(list, listener);
    signal?.addEventListener("abort", () => this.removeEventListener(key, callback, capture));
  }

  removeEventListener(type, callback, options) {
    const capture = typeof options === "boolean" ? options : !!options?.capture;
    const list = MapPrototypeGet(this.#listeners, String(type));
    if (list === undefined) return;
    for (let i = 0; i < list.length; i++) {
      if (list[i].callback === callback && list[i].capture === capture) {
        list[i].removed = true;
        ArrayPrototypeSplice(list, i, 1);
        return;
      }
    }
  }

  dispatchEvent(event) {
    if (!ObjectPrototypeIsPrototypeOf(Event.prototype, event)) {
      throw new TypeError("dispatchEvent takes an Event");
    }
    event[setTarget](this, this);
    const handler = this[eventHandler(event.type)];
    const list = ArrayPrototypeSlice(MapPrototypeGet(this.#listeners, event.type) ?? []);
    if (typeof handler === "function") ArrayPrototypePush(list, { callback: handler, once: false, removed: false });
    for (const listener of list) {
      if (listener.removed) continue;
      if (listener.once) this.removeEventListener(event.type, listener.callback, listener.capture);
      try {
        if (typeof listener.callback === "function") listener.callback.call(this, event);
        else listener.callback.handleEvent(event);
      } catch (error) {
        reportError(error);
      }
      if (event[stopped]) break;
    }
    event[setTarget](this, null);
    return !event.defaultPrevented;
  }
}

/** Where an `on<type>` handler is kept, for the targets that have one. */
function eventHandler(type) {
  return SymbolFor(`floti.on${type}`);
}

// ---------------------------------------------------------------------------
// AbortController and AbortSignal
// ---------------------------------------------------------------------------

const illegal = Symbol("illegal");
const signalAbort = Symbol("signalAbort");

class AbortSignal extends EventTarget {
  #aborted = false;
  #reason = undefined;

  constructor(key) {
    if (key !== illegal) throw new TypeError("Illegal constructor");
    super();
  }

  static abort(reason) {
    const signal = new AbortSignal(illegal);
    signal[signalAbort](reason);
    return signal;
  }

  static any(signals) {
    const signal = new AbortSignal(illegal);
    for (const source of signals) {
      if (source.aborted) {
        signal[signalAbort](source.reason);
        return signal;
      }
    }
    for (const source of signals) {
      source.addEventListener("abort", () => signal[signalAbort](source.reason), { once: true });
    }
    return signal;
  }

  get aborted() {
    return this.#aborted;
  }

  get reason() {
    return this.#reason;
  }

  get onabort() {
    return this[eventHandler("abort")] ?? null;
  }

  set onabort(handler) {
    this[eventHandler("abort")] = typeof handler === "function" ? handler : null;
  }

  throwIfAborted() {
    if (this.#aborted) throw this.#reason;
  }

  [signalAbort](reason) {
    if (this.#aborted) return;
    this.#aborted = true;
    this.#reason = reason === undefined ? new DOMException("This operation was aborted", "AbortError") : reason;
    this.dispatchEvent(new Event("abort"));
  }
}

class AbortController {
  #signal = new AbortSignal(illegal);

  get signal() {
    return this.#signal;
  }

  abort(reason) {
    this.#signal[signalAbort](reason);
  }
}

// ---------------------------------------------------------------------------
// TextEncoder and TextDecoder
// ---------------------------------------------------------------------------

class TextEncoder {
  get encoding() {
    return "utf-8";
  }

  encode(input = "") {
    return core.encode(String(input));
  }

  encodeInto(source, destination) {
    let read = 0;
    let written = 0;
    for (const char of String(source)) {
      const bytes = core.encode(char);
      if (written + bytes.length > destination.length) break;
      destination.set(bytes, written);
      written += bytes.length;
      read += char.length;
    }
    return { read, written };
  }
}

const UTF8_LABELS = ["unicode-1-1-utf-8", "unicode11utf8", "unicode20utf8", "utf-8", "utf8", "x-unicode20utf8"];

/** The bytes of an ArrayBuffer or a view, as one Uint8Array over them. */
function bytesOf(input) {
  if (input === undefined) return new Uint8Array(0);
  if (ArrayBufferIsView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (core.isAnyArrayBuffer(input)) return new Uint8Array(input);
  throw new TypeError("decode takes an ArrayBuffer or a view of one");
}

/** How many bytes at the end of `bytes` begin a UTF-8 sequence they do not finish. */
function unfinished(bytes) {
  let at = bytes.length - 1;
  let continuation = 0;
  while (at >= 0 && continuation < 3 && (bytes[at] & 0xc0) === 0x80) {
    at--;
    continuation++;
  }
  if (at < 0) return 0;
  const lead = bytes[at];
  const needs = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  const has = bytes.length - at;
  return has < needs ? has : 0;
}

class TextDecoder {
  #fatal;
  #ignoreBOM;
  #pending = new Uint8Array(0);
  #started = false;

  constructor(label = "utf-8", options = {}) {
    if (!ArrayPrototypeIncludes(UTF8_LABELS, StringPrototypeToLowerCase(StringPrototypeTrim(String(label))))) {
      throw new RangeError(`The encoding "${label}" is not supported: this decoder reads UTF-8`);
    }
    this.#fatal = !!options?.fatal;
    this.#ignoreBOM = !!options?.ignoreBOM;
  }

  get encoding() {
    return "utf-8";
  }
  get fatal() {
    return this.#fatal;
  }
  get ignoreBOM() {
    return this.#ignoreBOM;
  }

  decode(input, options = {}) {
    let bytes = bytesOf(input);
    if (this.#pending.length > 0) {
      const joined = new Uint8Array(this.#pending.length + bytes.length);
      joined.set(this.#pending, 0);
      joined.set(bytes, this.#pending.length);
      bytes = joined;
    }
    const stream = !!options?.stream;
    const held = stream ? unfinished(bytes) : 0;
    this.#pending = held === 0 ? new Uint8Array(0) : bytes.slice(bytes.length - held);
    const ready = held === 0 ? bytes : bytes.subarray(0, bytes.length - held);
    const stripBom = !this.#ignoreBOM && !this.#started;
    if (ready.length > 0) this.#started = true;
    const text = op_floti_utf8_decode(ready, this.#fatal, stripBom);
    if (!stream) this.#started = false;
    return text;
  }
}

// ---------------------------------------------------------------------------
// URLSearchParams and URL
// ---------------------------------------------------------------------------

const linkUrl = Symbol("linkUrl");
const replaceList = Symbol("replaceList");

class URLSearchParams {
  #list = [];
  #url = null;

  constructor(init = "") {
    if (typeof init === "object" && init !== null) {
      if (ObjectPrototypeIsPrototypeOf(URLSearchParams.prototype, init)) {
        this.#list = ArrayPrototypeMap(init.#list, (pair) => [pair[0], pair[1]]);
      } else if (typeof init[SymbolIterator] === "function") {
        for (const pair of init) {
          const entry = [...pair];
          if (entry.length !== 2) throw new TypeError("each pair for URLSearchParams has a name and a value");
          ArrayPrototypePush(this.#list, [String(entry[0]), String(entry[1])]);
        }
      } else {
        for (const key of ReflectOwnKeys(init)) {
          if (typeof key === "string") ArrayPrototypePush(this.#list, [key, String(init[key])]);
        }
      }
    } else {
      let text = String(init);
      if (text[0] === "?") text = StringPrototypeSlice(text, 1);
      this.#list = op_floti_form_parse(text);
    }
  }

  [linkUrl](url) {
    this.#url = url;
  }

  [replaceList](search) {
    this.#list = op_floti_form_parse(search[0] === "?" ? StringPrototypeSlice(search, 1) : search);
  }

  #update() {
    if (this.#url === null) return;
    const text = this.toString();
    this.#url[updateSearch](text === "" ? "" : `?${text}`);
  }

  get size() {
    return this.#list.length;
  }

  append(name, value) {
    ArrayPrototypePush(this.#list, [String(name), String(value)]);
    this.#update();
  }

  delete(name, value) {
    const key = String(name);
    const only = value === undefined ? undefined : String(value);
    this.#list = ArrayPrototypeFilter(this.#list, (pair) => pair[0] !== key || (only !== undefined && pair[1] !== only));
    this.#update();
  }

  get(name) {
    const key = String(name);
    for (const pair of this.#list) if (pair[0] === key) return pair[1];
    return null;
  }

  getAll(name) {
    const key = String(name);
    return ArrayPrototypeMap(
      ArrayPrototypeFilter(this.#list, (pair) => pair[0] === key),
      (pair) => pair[1],
    );
  }

  has(name, value) {
    const key = String(name);
    const only = value === undefined ? undefined : String(value);
    for (const pair of this.#list) {
      if (pair[0] === key && (only === undefined || pair[1] === only)) return true;
    }
    return false;
  }

  set(name, value) {
    const key = String(name);
    const text = String(value);
    const at = this.#list.findIndex((pair) => pair[0] === key);
    if (at === -1) {
      ArrayPrototypePush(this.#list, [key, text]);
    } else {
      this.#list[at][1] = text;
      this.#list = ArrayPrototypeFilter(this.#list, (pair, index) => index <= at || pair[0] !== key);
    }
    this.#update();
  }

  sort() {
    // Stable, by UTF-16 code units, as the standard sorts.
    const indexed = ArrayPrototypeMap(this.#list, (pair, index) => [pair, index]);
    indexed.sort((a, b) => (a[0][0] < b[0][0] ? -1 : a[0][0] > b[0][0] ? 1 : a[1] - b[1]));
    this.#list = ArrayPrototypeMap(indexed, (item) => item[0]);
    this.#update();
  }

  forEach(callback, thisArg) {
    for (const pair of ArrayPrototypeSlice(this.#list)) callback.call(thisArg, pair[1], pair[0], this);
  }

  *entries() {
    for (const pair of ArrayPrototypeSlice(this.#list)) yield [pair[0], pair[1]];
  }

  *keys() {
    for (const pair of ArrayPrototypeSlice(this.#list)) yield pair[0];
  }

  *values() {
    for (const pair of ArrayPrototypeSlice(this.#list)) yield pair[1];
  }

  [SymbolIterator]() {
    return this.entries();
  }

  toString() {
    return op_floti_form_serialize(this.#list);
  }

  get [SymbolToStringTag]() {
    return "URLSearchParams";
  }
}

const updateSearch = Symbol("updateSearch");

/** The parts `op_floti_url_parse` answers, in its order. */
const HREF = 0;
const ORIGIN = 1;
const PROTOCOL = 2;
const USERNAME = 3;
const PASSWORD = 4;
const HOST = 5;
const HOSTNAME = 6;
const PORT = 7;
const PATHNAME = 8;
const SEARCH = 9;
const HASH = 10;

class URL {
  #parts;
  #params = null;

  constructor(url, base) {
    this.#parts = base === undefined
      ? op_floti_url_parse(String(url), "", false)
      : op_floti_url_parse(String(url), String(base), true);
  }

  static canParse(url, base) {
    try {
      new URL(url, base);
      return true;
    } catch {
      return false;
    }
  }

  static parse(url, base) {
    try {
      return new URL(url, base);
    } catch {
      return null;
    }
  }

  #set(part, value) {
    this.#parts = op_floti_url_set(this.#parts[HREF], part, String(value));
    if (part === "href" || part === "search") this.#params?.[replaceList](this.#parts[SEARCH]);
  }

  [updateSearch](search) {
    this.#parts = op_floti_url_set(this.#parts[HREF], "search", search);
  }

  get href() {
    return this.#parts[HREF];
  }
  set href(value) {
    this.#set("href", value);
  }
  get origin() {
    return this.#parts[ORIGIN];
  }
  get protocol() {
    return this.#parts[PROTOCOL];
  }
  set protocol(value) {
    this.#set("protocol", value);
  }
  get username() {
    return this.#parts[USERNAME];
  }
  set username(value) {
    this.#set("username", value);
  }
  get password() {
    return this.#parts[PASSWORD];
  }
  set password(value) {
    this.#set("password", value);
  }
  get host() {
    return this.#parts[HOST];
  }
  set host(value) {
    this.#set("host", value);
  }
  get hostname() {
    return this.#parts[HOSTNAME];
  }
  set hostname(value) {
    this.#set("hostname", value);
  }
  get port() {
    return this.#parts[PORT];
  }
  set port(value) {
    this.#set("port", value);
  }
  get pathname() {
    return this.#parts[PATHNAME];
  }
  set pathname(value) {
    this.#set("pathname", value);
  }
  get search() {
    return this.#parts[SEARCH];
  }
  set search(value) {
    this.#set("search", value);
  }
  get hash() {
    return this.#parts[HASH];
  }
  set hash(value) {
    this.#set("hash", value);
  }

  get searchParams() {
    if (this.#params === null) {
      this.#params = new URLSearchParams(this.#parts[SEARCH]);
      this.#params[linkUrl](this);
    }
    return this.#params;
  }

  toString() {
    return this.#parts[HREF];
  }

  toJSON() {
    return this.#parts[HREF];
  }

  get [SymbolToStringTag]() {
    return "URL";
  }
}

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function headerName(name) {
  const text = String(name);
  if (!TOKEN.test(text)) throw new TypeError(`"${text}" is not a header name`);
  return StringPrototypeToLowerCase(text);
}

function headerValue(value) {
  const text = StringPrototypeReplace(String(value), /^[\t\n\r ]+|[\t\n\r ]+$/g, "");
  for (let i = 0; i < text.length; i++) {
    const code = StringPrototypeCharCodeAt(text, i);
    if (code === 0 || code === 0x0a || code === 0x0d || code > 0xff) {
      throw new TypeError(`"${text}" is not a header value`);
    }
  }
  return text;
}

class Headers {
  /** [lower-cased name, value], in the order they were added. */
  #list = [];

  constructor(init) {
    if (init === undefined || init === null) return;
    if (ObjectPrototypeIsPrototypeOf(Headers.prototype, init)) {
      for (const pair of init.#list) ArrayPrototypePush(this.#list, [pair[0], pair[1]]);
    } else if (typeof init[SymbolIterator] === "function") {
      for (const pair of init) {
        const entry = [...pair];
        if (entry.length !== 2) throw new TypeError("each header has a name and a value");
        this.append(entry[0], entry[1]);
      }
    } else if (typeof init === "object") {
      for (const key of ReflectOwnKeys(init)) {
        if (typeof key === "string") this.append(key, init[key]);
      }
    } else {
      throw new TypeError("Headers takes headers, a list of pairs or a record");
    }
  }

  append(name, value) {
    ArrayPrototypePush(this.#list, [headerName(name), headerValue(value)]);
  }

  delete(name) {
    const key = headerName(name);
    this.#list = ArrayPrototypeFilter(this.#list, (pair) => pair[0] !== key);
  }

  get(name) {
    const key = headerName(name);
    const values = ArrayPrototypeMap(
      ArrayPrototypeFilter(this.#list, (pair) => pair[0] === key),
      (pair) => pair[1],
    );
    return values.length === 0 ? null : ArrayPrototypeJoin(values, ", ");
  }

  getSetCookie() {
    return ArrayPrototypeMap(
      ArrayPrototypeFilter(this.#list, (pair) => pair[0] === "set-cookie"),
      (pair) => pair[1],
    );
  }

  has(name) {
    const key = headerName(name);
    return this.#list.some((pair) => pair[0] === key);
  }

  set(name, value) {
    const key = headerName(name);
    const text = headerValue(value);
    const at = this.#list.findIndex((pair) => pair[0] === key);
    if (at === -1) {
      ArrayPrototypePush(this.#list, [key, text]);
    } else {
      this.#list[at][1] = text;
      this.#list = ArrayPrototypeFilter(this.#list, (pair, index) => index <= at || pair[0] !== key);
    }
  }

  /** Sorted by name, each name once with its values joined, but every Set-Cookie on its own. */
  #sorted() {
    const names = [];
    for (const pair of this.#list) {
      if (ArrayPrototypeIndexOf(names, pair[0]) === -1) ArrayPrototypePush(names, pair[0]);
    }
    names.sort();
    const out = [];
    for (const name of names) {
      if (name === "set-cookie") {
        for (const value of this.getSetCookie()) ArrayPrototypePush(out, [name, value]);
      } else {
        ArrayPrototypePush(out, [name, this.get(name)]);
      }
    }
    return out;
  }

  forEach(callback, thisArg) {
    for (const pair of this.#sorted()) callback.call(thisArg, pair[1], pair[0], this);
  }

  *entries() {
    yield* this.#sorted();
  }

  *keys() {
    for (const pair of this.#sorted()) yield pair[0];
  }

  *values() {
    for (const pair of this.#sorted()) yield pair[1];
  }

  [SymbolIterator]() {
    return this.entries();
  }

  get [SymbolToStringTag]() {
    return "Headers";
  }
}

// ---------------------------------------------------------------------------
// structuredClone
// ---------------------------------------------------------------------------

function structuredClone(value, options) {
  if (options?.transfer !== undefined && [...options.transfer].length > 0) {
    throw new DOMException("structuredClone cannot transfer in a plugin isolate", "DataCloneError");
  }
  try {
    return core.structuredClone(value);
  } catch (error) {
    throw new DOMException(String(error?.message ?? error), "DataCloneError");
  }
}

// ---------------------------------------------------------------------------
// console
// ---------------------------------------------------------------------------

/** A value as a log line shows it: deep enough to read, never endless. */
function inspect(value, depth = 0, seen = new SafeSet()) {
  switch (typeof value) {
    case "string":
      return depth === 0 ? value : JSONStringify(value);
    case "number":
    case "boolean":
    case "undefined":
    case "symbol":
      return String(value);
    case "bigint":
      return `${value}n`;
    case "function":
      return value.name ? `[Function: ${value.name}]` : "[Function (anonymous)]";
  }
  if (value === null) return "null";
  if (ObjectPrototypeIsPrototypeOf(Error.prototype, value)) return value.stack ?? `${value.name}: ${value.message}`;
  if (SetPrototypeHas(seen, value)) return "[Circular]";
  if (depth > 4) return ArrayIsArray(value) ? "[Array]" : "[Object]";
  seen.add(value);
  try {
    if (ObjectPrototypeIsPrototypeOf(URL.prototype, value)) return `URL ${value.href}`;
    if (ArrayIsArray(value)) {
      return `[ ${ArrayPrototypeJoin(ArrayPrototypeMap(value, (item) => inspect(item, depth + 1, seen)), ", ")} ]`;
    }
    if (ArrayBufferIsView(value)) return `${value.constructor?.name ?? "View"}(${value.length ?? value.byteLength})`;
    const entries = ArrayPrototypeMap(ObjectEntries(value), ([key, item]) => `${key}: ${inspect(item, depth + 1, seen)}`);
    const tag = value.constructor?.name && value.constructor !== Object ? `${value.constructor.name} ` : "";
    return entries.length === 0 ? `${tag}{}` : `${tag}{ ${ArrayPrototypeJoin(entries, ", ")} }`;
  } finally {
    seen.delete(value);
  }
}

/** console's arguments as one line: a leading string's `%s %d %i %f %o %O %c %%`, then the rest. */
function format(args) {
  if (args.length === 0) return "";
  const out = [];
  let rest = 0;
  if (typeof args[0] === "string") {
    let next = 1;
    const text = StringPrototypeReplace(args[0], /%[sdifoOjc%]/g, (spec) => {
      if (spec === "%%") return "%";
      if (next >= args.length) return spec;
      const arg = args[next++];
      switch (spec) {
        case "%s":
          return typeof arg === "string" ? arg : inspect(arg, 1);
        case "%d":
        case "%i":
          return typeof arg === "bigint" ? `${arg}n` : String(spec === "%i" ? Math.trunc(Number(arg)) : Number(arg));
        case "%f":
          return String(Number(arg));
        case "%c":
          return "";
        default:
          return inspect(arg, 1);
      }
    });
    ArrayPrototypePush(out, text);
    rest = next;
  }
  for (let i = rest; i < args.length; i++) ArrayPrototypePush(out, inspect(args[i]));
  return ArrayPrototypeJoin(out, " ");
}

let indent = "";
const counts = new SafeMap();
const timers = new SafeMap();

function write(level, args) {
  const text = format(args);
  op_floti_console(level, indent === "" ? text : StringPrototypeReplace(indent + text, /\n/g, `\n${indent}`));
}

const globalConsole = {
  log: (...args) => write("info", args),
  info: (...args) => write("info", args),
  debug: (...args) => write("debug", args),
  trace: (...args) => write("debug", [...args, new Error("Trace").stack]),
  warn: (...args) => write("warn", args),
  error: (...args) => write("error", args),
  dir: (value) => write("info", [inspect(value, 1)]),
  dirxml: (...args) => write("info", args),
  table: (...args) => write("info", args),
  assert: (condition, ...args) => {
    if (!condition) write("error", ["Assertion failed", ...args]);
  },
  count: (label = "default") => {
    const key = String(label);
    const count = (MapPrototypeGet(counts, key) ?? 0) + 1;
    MapPrototypeSet(counts, key, count);
    write("info", [`${key}: ${count}`]);
  },
  countReset: (label = "default") => {
    counts.delete(String(label));
  },
  time: (label = "default") => {
    MapPrototypeSet(timers, String(label), DateNow());
  },
  timeLog: (label = "default", ...args) => {
    const started = MapPrototypeGet(timers, String(label));
    if (started !== undefined) write("info", [`${label}: ${DateNow() - started}ms`, ...args]);
  },
  timeEnd: (label = "default") => {
    const started = MapPrototypeGet(timers, String(label));
    if (started === undefined) return;
    timers.delete(String(label));
    write("info", [`${label}: ${DateNow() - started}ms`]);
  },
  group: (...args) => {
    if (args.length > 0) write("info", args);
    indent += "  ";
  },
  groupCollapsed: (...args) => globalConsole.group(...args),
  groupEnd: () => {
    indent = StringPrototypeSlice(indent, 2);
  },
  clear: () => {},
};

// ---------------------------------------------------------------------------
// The globals, and confining the isolate to them
// ---------------------------------------------------------------------------

const WEB = {
  AbortController,
  AbortSignal,
  DOMException,
  Event,
  EventTarget,
  Headers,
  MessageEvent,
  TextDecoder,
  TextEncoder,
  URL,
  URLSearchParams,
  console: globalConsole,
  structuredClone,
};

for (const [name, value] of ObjectEntries(WEB)) {
  ObjectDefineProperty(globalThis, name, { value, writable: true, configurable: true, enumerable: false });
}

/** What ECMAScript itself puts on the global object, which a script may always reach. */
const ECMASCRIPT = [
  "AggregateError",
  "Array",
  "ArrayBuffer",
  "AsyncDisposableStack",
  "Atomics",
  "BigInt",
  "BigInt64Array",
  "BigUint64Array",
  "Boolean",
  "DataView",
  "Date",
  "DisposableStack",
  "Error",
  "EvalError",
  "FinalizationRegistry",
  "Float16Array",
  "Float32Array",
  "Float64Array",
  "Function",
  "Infinity",
  "Int16Array",
  "Int32Array",
  "Int8Array",
  "Intl",
  "Iterator",
  "JSON",
  "Map",
  "Math",
  "NaN",
  "Number",
  "Object",
  "Promise",
  "Proxy",
  "RangeError",
  "ReferenceError",
  "Reflect",
  "RegExp",
  "Set",
  "SharedArrayBuffer",
  "String",
  "SuppressedError",
  "Symbol",
  "SyntaxError",
  "Temporal",
  "TypeError",
  "URIError",
  "Uint16Array",
  "Uint32Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "WeakMap",
  "WeakRef",
  "WeakSet",
  "decodeURI",
  "decodeURIComponent",
  "encodeURI",
  "encodeURIComponent",
  "escape",
  "eval",
  "globalThis",
  "isFinite",
  "isNaN",
  "parseFloat",
  "parseInt",
  "undefined",
  "unescape",
];

/**
 * Removes every global that is not ECMAScript's, one of the web types above,
 * or one of `keep`, and then itself. The host calls it once, after it has
 * installed what else it gives the isolate.
 */
function confine(keep) {
  const allowed = new SafeSet([...ECMASCRIPT, ...ReflectOwnKeys(WEB), ...keep]);
  for (const key of ReflectOwnKeys(globalThis)) {
    if (typeof key === "string" && !allowed.has(key)) {
      try {
        ReflectDeleteProperty(globalThis, key);
      } catch {
        // A property the engine made permanent stays; none of them is a way out.
      }
    }
  }
}

ObjectDefineProperty(globalThis, "__flotiConfine", { value: confine, configurable: true, enumerable: false });
