/******************************************************************************
Copyright (c) Microsoft Corporation.

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.
***************************************************************************** */
/* global Reflect, Promise, SuppressedError, Symbol, Iterator */


function __classPrivateFieldGet(receiver, state, kind, f) {
    if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a getter");
    if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot read private member from an object whose class did not declare it");
    return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
}

function __classPrivateFieldSet(receiver, state, value, kind, f) {
    if (kind === "m") throw new TypeError("Private method is not writable");
    if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a setter");
    if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot write private member to an object whose class did not declare it");
    return (kind === "a" ? f.call(receiver, value) : f ? f.value = value : state.set(receiver, value)), value;
}

typeof SuppressedError === "function" ? SuppressedError : function (error, suppressed, message) {
    var e = new Error(message);
    return e.name = "SuppressedError", e.error = error, e.suppressed = suppressed, e;
};

// Logger primitives — NoopLogger and ConsoleLogger, re-exported
// from the package root for customer use.
/** Drops every log. Default when the customer doesn't supply one. */
const NoopLogger = {
    debug: () => { },
    info: () => { },
    warn: () => { },
    error: () => { },
};
/**
 * Routes to globalThis.console with level-named methods. Useful in
 * dev; customers should swap in their structured logger for prod.
 */
const ConsoleLogger = {
    debug: (msg, ctx) => {
        // eslint-disable-next-line no-console
        console.debug("[@metered-ca/realtime]", msg, ctx ?? "");
    },
    info: (msg, ctx) => {
        // eslint-disable-next-line no-console
        console.info("[@metered-ca/realtime]", msg, ctx ?? "");
    },
    warn: (msg, ctx) => {
        // eslint-disable-next-line no-console
        console.warn("[@metered-ca/realtime]", msg, ctx ?? "");
    },
    error: (msg, ctx) => {
        // eslint-disable-next-line no-console
        console.error("[@metered-ca/realtime]", msg, ctx ?? "");
    },
};

// Tiny browser-pure event emitter. Replaces the Node `events`
// module so the package stays dependency-free and bundles cleanly
// for the browser without a `events` polyfill (which alone would
// pull in ~3 KB of transitive footprint).
//
// Generic over an event map so handlers are fully typed end-to-end:
//
//   interface MyEvents { foo: { x: number }; bar: string }
//   const e = new EventEmitter<MyEvents>();
//   e.on("foo", (p) => p.x); // p typed as { x: number }
//   e.emit("foo", { x: 1 });
//
// Semantics chosen to match Node's EventEmitter where customer
// expectations are strongest, EXCEPT:
//   - We DON'T support a default "error" event that throws on no
//     listener — the SDK uses typed events and the consumer can
//     decide whether to listen for "error".
//   - We DON'T enforce a maxListeners warning — modern code uses
//     handler refs intentionally and doesn't accumulate.
//
// Listeners are invoked SYNCHRONOUSLY in registration order. A
// throwing listener is caught and forwarded to onListenerError so
// one bad handler doesn't break delivery to the rest.
// Stashes the customer's original handler on a once()-wrapper so that
// off(originalHandler) can unregister it — Node parity. Callers never
// held the wrapper reference, so identity matching alone can't pair.
const ONCE_ORIGINAL = Symbol("once-original");
// EventMap is intentionally unconstrained — interfaces (as opposed
// to type aliases) don't satisfy `Record<string, unknown>` under
// TypeScript's strict-mode reasoning, even though every interface
// field-value is assignable to `unknown` at runtime. Leaving the
// type parameter open lets customers pass a plain interface as
// their event map without ceremonial casts.
class EventEmitter {
    constructor(opts = {}) {
        // Map of event-name → array of handler refs. Array (not Set) so
        // dispatch order is stable in registration order — matches Node.
        this.listeners = new Map();
        // Events for which we've already warned about the listener count
        // crossing the threshold. Cleared per-event when the count drops
        // below the threshold so re-crossing re-warns.
        this.warnedEvents = new Set();
        this.onListenerError =
            opts.onListenerError ??
                ((err, eventName) => {
                    // eslint-disable-next-line no-console
                    console.error(`[@metered-ca/realtime] listener for "${eventName}" threw`, err);
                });
        this.maxListenersWarn = opts.maxListenersWarn ?? 100;
        this.onListenerWarn =
            opts.onListenerWarn ??
                ((msg, ctx) => {
                    // eslint-disable-next-line no-console
                    console.warn(`[@metered-ca/realtime] ${msg}`, ctx);
                });
    }
    on(event, handler) {
        const list = this.listeners.get(event);
        if (list) {
            list.push(handler);
        }
        else {
            this.listeners.set(event, [handler]);
        }
        this.checkListenerCountThreshold(event);
        return this;
    }
    /**
     * Remove a previously-registered handler. Noop if the handler ref
     * isn't currently registered (matches Node's behaviour — silent).
     * Only removes the FIRST matching entry so `on(e, h); on(e, h);`
     * needs two off() calls to fully unregister, again matching Node.
     */
    off(event, handler) {
        const list = this.listeners.get(event);
        if (!list)
            return this;
        // Match direct registrations by identity, AND once()-wrappers by
        // the original handler they wrap (Node parity — `once(e, h)` then
        // `off(e, h)` must unregister).
        const idx = list.findIndex((h) => h === handler ||
            h[ONCE_ORIGINAL] === handler);
        if (idx >= 0)
            list.splice(idx, 1);
        if (list.length === 0)
            this.listeners.delete(event);
        // Drop the warn-fired flag if we're back under the threshold so
        // a future re-crossing re-warns.
        if (list.length < this.maxListenersWarn)
            this.warnedEvents.delete(event);
        return this;
    }
    /**
     * Emit a one-shot warning when an event's listener count crosses
     * the threshold for the first time (or after dropping back below
     * and re-crossing). Customers add listeners in many places —
     * React useEffects, addEventListener-style integrations — so a
     * runaway count usually points at a missing cleanup hook.
     */
    checkListenerCountThreshold(event) {
        if (this.warnedEvents.has(event))
            return;
        const count = this.listeners.get(event)?.length ?? 0;
        if (count < this.maxListenersWarn)
            return;
        this.warnedEvents.add(event);
        this.onListenerWarn(`EventEmitter: listener count for "${String(event)}" reached ${count}`, { event: String(event), count, threshold: this.maxListenersWarn });
    }
    /**
     * Register a one-shot handler. The wrapper auto-removes itself
     * BEFORE invoking the customer's handler, so a handler that
     * re-emits the same event won't infinite-loop (defensive — Node
     * orders the cleanup before invocation for the same reason).
     */
    once(event, handler) {
        const wrapper = (payload) => {
            this.off(event, wrapper);
            handler(payload);
        };
        wrapper[ONCE_ORIGINAL] = handler;
        return this.on(event, wrapper);
    }
    /**
     * Synchronous dispatch in registration order. Snapshots the list
     * first so a handler that calls .off() on itself or another
     * listener during dispatch doesn't trip the iteration.
     */
    emit(event, payload) {
        const list = this.listeners.get(event);
        if (!list || list.length === 0)
            return false;
        // Snapshot — see comment above.
        const snapshot = list.slice();
        for (const handler of snapshot) {
            try {
                handler(payload);
            }
            catch (err) {
                this.onListenerError(err, String(event));
            }
        }
        return true;
    }
    /** Test / introspection helper. */
    listenerCount(event) {
        return this.listeners.get(event)?.length ?? 0;
    }
    /** Remove every handler for every event. */
    removeAllListeners() {
        this.listeners.clear();
        this.warnedEvents.clear();
        return this;
    }
}

// URL builder + base-URL validator. Centralized so the query-param
// shape matches the server byte-for-byte (`?token=` for sk_-minted
// JWTs, `?key=` for pk_ keys) and customers don't have to remember
// which param goes with which credential type.
// Canonical production host — Metered's Realtime Messaging endpoint.
const DEFAULT_URL = "wss://rms.metered.ca";
const WS_PATH = "/v1";
/**
 * Validate a customer-supplied base URL. Runs at SignallingClient
 * construction, so misconfigurations surface immediately instead of
 * mid-connect with a confusing close code.
 *
 * Rules:
 *   - Must parse as a URL (TypeError otherwise)
 *   - Protocol MUST be wss: — except plaintext ws: is allowed for
 *     localhost / 127.0.0.1 / ::1 (dev convenience; never accept
 *     plaintext over the network because the credential is in the
 *     query string)
 *   - Pathname MUST be "/" — the SDK appends "/v1" itself. A
 *     customer typo like `wss://host/foo` would otherwise silently
 *     become `wss://host/foo/v1?...` and confuse server-side path
 *     routing.
 *   - No trailing slash distinction — both "wss://host" and
 *     "wss://host/" normalize to the same canonical form.
 *
 * Returns the normalized origin (no trailing slash, no pathname).
 */
function validateBaseUrl(baseUrl) {
    let parsed;
    try {
        parsed = new URL(baseUrl);
    }
    catch {
        throw new TypeError(`SignallingClient: invalid 'url' option — '${baseUrl}' is not a parseable URL`);
    }
    const isLocalhost = parsed.hostname === "localhost" ||
        parsed.hostname === "127.0.0.1" ||
        parsed.hostname === "[::1]" ||
        parsed.hostname === "::1";
    if (parsed.protocol === "ws:") {
        if (!isLocalhost) {
            throw new TypeError(`SignallingClient: insecure 'ws:' is only allowed for localhost — got '${baseUrl}'. Use 'wss:' in production; the credential travels in the URL query string and plaintext WebSocket exposes it on the wire.`);
        }
    }
    else if (parsed.protocol !== "wss:") {
        throw new TypeError(`SignallingClient: 'url' protocol must be 'wss:' (or 'ws:' for localhost) — got '${parsed.protocol}'`);
    }
    // Pathname normalization. The URL parser returns "/" for inputs
    // like "wss://host" AND "wss://host/", so the distinction we
    // care about is whether anything was put BETWEEN the origin and
    // a trailing slash.
    if (parsed.pathname !== "/" && parsed.pathname !== "") {
        throw new TypeError(`SignallingClient: 'url' must not include a path — got '${parsed.pathname}'. the SDK appends the '/v1' path itself.`);
    }
    if (parsed.search.length > 0 || parsed.hash.length > 0) {
        throw new TypeError(`SignallingClient: 'url' must not include query / hash — got '${baseUrl}'`);
    }
    // origin includes scheme://host:port without trailing slash.
    return parsed.origin;
}
/**
 * Build the final connect URL. `baseOrigin` must already be a
 * validated origin from validateBaseUrl (or the default constant).
 */
function buildConnectUrl(baseOrigin, cred) {
    const param = cred.kind === "apiKey" ? "key" : "token";
    return `${baseOrigin}${WS_PATH}?${param}=${encodeURIComponent(cred.value)}`;
}

// Credential isolation. The customer's apiKey OR JWT-via-tokenProvider
// MUST stay off enumerable instance properties — otherwise
// `JSON.stringify(client)` (Sentry breadcrumbs, console.dir,
// React-DevTools-style snapshots) emits the credential into logs /
// telemetry.
//
// Two-layer defense:
//   1. A `CredentialStore` class holds the source in an ES private
//      field (`#source`) — not enumerable, not visible via
//      JSON.stringify, not reachable via property access from outside
//      the class.
//   2. `resolve()` is the ONLY public method; it returns the
//      ready-to-send credential and never exposes the underlying
//      provider function or stored apiKey to the caller.
//
// The class also wraps the customer's tokenProvider with a timeout
// so a hanging mint endpoint doesn't hang connect() forever — but
// that lives in signalling-client; here we only own the
// "isolate the secret" job.
var _CredentialStore_source;
class CredentialStore {
    constructor(source) {
        // ES private fields (#) are NOT enumerable own properties and are
        // unreachable from outside the class — even via bracket notation
        // with type casts. TypeScript's `private` keyword alone is erased
        // at compile time and the property remains visible to
        // JSON.stringify.
        _CredentialStore_source.set(this, void 0);
        __classPrivateFieldSet(this, _CredentialStore_source, source, "f");
    }
    static fromApiKey(apiKey) {
        return new CredentialStore({ kind: "apiKey", value: apiKey });
    }
    static fromTokenProvider(provider) {
        return new CredentialStore({ kind: "tokenProvider", provider });
    }
    /** Tells the SignallingClient whether to apply a tokenProvider timeout. */
    get isTokenProvider() {
        return __classPrivateFieldGet(this, _CredentialStore_source, "f").kind === "tokenProvider";
    }
    /**
     * Sync resolution for the apiKey path. Returns the credential or
     * null if this store holds a tokenProvider — caller must then use
     * resolveToken().
     *
     * Split into sync/async paths so the apiKey case doesn't gratuitously
     * yield a microtask before opening the socket — tests + integrations
     * rely on the socket being created in the same task as connect().
     */
    resolveSync() {
        if (__classPrivateFieldGet(this, _CredentialStore_source, "f").kind === "apiKey") {
            return { kind: "apiKey", value: __classPrivateFieldGet(this, _CredentialStore_source, "f").value };
        }
        return null;
    }
    /**
     * Async resolution for the tokenProvider path. Invokes the
     * customer's function and awaits it. The CALLER (signalling-client)
     * wraps this in a Promise.race-with-timeout so a hanging mint
     * endpoint can't hang connect() forever.
     *
     * Throws if called against an apiKey store — that path uses
     * resolveSync().
     */
    async resolveToken() {
        if (__classPrivateFieldGet(this, _CredentialStore_source, "f").kind !== "tokenProvider") {
            throw new Error("CredentialStore.resolveToken: not a tokenProvider — use resolveSync()");
        }
        const token = await __classPrivateFieldGet(this, _CredentialStore_source, "f").provider();
        if (typeof token !== "string" || token.length === 0) {
            throw new Error("tokenProvider returned an empty token");
        }
        return { kind: "token", value: token };
    }
    /**
     * Custom JSON marshal — never leaks the credential. If Sentry /
     * console.dir / structuredClone tries to serialize a SignallingClient,
     * the embedded CredentialStore looks like `{}`. Belt-and-braces on
     * top of the private-field isolation.
     */
    toJSON() {
        return {};
    }
}
_CredentialStore_source = new WeakMap();

// Credential scrubbers for log/error surfaces.
//
// WHY: When the SDK emits an error caused by an upstream throw
// (Node's `ws` library rejecting a malformed URL, fetch failing on
// the customer's token endpoint), the underlying error's message
// frequently contains the full URL — including `?token=…` or
// `?key=…`. If the customer's `.catch(e => Sentry.captureException(e))`
// fires, the credential lands in error-monitoring forever.
//
// We don't trust callers to remember to scrub; the scrubbing happens
// at every public-surface error emission inside the SDK.
const SECRET_QUERY_PARAMS = ["token", "key"];
/**
 * SDP attribute fields that carry TURN/ICE secrets. libwebrtc and
 * Chromium's SDP parser interpolate offending source lines into
 * parse-error messages — so an Error whose message contains
 * "Failed to parse a=ice-pwd:SECRET..." can land in a customer's
 * Sentry/Datadog if they wire `.on('negotiation-error', e => report(e.err))`.
 *
 * The patterns match SDP-style `field:value` AND URL/JSON-style
 * `field=value`, anchored on field-name boundaries so a substring
 * like "credential" inside a longer identifier doesn't get clobbered.
 * Value is greedy up to the next whitespace / quote / comma / semicolon
 * — covers real-world error-message shapes without over-scrubbing.
 */
const SDP_SECRET_FIELDS = ["ice-pwd", "ice-ufrag", "credential"];
/**
 * Replace `?token=…` / `&key=…` query-param values in any string
 * with `<param>=***`. Idempotent and safe to call on strings that
 * don't contain a URL.
 */
function scrubCredentialQueryParams(text) {
    let out = text;
    for (const p of SECRET_QUERY_PARAMS) {
        // Anchor on both `?param=` and `&param=`; match up to the next
        // `&` or end-of-string. Tolerant of percent-encoding because the
        // scrub is text-level, not URL-level.
        const re = new RegExp(`([?&])${p}=[^&\\s"']*`, "g");
        out = out.replace(re, `$1${p}=***`);
    }
    return out;
}
/**
 * Replace SDP credential attributes like `a=ice-pwd:VAL` or
 * `credential=VAL` (URL-style) with `<field>:***`. Catches both `:`
 * and `=` separators with optional surrounding whitespace, and stops
 * at the next whitespace / quote / comma / semicolon. Idempotent.
 *
 * Necessary on top of `scrubCredentialQueryParams` because WebRTC
 * error messages don't go through URL query-param shapes — they
 * interpolate SDP attribute lines directly.
 */
function scrubSdpCredentials(text) {
    let out = text;
    for (const f of SDP_SECRET_FIELDS) {
        // Field name as a whole word: preceded by start-of-string or a
        // non-identifier character (so `usernameFragment` doesn't get
        // matched by `credential`). Value matches three shapes:
        //   "quoted"  — JSON-stringified error
        //   'quoted'  — alternate quoting
        //   bare      — SDP-style `field:value` until whitespace/comma/semicolon
        // The whole match (including quotes) is replaced with `field:***`.
        const re = new RegExp(`(^|[^A-Za-z0-9_-])(${f})\\s*[:=]\\s*(?:"[^"]*"|'[^']*'|[^\\s,;]+)`, "gi");
        out = out.replace(re, `$1$2:***`);
    }
    return out;
}
/**
 * Wrap an error so its `.message` / `.stack` has any embedded
 * credential scrubbed. Returns a new Error (not a mutation) so the
 * original prototype chain (e.g. `SyntaxError` from `new URL()`) is
 * preserved on the cause field for debug purposes.
 *
 * If the input isn't an Error, coerce safely without leaking the
 * raw value when it might be a serialized credential.
 *
 * Applies BOTH the query-param scrub (token/key in URLs) and the
 * SDP-field scrub (ice-pwd / ice-ufrag / credential in SDP errors)
 * — both layers are cheap, and a single emission site might carry
 * either shape depending on which underlying throw bubbled up.
 */
function scrubError(err) {
    const scrub = (s) => scrubSdpCredentials(scrubCredentialQueryParams(s));
    if (err instanceof Error) {
        const scrubbed = new Error(scrub(err.message));
        scrubbed.name = err.name;
        // Stack frames may also contain the URL (e.g. when the throw
        // came from a templated error builder). Scrub if present.
        if (typeof err.stack === "string") {
            scrubbed.stack = scrub(err.stack);
        }
        return scrubbed;
    }
    return new Error(scrub(String(err)));
}

// UTF-8 byte length without a hard dependency on a global TextEncoder.
//
// The SDK pre-checks outbound payload sizes (the MeteredPeer.send size
// cap and the DataChannel backpressure accounting) by measuring the
// UTF-8 byte length of a string. The obvious
// `new TextEncoder().encode(s).length` THROWS on JavaScript runtimes
// that don't expose a global TextEncoder — notably some React Native /
// Hermes versions — which would surface as a crash on the first send()
// rather than degrading gracefully.
//
// This helper uses TextEncoder when present (browsers, Node, modern
// Hermes — the fast path) and otherwise counts UTF-8 widths directly.
// A lone surrogate is counted as 3 bytes, matching what TextEncoder
// emits for it (the U+FFFD replacement char), so the byte total is
// identical across both paths for size-cap purposes. Stays browser-pure
// (no Node Buffer) and adds no dependencies — preserving the zero-dep +
// bundle-size invariants.
// Cached so the fast path doesn't allocate a TextEncoder per call.
let cachedEncoder;
function utf8ByteLength(s) {
    if (typeof TextEncoder !== "undefined") {
        if (cachedEncoder === undefined)
            cachedEncoder = new TextEncoder();
        return cachedEncoder.encode(s).length;
    }
    let bytes = 0;
    for (let i = 0; i < s.length; i++) {
        const code = s.charCodeAt(i);
        if (code < 0x80) {
            bytes += 1;
        }
        else if (code < 0x800) {
            bytes += 2;
        }
        else if (code >= 0xd800 &&
            code <= 0xdbff &&
            i + 1 < s.length &&
            s.charCodeAt(i + 1) >= 0xdc00 &&
            s.charCodeAt(i + 1) <= 0xdfff) {
            // Valid surrogate pair → one 4-byte code point; skip the low half.
            bytes += 4;
            i++;
        }
        else {
            // BMP char, or a lone surrogate (TextEncoder emits U+FFFD = 3 bytes).
            bytes += 3;
        }
    }
    return bytes;
}

// Extract TURN credentials from `welcome.metadata.iceServers`.
//
// By design, the wire protocol does NOT carry a top-level iceServers
// field — `metadata` is an opaque JSON pass-through, and customers
// nest TURN configs under `metadata.iceServers` by convention. The SDK is the consumer
// agreed to that convention; this helper is the read path.
//
// Defensive: any malformed shape returns undefined rather than
// throwing, so a misconfigured customer JWT can't take down the
// connection. The customer's UI just gets no TURN creds and falls
// back to STUN-only / host candidates.
//
// Defense-in-depth validation:
// even though RTCPeerConnection rejects non-stun/turn schemes at
// construction, the SDK still emits the iceServers array on the
// `connected` event — a customer dashboard rendering `urls` into
// DOM/href without sanitization would be XSS-exposed to a hostile
// sk_ key. We enforce the scheme allowlist + per-field byte caps
// before surfacing the value so the data is safe by the time it
// leaves this module.
/**
 * The four IANA-registered ICE URL schemes. Matched case-insensitively
 * — `STUN:` and `stun:` are both legal per the RFC.
 *
 * Anything else (`javascript:`, `http:`, `file:`, `data:`, …) is
 * rejected. RTCPeerConnection itself would also reject them at
 * construction; this is the SDK's first line of defense so the bad
 * URL never reaches a customer's UI render path.
 */
const ALLOWED_ICE_SCHEMES = /^(stuns?|turns?):/i;
/**
 * Per-field byte caps. Generous against real-world TURN configs but
 * tight enough that a hostile sk_ key can't smuggle multi-megabyte
 * blobs through to crash the customer's UI parser.
 *
 *   urls:       512 chars per URL — TURN URLs are typically <120
 *   username:   1024 — TURN usernames embed timestamps + signatures
 *   credential: 1024 — HMAC-SHA1 base64 fits in well under this
 *
 * Total iceServer ENTRIES capped at 16: real customers ship 1–5
 * TURN endpoints; 16 leaves headroom without enabling an entry-count
 * DoS.
 */
const MAX_URL_LEN = 512;
const MAX_USERNAME_LEN = 1024;
const MAX_CREDENTIAL_LEN = 1024;
const MAX_ENTRIES = 16;
function isString$1(v) {
    return typeof v === "string";
}
function isRecord$1(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}
/**
 * Walks the welcome's `metadata` JSON looking for the conventional
 * `iceServers` array. Returns undefined on ANY validation failure —
 * fail-closed semantics: a partially-poisoned iceServers list is
 * indistinguishable from a fully-poisoned one from the customer's
 * perspective, so the SDK falls back to STUN-only / host candidates
 * rather than silently dropping just the bad entries.
 *
 * Rejections:
 *   - metadata absent / non-object
 *   - metadata.iceServers absent / non-array
 *   - > MAX_ENTRIES entries
 *   - entry has non-string-or-string-array `urls`
 *   - any URL fails the scheme allowlist (stun/stuns/turn/turns)
 *   - any URL longer than MAX_URL_LEN
 *   - username or credential present but longer than its cap
 *
 * Non-string username / credential fields on otherwise-valid entries
 * are silently dropped (the entry stays, just without those fields).
 * That mirrors what real RTCPeerConnection would do.
 */
function extractIceServersFromMetadata(metadata) {
    if (!isRecord$1(metadata))
        return undefined;
    const raw = metadata.iceServers;
    if (!Array.isArray(raw))
        return undefined;
    if (raw.length > MAX_ENTRIES)
        return undefined;
    const out = [];
    for (const entry of raw) {
        if (!isRecord$1(entry))
            return undefined;
        const urls = entry.urls;
        if (!isValidUrlsField(urls))
            return undefined;
        const item = { urls: urls };
        if (isString$1(entry.username)) {
            if (entry.username.length > MAX_USERNAME_LEN)
                return undefined;
            item.username = entry.username;
        }
        if (isString$1(entry.credential)) {
            if (entry.credential.length > MAX_CREDENTIAL_LEN)
                return undefined;
            item.credential = entry.credential;
        }
        out.push(item);
    }
    return out;
}
/**
 * Validate the `urls` field shape (string OR string-array) AND every
 * member's scheme + length. Returns true iff every URL passes.
 */
function isValidUrlsField(v) {
    if (isString$1(v))
        return isAllowedIceUrl(v);
    if (!Array.isArray(v))
        return false;
    // Reject empty arrays — a `urls: []` entry is meaningless and a
    // plausible smuggle vector for "appears valid but unusable".
    if (v.length === 0)
        return false;
    return v.every((u) => isString$1(u) && isAllowedIceUrl(u));
}
function isAllowedIceUrl(url) {
    if (url.length === 0 || url.length > MAX_URL_LEN)
        return false;
    return ALLOWED_ICE_SCHEMES.test(url);
}

function isRecord(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}
function isString(v) {
    return typeof v === "string";
}
function isNumber(v) {
    return typeof v === "number" && Number.isFinite(v);
}
function malformed(reason, raw) {
    return { type: "_malformed", reason, raw };
}
function parsePresencePeers(v) {
    if (!Array.isArray(v))
        return null;
    const out = [];
    for (const entry of v) {
        if (!isRecord(entry))
            return null;
        if (!isString(entry.peerId))
            return null;
        const peer = { peerId: entry.peerId };
        if (isRecord(entry.metadata))
            peer.metadata = entry.metadata;
        out.push(peer);
    }
    return out;
}
function parseServerFrame(raw) {
    let env;
    try {
        env = JSON.parse(raw);
    }
    catch {
        return malformed("invalid JSON");
    }
    if (!isRecord(env))
        return malformed("envelope must be an object");
    const type = env.type;
    if (!isString(type))
        return malformed("missing or non-string type");
    switch (type) {
        case "welcome": {
            if (!isString(env.peerId))
                return malformed("welcome.peerId missing", env);
            const expRaw = env.expiresAt;
            if (expRaw !== null && !isNumber(expRaw)) {
                return malformed("welcome.expiresAt must be number or null", env);
            }
            if (!isNumber(env.serverTime))
                return malformed("welcome.serverTime missing", env);
            if (!isNumber(env.maxMessageSize)) {
                return malformed("welcome.maxMessageSize missing", env);
            }
            const payload = {
                peerId: env.peerId,
                expiresAt: expRaw === null ? null : expRaw,
                serverTime: env.serverTime,
                maxMessageSize: env.maxMessageSize,
            };
            if (isRecord(env.metadata))
                payload.metadata = env.metadata;
            return { type: "welcome", payload };
        }
        case "ack": {
            if (!isString(env.requestId))
                return malformed("ack.requestId missing", env);
            return { type: "ack", requestId: env.requestId };
        }
        case "error": {
            if (!isString(env.code) || env.code.length === 0) {
                return malformed("error.code missing", env);
            }
            // Codes outside the known ErrorCode union are accepted, not
            // rejected: a NEWER server's error code must still reject its
            // correlated pending request immediately — dropping the frame
            // here used to leave the customer's subscribe/publish/send
            // hanging until the generic ack timeout, turning every new
            // server code into a client regression.
            const payload = { code: env.code };
            if (isString(env.requestId))
                payload.requestId = env.requestId;
            if (isString(env.message))
                payload.message = env.message;
            return { type: "error", payload };
        }
        case "message": {
            if (!isString(env.channel))
                return malformed("message.channel missing", env);
            if (!isString(env.from))
                return malformed("message.from missing", env);
            if (!("data" in env))
                return malformed("message.data missing", env);
            const payload = {
                channel: env.channel,
                from: env.from,
                data: env.data,
            };
            if (isRecord(env.fromMetadata))
                payload.fromMetadata = env.fromMetadata;
            return { type: "message", payload };
        }
        case "direct": {
            if (!isString(env.from))
                return malformed("direct.from missing", env);
            if (!("data" in env))
                return malformed("direct.data missing", env);
            const payload = {
                from: env.from,
                data: env.data,
            };
            if (isRecord(env.fromMetadata))
                payload.fromMetadata = env.fromMetadata;
            return { type: "direct", payload };
        }
        case "presence": {
            if (!isString(env.channel))
                return malformed("presence.channel missing", env);
            const joined = parsePresencePeers(env.joined);
            const left = parsePresencePeers(env.left);
            if (joined === null)
                return malformed("presence.joined invalid", env);
            if (left === null)
                return malformed("presence.left invalid", env);
            return { type: "presence", payload: { channel: env.channel, joined, left } };
        }
        case "going_away": {
            // retryAfterMs is advisory; default to 1000 if missing or
            // bogus so customers always have a usable number to gate
            // their reconnect against.
            const retry = isNumber(env.retryAfterMs) && env.retryAfterMs > 0
                ? env.retryAfterMs
                : 1000;
            return { type: "going_away", payload: { retryAfterMs: retry } };
        }
        case "pong":
            return { type: "pong" };
        default:
            return malformed(`unknown type: ${type}`, env);
    }
}

// Outbound (client → server) frame builders. Each returns the
// stringified JSON the customer's WebSocket sends. Centralizing them
// here means the wire format lives in one place — the SignallingClient
// doesn't need to know JSON structure, only what fields to pass.
//
// The server-side protocol parser is strict: missing fields →
// invalid_channel / missing_data / invalid_peer_id errors. We do a
// lightweight client-side check so failures surface as TypeError on
// the customer's call site rather than as an `error` frame from the
// server 50ms later — much better debugging UX.
/** Hard cap matching the server's MAX_REQUEST_ID_LENGTH (128 chars). */
const MAX_REQUEST_ID_LENGTH = 128;
/** Hard cap matching the server's MAX_CHANNEL_LENGTH. */
const MAX_CHANNEL_LENGTH = 256;
/** Hard cap matching the server's MAX_PEER_ID_LENGTH. */
const MAX_PEER_ID_LENGTH = 128;
// Control-char check matching the server. Rejects U+0000–U+001F,
// U+007F, U+0080–U+009F. Kept in lockstep with the server's
// hasControlChars() check.
function hasControlChars(s) {
    for (let i = 0; i < s.length; i++) {
        const code = s.charCodeAt(i);
        if (code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
            return true;
        }
    }
    return false;
}
// Exported for the SignallingClient, which validates a channel BEFORE
// adding it to the auto-resubscribe tracking set (a garbage name must
// never be replayed on reconnects).
function validateChannel(channel) {
    if (typeof channel !== "string" || channel.length === 0) {
        throw new TypeError("channel must be a non-empty string");
    }
    if (channel.length > MAX_CHANNEL_LENGTH) {
        throw new TypeError(`channel exceeds ${MAX_CHANNEL_LENGTH}-char cap (got ${channel.length})`);
    }
    if (hasControlChars(channel)) {
        throw new TypeError("channel contains control characters");
    }
}
function validatePeerId(peerId) {
    if (typeof peerId !== "string" || peerId.length === 0) {
        throw new TypeError("peerId must be a non-empty string");
    }
    if (peerId.length > MAX_PEER_ID_LENGTH) {
        throw new TypeError(`peerId exceeds ${MAX_PEER_ID_LENGTH}-char cap (got ${peerId.length})`);
    }
    if (hasControlChars(peerId)) {
        throw new TypeError("peerId contains control characters");
    }
}
function validateRequestId(requestId) {
    if (requestId === undefined)
        return;
    if (typeof requestId !== "string" || requestId.length === 0) {
        throw new TypeError("requestId must be a non-empty string when provided");
    }
    if (requestId.length > MAX_REQUEST_ID_LENGTH) {
        throw new TypeError(`requestId exceeds ${MAX_REQUEST_ID_LENGTH}-char cap (got ${requestId.length})`);
    }
}
function buildSubscribe(channel, opts = {}) {
    validateChannel(channel);
    validateRequestId(opts.requestId);
    // The server happily ignores extra fields, but we omit defaults so
    // the wire footprint stays minimal and so tests can assert exact
    // payloads without coupling to default boilerplate.
    const frame = { type: "subscribe", channel };
    if (opts.requestId !== undefined)
        frame.requestId = opts.requestId;
    if (opts.includeSenderMetadata)
        frame.includeSenderMetadata = true;
    return JSON.stringify(frame);
}
function buildUnsubscribe(channel, opts = {}) {
    validateChannel(channel);
    validateRequestId(opts.requestId);
    const frame = { type: "unsubscribe", channel };
    if (opts.requestId !== undefined)
        frame.requestId = opts.requestId;
    return JSON.stringify(frame);
}
function buildPublish(channel, data, opts = {}) {
    validateChannel(channel);
    validateRequestId(opts.requestId);
    // `data === undefined` is rejected by the server with missing_data.
    // The client surface accepts `unknown`, but `undefined` would
    // serialize to a missing field on the wire (JSON drops it). Catch
    // here so the failure is local.
    if (data === undefined) {
        throw new TypeError("publish data must not be undefined");
    }
    const frame = { type: "publish", channel, data };
    if (opts.requestId !== undefined)
        frame.requestId = opts.requestId;
    return JSON.stringify(frame);
}
function buildSend(toPeerId, data, opts = {}) {
    validatePeerId(toPeerId);
    validateRequestId(opts.requestId);
    if (data === undefined) {
        throw new TypeError("send data must not be undefined");
    }
    const frame = { type: "send", to: toPeerId, data };
    if (opts.requestId !== undefined)
        frame.requestId = opts.requestId;
    return JSON.stringify(frame);
}
/** Heartbeat ping (fire-and-forget; no requestId). Server replies pong. */
function buildPing() {
    return JSON.stringify({ type: "ping" });
}
/**
 * Generate a request-id for ack correlation. RFC 4122 v4 via
 * crypto.randomUUID() where available; fallback to a 22-char
 * base36 random string otherwise (some embedded WebView contexts
 * lack crypto.randomUUID).
 *
 * Length stays well under the 128-char server cap regardless of
 * path so we never hit MAX_REQUEST_ID_LENGTH.
 */
function generateRequestId() {
    const c = globalThis.crypto;
    if (c && typeof c.randomUUID === "function") {
        return c.randomUUID();
    }
    // 16 bytes of randomness → 22 base36 chars after BigInt conversion.
    // Math.random isn't crypto-secure but requestIds aren't a security
    // boundary (the server's auth is); we just need uniqueness within
    // a single client session.
    return (Math.random().toString(36).slice(2) +
        Math.random().toString(36).slice(2)).slice(0, 22);
}

// SignallingClient implementation (internal).
//
// Lifecycle:
//   idle → (connect) → connecting → connected ←→ reconnecting → closed
//
// Reconnection is built in — the state machine handles auto-reconnect
// with exponential backoff + jitter when reconnect: ReconnectOptions
// is passed (default), or one-shot connect-until-close when
// reconnect: false.
//
// Ack correlation: each subscribe/unsubscribe/publish/send call
// generates a requestId, registers a resolver in pendingAcks, sends
// the frame, and the inbound `ack` / `error` frame handler resolves
// or rejects the pending promise. Requests without an explicit
// requestId still get one auto-generated — otherwise the server
// won't ack and the promise never resolves.
var _SignallingClientImpl_credential;
// Server's documented welcome timeout. If we don't see a welcome
// frame within this window, the connection is wedged — reject the
// connect() promise so callers can retry or alert.
const WELCOME_TIMEOUT_MS = 10000;
// Default outbound-ack timeout. If the server doesn't ack a
// subscribe/publish/send within this window, reject the promise so
// the caller can retry. Far longer than typical p99 (single-digit
// ms) — only fires when the connection is silently dropping frames
// (TCP/intermediate-proxy weirdness).
const DEFAULT_ACK_TIMEOUT_MS = 15000;
// Default inactivity timeout. Server pings every 30s; if no frame
// arrives within 60s the connection is presumed dead and we close +
// reconnect. Browser WS can't send ping frames so this is the only
// client-side liveness signal we have.
const DEFAULT_INACTIVITY_TIMEOUT_MS = 60000;
// Default reconnection knobs. Exponential backoff with jitter,
// capped at 30s — same shape as the standard ws/exponential-backoff
// recipe and matching what the server's TCP keepalive expects from
// well-behaved clients. maxAttempts capped at 100 so a permanently-
// broken auth path doesn't spin forever without the customer seeing
// a definite stop signal (~50 minutes of trying with this curve).
const DEFAULT_RECONNECT = {
    initialDelayMs: 500,
    multiplier: 2,
    maxDelayMs: 30000,
    jitterRatio: 0.2,
    maxAttempts: 100,
};
// Default timeout for tokenProvider() calls — prevents a hanging
// customer mint endpoint from pinning connect() forever.
const DEFAULT_TOKEN_PROVIDER_TIMEOUT_MS = 10000;
// Cap on how long close() will wait for the underlying socket's
// 'close' event before returning anyway. Long enough for the TCP
// FIN/ACK round-trip on a healthy link; short enough that a wedged
// transport doesn't pin `process.exit` after `await client.close()`.
const CLOSE_FLUSH_TIMEOUT_MS = 1000;
// Hard cap on inbound text frame size. Larger frames are dropped and
// the connection closed with 1009 (MessageTooBig). The server's
// welcome currently advertises 64 KB but customers may push larger
// payloads through publish/send; the cap here is generous to avoid
// breaking real customer use, just tight enough to prevent a
// compromised server from OOMing the client with a giant frame.
const MAX_INBOUND_FRAME_BYTES = 1048576; // 1 MB
// Emit "token-provider-error" after this many consecutive token
// resolution failures. Surfaces a customer-actionable signal
// (refresh login, fix mint endpoint) before the reconnect loop
// hits maxAttempts and gives up silently.
const TOKEN_PROVIDER_FAILURE_EVENT_THRESHOLD = 3;
// Close codes that should NOT trigger automatic reconnection.
// These are caller-action-required failures — reconnecting wouldn't
// help and would just waste attempts before maxAttempts kicks in.
//   4001 InvalidToken — credentials are wrong; reconnect won't fix
//   4003 ChannelNotAuthorized — JWT claim mismatch; needs new token
//   4012 AccountSuspended — billing-side; reconnect won't fix
//   4020 AdminDisconnect — backend kicked this peer intentionally
//
// 4002 TokenExpired deliberately NOT terminal: the client uses
// `tokenProvider` to mint a fresh JWT on the next connect attempt,
// so a backoff-and-retry can recover. Customers using `apiKey` who
// somehow see 4002 will retry futilely until maxAttempts.
const TERMINAL_CLOSE_CODES = new Set([4001, 4003, 4012, 4020]);
// Bounded retry for resubscribe replays. A replayed subscribe can be
// rejected by the server (transient authorization hiccup, rate
// pressure at reconnect time) or lose its ack; without a retry the
// subscription is silently dead until the NEXT reconnect — the exact
// failure mode autoResubscribe exists to prevent. Retries are
// per-channel, per-connection (the budget resets on every welcome),
// and bounded so a permanently-rejecting channel doesn't spin.
const SUBSCRIBE_REPLAY_MAX_RETRIES = 3;
const SUBSCRIBE_REPLAY_RETRY_DELAY_MS = 2000;
// Close codes that imply "you're over capacity; don't retry quickly
// — give the bottleneck time to clear." 4010 (OverConcurrentLimit)
// means the customer is at their plan max; reconnecting in 500ms
// would just hit the same wall. Force the delay to at least
// SLOW_BACKOFF_FLOOR_MS regardless of where in the exponential curve
// we currently are.
//
// 4011 (OverMessageRate) is per-connection — a NEW connection has a
// fresh token bucket, so normal exponential backoff is fine; it
// stays out of this set.
const SLOW_BACKOFF_CLOSE_CODES = new Set([4010]);
const SLOW_BACKOFF_FLOOR_MS = 30000;
/**
 * Validate resolved reconnect knobs at construction. Garbage values
 * don't fail loudly on their own — `multiplier: 0` or a NaN delay
 * produces `setTimeout(NaN)` / 0 ms delays, i.e. a hot reconnect loop
 * hammering the server — so reject them here, where the stack trace
 * points at the customer's config.
 */
function validateReconnectOptions(o) {
    const finite = (v) => typeof v === "number" && Number.isFinite(v);
    if (!finite(o.initialDelayMs) || o.initialDelayMs < 0) {
        throw new TypeError("SignallingClient: reconnect.initialDelayMs must be a finite number >= 0");
    }
    if (!finite(o.multiplier) || o.multiplier < 1) {
        throw new TypeError("SignallingClient: reconnect.multiplier must be a finite number >= 1 (use 1 for a constant delay)");
    }
    if (!finite(o.maxDelayMs) || o.maxDelayMs < 0) {
        throw new TypeError("SignallingClient: reconnect.maxDelayMs must be a finite number >= 0");
    }
    if (!finite(o.jitterRatio) || o.jitterRatio < 0 || o.jitterRatio > 1) {
        throw new TypeError("SignallingClient: reconnect.jitterRatio must be a finite number between 0 and 1");
    }
    if (o.maxAttempts !== Infinity &&
        (!Number.isInteger(o.maxAttempts) || o.maxAttempts < 1)) {
        throw new TypeError("SignallingClient: reconnect.maxAttempts must be a positive integer or Infinity");
    }
}
/**
 * Error thrown when the server closes the connection with a 4xxx
 * close code (auth failure, quota exceeded, admin kick). The
 * `closeCode` field lets customers branch on the specific reason.
 *
 * `message` is a fixed string that NEVER interpolates server-supplied
 * `reason` text — a malicious server could otherwise stuff control
 * characters or HTML-ish content into a customer's
 * `console.error(err.message)` output, or into a UI surface that
 * renders `error.message`. The full server reason is available as
 * the `closeReason` field for customers who explicitly need it.
 */
class SignallingConnectError extends Error {
    constructor(closeCode, closeReason) {
        super(`signalling connection closed before welcome (closeCode=${closeCode})`);
        this.name = "SignallingConnectError";
        this.closeCode = closeCode;
        this.closeReason = closeReason;
    }
}
// Pre-welcome fallback for the outbound size check — matches the
// server's documented default cap. Sends are state-gated to
// "connected" (where the welcome has already advertised the real
// cap), so this only covers exotic call orders; keeping it equal to
// the server default avoids false-positive rejections either way.
const DEFAULT_MAX_MESSAGE_SIZE = 65536;
/**
 * Thrown by `publish()` / `send()` when the JSON-serialized payload
 * exceeds the server's per-message cap (advertised on the `connected`
 * event as `maxMessageSize`). Rejecting client-side keeps the
 * connection alive — an oversized frame reaching the server would
 * close the socket with code 1009 and take every subscription down
 * with it. Branch on `instanceof` or `err.name ===
 * "OversizedPayloadError"`; the `size` / `cap` fields carry the
 * measured payload size and the active limit in bytes.
 */
class OversizedPayloadError extends Error {
    constructor(size, cap) {
        super(`payload ${size} bytes exceeds server cap ${cap} bytes`);
        this.name = "OversizedPayloadError";
        this.size = size;
        this.cap = cap;
    }
}
class SignallingClientImpl {
    constructor(opts) {
        this._state = "idle";
        this.socket = null;
        // Credential lives behind an ES private field inside CredentialStore
        // — not enumerable, not visible via JSON.stringify, not reachable
        // by external property access. Critical for keeping the customer's
        // apiKey/JWT out of Sentry breadcrumbs / console.dir snapshots.
        // See src/internal/credential.ts for the isolation contract.
        _SignallingClientImpl_credential.set(this, void 0);
        // Pending ack registry — keyed by requestId. Survives only the
        // duration of the current WS connection; cleared on close (each
        // pending request rejects with a "disconnected" error so callers
        // don't hang).
        this.pendingAcks = new Map();
        // Welcome resolver — set during connect(), cleared on first
        // welcome frame OR on connect error.
        this.welcomeResolver = null;
        // Inactivity watchdog — closes the connection if no inbound frame
        // arrives within inactivityTimeoutMs. The app-level heartbeat below
        // keeps it fed on an otherwise-idle connection by triggering a
        // server `pong` reply we can actually observe in JS.
        this.inactivityTimer = null;
        // App-level keepalive — re-armed on every inbound frame and by the
        // timer itself after firing, so it suppresses naturally when there's
        // real traffic and probes when there isn't. See armHeartbeatTimer.
        this.heartbeatTimer = null;
        // Set when the customer calls close() so reconnection knows not
        // to fire. Set on a terminal 4xxx close code too — auth failures
        // and quota rejections aren't transient.
        this.explicitlyClosed = false;
        // Attempt counter — incremented BEFORE each open attempt, reset
        // to 0 on successful welcome. Drives the exponential backoff.
        this.reconnectAttempts = 0;
        // Active reconnect timer — non-null while we're waiting to retry.
        // close() clears this so an explicit close cancels a scheduled
        // attempt.
        this.reconnectTimer = null;
        // Consecutive tokenProvider failures. Reset on a successful
        // resolution. Drives the "token-provider-error" event after
        // TOKEN_PROVIDER_FAILURE_EVENT_THRESHOLD consecutive failures so
        // customers can surface an actionable UI without the SDK spinning
        // silently.
        this.consecutiveTokenFailures = 0;
        // Forces the NEXT reconnect's delay to at least this many ms,
        // ignoring the exponential curve. Set when handleClose receives a
        // SLOW_BACKOFF_CLOSE_CODES code; cleared after consuming.
        this.nextDelayFloorMs = null;
        // Most recent close code — used by computeReconnectDelay to apply
        // the slow-backoff floor when applicable. Cleared on welcome.
        this.lastCloseCode = null;
        // Channels the customer has subscribed to and not unsubscribed
        // from. Replayed on every reconnect's welcome when autoResubscribe
        // is enabled. Value carries the per-subscription options so the
        // replayed frame matches the customer's original intent (only
        // includeSenderMetadata is observable today).
        //
        // Why track at subscribe-call time rather than ack time: subscribe
        // is idempotent server-side, so a customer who issued subscribe()
        // and didn't yet receive the ack BEFORE the drop still expects to
        // be subscribed on the new connection. Tracking on call instead
        // of ack avoids losing those.
        this.activeSubscriptions = new Map();
        // Per-channel retry counts for the current connection's replay
        // cycle. Cleared on every welcome — a fresh connection gets a
        // fresh budget.
        this.replayRetryCounts = new Map();
        // Pending replay-retry timers. Cleared on close / connection drop
        // so a retry can't fire into a dead or replaced connection (the
        // next welcome replays everything from scratch anyway).
        this.replayRetryTimers = new Set();
        // Monotonic guard for concurrent openSocket flows. Each call takes
        // the next epoch; an attempt that resumes from an awaited token
        // resolution and finds a NEWER epoch has been superseded (a fresh
        // connect() after close(), or the next reconnect attempt) and must
        // not build a socket — otherwise two live sockets fight over
        // this.socket / this.welcomeResolver and the loser leaks.
        this.connectEpoch = 0;
        // Server-advertised per-message cap, learned from each welcome.
        // Drives the pre-flight size check in publish()/send() so an
        // oversized payload rejects with a typed error instead of reaching
        // the server and losing the whole connection to a 1009 close.
        this.serverMaxMessageSize = null;
        // Has a welcome frame ever been received on THIS client instance?
        // Used to gate reconnection: we only auto-reconnect AFTER a
        // successful initial connect, never DURING the initial connect.
        // First-attempt failures reject the public connect() promise so
        // the customer knows; subsequent drops trigger reconnect because
        // the customer's app code has already wired up event listeners
        // and is depending on the client staying connected.
        this.wasEverConnected = false;
        if (opts.apiKey && opts.tokenProvider) {
            throw new TypeError("SignallingClient: pass exactly one of `apiKey` or `tokenProvider`, not both");
        }
        if (!opts.apiKey && !opts.tokenProvider) {
            throw new TypeError("SignallingClient: one of `apiKey` or `tokenProvider` is required");
        }
        __classPrivateFieldSet(this, _SignallingClientImpl_credential, opts.apiKey
            ? CredentialStore.fromApiKey(opts.apiKey)
            : CredentialStore.fromTokenProvider(opts.tokenProvider), "f");
        // Validate the base URL eagerly so a misconfigured env var (e.g.
        // a typo'd `ws://internal-test` that would leak the credential
        // over plaintext) throws at SignallingClient construction —
        // discoverable during the customer's first integration test
        // rather than mid-connect with a confusing close code.
        this.baseOrigin = validateBaseUrl(opts.url ?? DEFAULT_URL);
        this.logger = opts.logger ?? NoopLogger;
        // NaN is always a bug (an arithmetic slip, not an intent) —
        // reject loudly at construction like the reconnect knobs. Any
        // other non-finite or <= 0 value means "disable the watchdog":
        // both arm methods refuse to arm, so disabling the watchdog
        // disables the keepalive in lock-step. The explicit guards
        // matter because setTimeout coerces Infinity/negative to ~1ms —
        // without them a "disabled" watchdog would kill every connection
        // right after open, before the welcome could land.
        if (opts.inactivityTimeoutMs !== undefined &&
            Number.isNaN(opts.inactivityTimeoutMs)) {
            throw new TypeError("SignallingClient: inactivityTimeoutMs must be a number (<= 0 disables the watchdog)");
        }
        this.inactivityTimeoutMs =
            opts.inactivityTimeoutMs ?? DEFAULT_INACTIVITY_TIMEOUT_MS;
        // /3 → two ping attempts before the watchdog fires (mobile loss
        // tolerance). Floored at 1s. Zeroed when the watchdog is disabled
        // so armHeartbeatTimer refuses too — otherwise the floor would
        // resurrect a 1s keepalive the customer asked to turn off.
        this.heartbeatIntervalMs =
            Number.isFinite(this.inactivityTimeoutMs) && this.inactivityTimeoutMs > 0
                ? Math.max(1000, Math.floor(this.inactivityTimeoutMs / 3))
                : 0;
        if (opts.tokenProviderTimeoutMs !== undefined &&
            (typeof opts.tokenProviderTimeoutMs !== "number" ||
                !Number.isFinite(opts.tokenProviderTimeoutMs) ||
                opts.tokenProviderTimeoutMs <= 0)) {
            // No disable semantic here — a tokenProvider with no timeout
            // pins connect() forever on a hung mint endpoint, which is the
            // exact failure this option exists to prevent.
            throw new TypeError("SignallingClient: tokenProviderTimeoutMs must be a finite number > 0");
        }
        this.tokenProviderTimeoutMs =
            opts.tokenProviderTimeoutMs ?? DEFAULT_TOKEN_PROVIDER_TIMEOUT_MS;
        // Default ON — the silent-subscription-loss failure mode is too
        // easy to hit. Customers who want per-session scoping opt out.
        this.autoResubscribe = opts.autoResubscribe !== false;
        if (opts.reconnect === false) {
            this.reconnectOpts = null;
        }
        else {
            this.reconnectOpts = { ...DEFAULT_RECONNECT, ...(opts.reconnect ?? {}) };
            validateReconnectOptions(this.reconnectOpts);
        }
        if (opts.webSocketFactory) {
            this.webSocketFactory = opts.webSocketFactory;
        }
        else {
            const globalWS = globalThis.WebSocket;
            if (!globalWS) {
                throw new Error("SignallingClient: no globalThis.WebSocket — pass `webSocketFactory` in options");
            }
            this.webSocketFactory = (u) => new globalWS(u);
        }
        // Forward EventEmitter listener errors to the customer's logger
        // via the documented constructor option. The earlier
        // post-construction dirty assignment worked at runtime (TS
        // `readonly` is erased) but read like a hack; this is the
        // documented surface.
        const onListenerError = (err, ev) => {
            this.logger.error("listener threw", { event: ev, err: String(err) });
        };
        this.events = new EventEmitter({
            onListenerError,
        });
    }
    /**
     * Custom JSON marshal — any Sentry breadcrumb / console.dir
     * snapshot that walks the SignallingClient sees an empty shape
     * instead of the credential, socket internals, or pending-ack
     * map (which could include sensitive customer payloads). Belt-
     * and-braces on top of the CredentialStore's own isolation.
     */
    toJSON() {
        return { state: this._state };
    }
    get state() {
        return this._state;
    }
    /**
     * Public entry point. The caller awaits this for the FIRST connect;
     * subsequent reconnects after a drop happen automatically through
     * the close handler and don't go through this method.
     */
    async connect() {
        if (this._state !== "idle" && this._state !== "closed") {
            // Customers shouldn't call connect() while connecting / connected
            // / reconnecting. Throw eagerly so the bug is obvious.
            throw new Error(`SignallingClient.connect: invalid state '${this._state}'`);
        }
        this.explicitlyClosed = false;
        this.reconnectAttempts = 0;
        // Reset so a fresh public connect() goes through the
        // "try-once-and-reject" path, not the "silently reconnect" path.
        this.wasEverConnected = false;
        return this.openSocket();
    }
    /**
     * Open a WS connection. Used by:
     *   1. The public connect() — caller awaits the returned promise
     *   2. The reconnect timer — caller doesn't await; the returned
     *      promise's rejection is caught internally and triggers
     *      another scheduled reconnect (until maxAttempts)
     *
     * Credential resolution is split into sync (apiKey) and async
     * (tokenProvider) paths so the apiKey case opens the socket in
     * the same task as the connect() call — preserving the
     * "factory-called-synchronously" contract that integration
     * harnesses rely on.
     */
    async openSocket() {
        const epoch = ++this.connectEpoch;
        this.transitionTo(this.reconnectAttempts > 0 ? "reconnecting" : "connecting");
        let cred;
        const sync = __classPrivateFieldGet(this, _SignallingClientImpl_credential, "f").resolveSync();
        if (sync) {
            cred = sync;
        }
        else {
            try {
                cred = await this.resolveTokenWithTimeout();
                // Success — clear the consecutive-failure counter.
                this.consecutiveTokenFailures = 0;
            }
            catch (err) {
                // Credential resolution failure — same as if WS itself failed:
                // schedule a retry (tokenProvider may transiently fail). If
                // reconnect is disabled, transition to closed.
                const scrubbed = scrubError(err);
                this.consecutiveTokenFailures += 1;
                if (this.consecutiveTokenFailures >= TOKEN_PROVIDER_FAILURE_EVENT_THRESHOLD) {
                    // Customer-actionable signal: tokenProvider is chronically
                    // failing. Emit once per call after the threshold; the
                    // client keeps retrying (until maxAttempts), but at least
                    // the customer's UI can surface "your auth is broken".
                    this.events.emit("token-provider-error", {
                        consecutiveFailures: this.consecutiveTokenFailures,
                        err: scrubbed,
                    });
                }
                if (this.shouldScheduleReconnect(null)) {
                    this.logger.warn("credential resolve failed; scheduling reconnect", {
                        err: scrubbed.message,
                        consecutiveFailures: this.consecutiveTokenFailures,
                    });
                    this.scheduleReconnect();
                    return;
                }
                this.transitionTo("closed");
                throw scrubbed;
            }
        }
        // A NEWER openSocket may have started during the awaited token
        // resolution above (close() followed by a fresh connect() is
        // legal). If so, the newer flow owns this.socket / the resolver /
        // the state machine — building a second socket here would leave
        // two live connections fighting over them, with the loser leaked
        // (doubling concurrent-connection usage server-side). Bail
        // silently; don't touch state the newer flow controls.
        if (epoch !== this.connectEpoch) {
            this.logger.debug("openSocket aborted: superseded by a newer connect during credential resolution");
            // Reject rather than resolve — resolving would tell the
            // original caller "connected" when this attempt never built a
            // socket. (The reconnect-timer caller just logs rejections.)
            throw new Error("SignallingClient.connect: superseded by a newer connect()");
        }
        // close() may have run during the awaited token resolution above.
        // At that point `this.socket` was still null, so close() had nothing
        // to tear down — it set explicitlyClosed + state "closed" and
        // returned. If we now build a socket it escapes teardown entirely:
        // its welcome/close handlers can re-arm the inactivity/heartbeat
        // timers and transition the client back out of "closed", and a
        // reconnect can even fire after the customer believed the client was
        // terminal. Bail before constructing the socket. (The synchronous
        // apiKey path can't hit this — there is no await between the state
        // transition and socket creation — so this only guards tokenProvider
        // and reconnect-timer-driven opens.)
        if (this.explicitlyClosed) {
            this.logger.debug("openSocket aborted: client closed during credential resolution");
            if (this._state !== "closed")
                this.transitionTo("closed");
            return;
        }
        const url = buildConnectUrl(this.baseOrigin, cred);
        this.logger.debug("opening socket", {
            url: scrubCredentialQueryParams(url),
            attempt: this.reconnectAttempts,
        });
        return new Promise((resolveConnect, rejectConnect) => {
            let socket;
            try {
                socket = this.webSocketFactory(url);
            }
            catch (err) {
                // Node `ws` puts the full URL (including ?token=…) in
                // err.message when it rejects a malformed URL. Scrub before
                // forwarding so Sentry-style auto-capture doesn't ship the
                // credential.
                rejectConnect(scrubError(err));
                // Route through the shared close path so a throwing factory
                // (CSP blocking WebSocket construction is the realistic
                // browser trigger) behaves like every other connection
                // failure: 'disconnected' is emitted — wrappers like
                // MeteredPeer react ONLY to that event and previously hung in
                // "reconnecting" forever when this path jumped straight to
                // "closed" — and retry-vs-terminal follows the normal
                // reconnect policy (bounded retries, then a final
                // disconnected{willReconnect:false}).
                this.handleClose(1006, "websocket construction failed");
                return;
            }
            this.socket = socket;
            const resolver = {
                resolve: () => {
                    // Successful welcome — reset the backoff counter, mark
                    // the client as "ever connected" so future drops trigger
                    // reconnect.
                    this.reconnectAttempts = 0;
                    this.wasEverConnected = true;
                    this.transitionTo("connected");
                    resolveConnect();
                },
                reject: (err) => {
                    // Don't transition to closed here — handleClose will do
                    // that AFTER deciding whether to schedule a reconnect.
                    rejectConnect(err);
                },
                timer: setTimeout(() => {
                    // Welcome never arrived — reject the connect AND tear the
                    // socket down. Clearing the resolver first means a welcome
                    // that limps in later hits the "unexpected welcome" branch
                    // and is ignored, instead of flipping an already-rejected
                    // connect() to "connected". Closing the socket (rather than
                    // leaving it half-open) lets handleClose drive the normal
                    // retry/terminal decision immediately instead of stalling
                    // in "connecting" until the inactivity watchdog fires.
                    //
                    // Guarded on identity: only OUR resolver may be torn down.
                    // A superseded attempt's stray timer must never reject a
                    // newer attempt's pending connect.
                    if (this.welcomeResolver !== resolver)
                        return;
                    this.welcomeResolver = null;
                    resolver.reject(new Error(`no welcome frame within ${WELCOME_TIMEOUT_MS}ms`));
                    try {
                        socket.close(4000, "welcome timeout");
                    }
                    catch {
                        /* socket may already be tearing down */
                    }
                }, WELCOME_TIMEOUT_MS),
            };
            this.welcomeResolver = resolver;
            // Capture this socket locally so the close handler can verify
            // it matches `this.socket` (guards against the theoretical race
            // where a late close event from a previous socket fires after
            // a reconnect has already created a new this.socket).
            const ownedSocket = socket;
            const onOpen = () => {
                this.logger.debug("ws open");
                this.armInactivityTimer(ownedSocket);
                this.armHeartbeatTimer(ownedSocket);
            };
            const onMessage = (ev) => {
                const data = ev.data;
                if (typeof data !== "string") {
                    this.logger.warn("ws non-string frame, dropping");
                    return;
                }
                // Inbound message size cap. Defends against a malicious /
                // compromised server flooding the client with a giant frame
                // and OOMing it. Browser WS implementations don't all enforce
                // a strict ceiling, and Node `ws` defaults to ~100 MB.
                if (data.length > MAX_INBOUND_FRAME_BYTES) {
                    this.logger.warn("ws frame exceeds size cap, closing connection", {
                        size: data.length,
                        cap: MAX_INBOUND_FRAME_BYTES,
                    });
                    // Closing terminates the socket so reconnect kicks in
                    // rather than letting the customer's message handler see
                    // a frame larger than the server should ever send.
                    try {
                        ownedSocket.close(1009, "frame exceeded client cap");
                    }
                    catch {
                        /* socket may already be tearing down */
                    }
                    return;
                }
                this.armInactivityTimer(ownedSocket);
                // Any inbound frame (the pong included) suppresses the next ping
                // for one full heartbeat interval — we only probe when truly idle.
                this.armHeartbeatTimer(ownedSocket);
                this.handleFrame(data, ownedSocket);
            };
            const onClose = (ev) => {
                const code = ev.code ?? 1006;
                const reason = ev.reason ?? "";
                // Skip stale-socket events: a late close event from a
                // previous socket must not perturb the state of the new one.
                if (this.socket !== ownedSocket && this.socket !== null) {
                    this.logger.warn("ignoring close event from stale socket", { code });
                    return;
                }
                // Belt-and-braces — drop the listeners so they can't fire
                // again even if the underlying implementation queues
                // post-close events.
                ownedSocket.removeEventListener("open", onOpen);
                ownedSocket.removeEventListener("message", onMessage);
                ownedSocket.removeEventListener("close", onClose);
                ownedSocket.removeEventListener("error", onError);
                this.handleClose(code, reason);
            };
            const onError = () => {
                this.logger.warn("ws error event");
            };
            ownedSocket.addEventListener("open", onOpen);
            ownedSocket.addEventListener("message", onMessage);
            ownedSocket.addEventListener("close", onClose);
            ownedSocket.addEventListener("error", onError);
        });
    }
    /**
     * Replay every tracked subscription as a fresh subscribe frame on
     * the new connection. Called from the welcome handler when
     * isReconnect=true and autoResubscribe is on.
     *
     * Failure handling: a replay whose ack is lost or that the server
     * rejects (transient authorization hiccup, rate pressure at
     * reconnect time) is retried up to SUBSCRIBE_REPLAY_MAX_RETRIES
     * times on this connection, spaced SUBSCRIBE_REPLAY_RETRY_DELAY_MS
     * apart. Without the retry the subscription would be silently dead
     * until the NEXT reconnect — the exact failure mode autoResubscribe
     * exists to prevent. We don't await the acks (replay shouldn't
     * block other welcome activity, and the 15s ack timeouts would
     * serialize and starve).
     *
     * If retries exhaust, the channel REMAINS in activeSubscriptions —
     * a future reconnect tries again with a fresh budget. Subscribe is
     * idempotent server-side, so a duplicate replay racing a customer
     * re-subscribe is harmless.
     */
    replayActiveSubscriptions() {
        if (this.activeSubscriptions.size === 0)
            return;
        this.logger.info("replaying subscriptions on reconnect", {
            count: this.activeSubscriptions.size,
        });
        for (const channel of this.activeSubscriptions.keys()) {
            this.replaySubscription(channel);
        }
    }
    /**
     * Issue one replay subscribe for `channel`, scheduling a bounded
     * retry on failure. Reads the options fresh from activeSubscriptions
     * at each attempt so a customer re-subscribe with new options
     * between retries wins.
     */
    replaySubscription(channel) {
        const opts = this.activeSubscriptions.get(channel);
        if (opts === undefined)
            return; // customer unsubscribed meanwhile
        this.sendWithAck((requestId) => buildSubscribe(channel, { ...opts, requestId })).catch((err) => {
            // A rejection caused by the connection dying (handleClose
            // rejects all pending acks) must NOT schedule a retry — the
            // timer-clear in handleClose has already run by the time this
            // microtask fires, so a retry scheduled here would leak across
            // connections and double-fire into the next welcome's replay.
            // The next welcome replays the full set with a fresh budget.
            if (this._state !== "connected")
                return;
            const used = this.replayRetryCounts.get(channel) ?? 0;
            if (used >= SUBSCRIBE_REPLAY_MAX_RETRIES) {
                this.logger.warn("subscription replay failed; retries exhausted", {
                    channel,
                    err: err.message,
                    attempts: used + 1,
                });
                return;
            }
            this.replayRetryCounts.set(channel, used + 1);
            this.logger.warn("subscription replay failed; scheduling retry", {
                channel,
                err: err.message,
                retry: used + 1,
            });
            const timer = setTimeout(() => {
                this.replayRetryTimers.delete(timer);
                // The connection may have dropped since (the next welcome
                // replays from scratch with a fresh budget) — don't retry
                // into a dead or replaced socket.
                if (this._state !== "connected")
                    return;
                this.replaySubscription(channel);
            }, SUBSCRIBE_REPLAY_RETRY_DELAY_MS);
            this.replayRetryTimers.add(timer);
        });
    }
    clearReplayRetryTimers() {
        for (const timer of this.replayRetryTimers)
            clearTimeout(timer);
        this.replayRetryTimers.clear();
    }
    /**
     * Wrap `#credential.resolveToken()` in a Promise.race against a
     * timeout so a hanging customer mint endpoint can't pin connect()
     * forever. Default 10s, overridable via tokenProviderTimeoutMs.
     */
    resolveTokenWithTimeout() {
        return new Promise((resolve, reject) => {
            let settled = false;
            const timer = setTimeout(() => {
                if (settled)
                    return;
                settled = true;
                reject(new Error(`tokenProvider did not resolve within ${this.tokenProviderTimeoutMs}ms`));
            }, this.tokenProviderTimeoutMs);
            __classPrivateFieldGet(this, _SignallingClientImpl_credential, "f").resolveToken().then((v) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                resolve(v);
            }, (err) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                reject(err);
            });
        });
    }
    /** Decide whether a close → reconnect should happen. */
    shouldScheduleReconnect(closeCode) {
        if (this.explicitlyClosed)
            return false;
        if (this.reconnectOpts === null)
            return false;
        // Reconnect only after a successful initial welcome. First-
        // attempt failures bubble up to the public connect() promise
        // so the customer sees the failure rather than the client
        // entering a silent retry loop.
        if (!this.wasEverConnected)
            return false;
        if (closeCode !== null && TERMINAL_CLOSE_CODES.has(closeCode)) {
            return false;
        }
        if (this.reconnectAttempts >= this.reconnectOpts.maxAttempts) {
            return false;
        }
        return true;
    }
    /** Compute the next reconnect delay using exponential backoff + jitter. */
    computeReconnectDelay() {
        if (!this.reconnectOpts)
            return 0;
        const { initialDelayMs, multiplier, maxDelayMs, jitterRatio } = this.reconnectOpts;
        // Attempt 1 → initialDelayMs (multiplier^0). Attempt 2 →
        // initialDelayMs * multiplier (^1). reconnectAttempts is incremented
        // BEFORE delay computation in scheduleReconnect, so use (n - 1)
        // here to align the first retry with initialDelayMs as documented.
        const exponent = Math.max(0, this.reconnectAttempts - 1);
        const base = Math.min(initialDelayMs * Math.pow(multiplier, exponent), maxDelayMs);
        // Apply the slow-backoff floor if the last close was an
        // "over-capacity" code (4010 OverConcurrentLimit). Reconnecting
        // in 500ms would just hit the same wall — wait at least 30s so
        // other connections have a chance to drop.
        const floor = this.nextDelayFloorMs ?? 0;
        const beforeJitter = Math.max(base, floor);
        // ±jitterRatio symmetric around the (possibly floor-lifted) base.
        // Math.random() gives [0,1); (Math.random()*2 - 1) gives [-1, +1).
        const delta = beforeJitter * jitterRatio * (Math.random() * 2 - 1);
        return Math.max(0, Math.floor(beforeJitter + delta));
    }
    scheduleReconnect() {
        if (this.reconnectTimer !== null)
            return; // already scheduled
        if (!this.reconnectOpts)
            return;
        // handleClose emits "disconnected" BEFORE calling this method. A
        // customer handler (or MeteredPeer's drop-during-join path) may
        // call close() synchronously inside that event; honour it here,
        // otherwise the timer created below would outlive the close()
        // (which cleared the — then nonexistent — timer already) and the
        // client would reconnect after an explicit close.
        if (this.explicitlyClosed)
            return;
        this.reconnectAttempts += 1;
        const delay = this.computeReconnectDelay();
        // Consume the floor so a subsequent retry (after this attempt
        // also fails) falls back to normal exponential growth unless
        // another slow-backoff close code surfaces it again.
        this.nextDelayFloorMs = null;
        this.transitionTo("reconnecting");
        this.logger.info("scheduling reconnect", {
            attempt: this.reconnectAttempts,
            delayMs: delay,
            lastCloseCode: this.lastCloseCode,
        });
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            // openSocket's promise can reject if the credential resolution
            // throws synchronously OR the webSocketFactory throws. Either
            // way, handleClose / openSocket's catch path will schedule the
            // next retry — we just swallow the rejection here so the unhandled
            // promise rejection warning doesn't fire.
            this.openSocket().catch((err) => {
                this.logger.warn("reconnect attempt rejected", { err: String(err) });
            });
        }, delay);
    }
    clearReconnectTimer() {
        if (this.reconnectTimer !== null) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }
    /**
     * Close the connection. After close() the client is terminal — no
     * auto-reconnect. The returned Promise resolves once the underlying
     * socket has fired its 'close' event (or `CLOSE_FLUSH_TIMEOUT_MS`
     * elapses, whichever first), so a caller doing:
     *
     *   await client.close();
     *   process.exit(0);
     *
     * actually waits for the TCP FIN to flush instead of sending a
     * RST. The flush timeout cap is a safety net: a wedged transport
     * shouldn't pin process exit indefinitely.
     */
    async close(code = 1000, reason = "client requested close") {
        // Set FIRST so a close-triggered handleClose doesn't try to
        // schedule a reconnect.
        this.explicitlyClosed = true;
        this.clearReconnectTimer();
        this.clearInactivityTimer();
        this.clearHeartbeatTimer();
        this.clearReplayRetryTimers();
        const socket = this.socket;
        if (!socket || this._state === "closed") {
            this.transitionTo("closed");
            return;
        }
        // Wait for the actual close event. Race against a timeout so a
        // wedged transport can't hang the caller (worst case is the
        // socket's close arrives milliseconds after; we move on).
        const closed = new Promise((resolve) => {
            let settled = false;
            const settle = () => {
                if (settled)
                    return;
                settled = true;
                // Detach on BOTH settle paths — previously only the timeout
                // branch removed the listener, leaving it attached when the
                // close event won the race.
                socket.removeEventListener("close", onceClose);
                resolve();
            };
            const onceClose = () => {
                settle();
            };
            socket.addEventListener("close", onceClose);
            setTimeout(() => {
                settle();
            }, CLOSE_FLUSH_TIMEOUT_MS);
        });
        try {
            socket.close(code, reason);
        }
        catch {
            /* socket may already be torn down */
        }
        this.transitionTo("closed");
        await closed;
    }
    async subscribe(channel, opts = {}) {
        // Validate BEFORE tracking — an invalid name must never enter the
        // auto-resubscribe set, where it would be replayed (and re-fail,
        // with a warning) on every future reconnect.
        validateChannel(channel);
        const wasTracked = this.activeSubscriptions.has(channel);
        // Track BEFORE sending so a drop between send and ack doesn't
        // lose the subscription (subscribe is idempotent server-side).
        // Re-subscribing the same channel with new opts replaces the
        // stored options — matches the server's "last subscribe wins"
        // semantics for the includeSenderMetadata flag.
        this.activeSubscriptions.set(channel, { ...opts });
        try {
            return await this.sendWithAck((requestId) => buildSubscribe(channel, { ...opts, requestId }));
        }
        catch (err) {
            // A "not connected" rejection means the frame never left this
            // client — the caller was told the subscribe failed, so don't
            // keep a silent subscription for the next reconnect to replay.
            // Channels already tracked by an earlier subscribe stay (this
            // failed RE-subscribe shouldn't cancel a live one), and
            // mid-flight drops (DisconnectedError) stay too — the frame may
            // have reached the server, which is exactly the case the
            // track-before-send ordering exists for.
            if (!wasTracked && err.name === "NotConnectedError") {
                this.activeSubscriptions.delete(channel);
            }
            throw err;
        }
    }
    async unsubscribe(channel) {
        // Remove BEFORE sending — an in-flight unsubscribe that drops
        // before ack shouldn't be replayed as a subscribe on reconnect.
        // The server's unsubscribe is idempotent, so re-issuing is safe
        // either way; we err on the side of "respect customer intent".
        this.activeSubscriptions.delete(channel);
        return this.sendWithAck((requestId) => buildUnsubscribe(channel, { requestId }));
    }
    async publish(channel, data, _opts = {}) {
        this.checkOutboundSize(data);
        return this.sendWithAck((requestId) => buildPublish(channel, data, { requestId }));
    }
    async send(toPeerId, data, _opts = {}) {
        this.checkOutboundSize(data);
        return this.sendWithAck((requestId) => buildSend(toPeerId, data, { requestId }));
    }
    /**
     * Pre-flight size gate for publish()/send() payloads, measured
     * against the welcome-advertised cap. Throws OversizedPayloadError
     * (surfaces as a rejection from the async callers). Non-serialisable
     * data (circular, BigInt) passes through — the frame builder's own
     * JSON.stringify raises the layered TypeError for those.
     */
    checkOutboundSize(data) {
        let serialised;
        try {
            serialised = JSON.stringify(data);
        }
        catch {
            return;
        }
        // undefined / function / symbol serialise to undefined, not a
        // string — let the builder's validation own those rejections.
        if (typeof serialised !== "string")
            return;
        const size = utf8ByteLength(serialised);
        const cap = this.serverMaxMessageSize ?? DEFAULT_MAX_MESSAGE_SIZE;
        if (size > cap) {
            throw new OversizedPayloadError(size, cap);
        }
    }
    on(event, handler) {
        this.events.on(event, handler);
        return this;
    }
    off(event, handler) {
        this.events.off(event, handler);
        return this;
    }
    once(event, handler) {
        this.events.once(event, handler);
        return this;
    }
    // ---------- internal helpers ----------
    transitionTo(next) {
        if (this._state === next)
            return;
        const from = this._state;
        this._state = next;
        this.events.emit("state-change", { from, to: next });
    }
    handleFrame(raw, sourceSocket) {
        // Guard: a late inbound frame from a previous socket must not
        // dispatch on the current state. Browsers don't normally deliver
        // messages after close, but if they did, an old socket's
        // 'message' could fire AFTER reconnect swapped this.socket.
        if (this.socket !== sourceSocket && this.socket !== null) {
            this.logger.warn("ignoring frame from stale socket");
            return;
        }
        const frame = parseServerFrame(raw);
        if (frame.type === "_malformed") {
            this.logger.warn("malformed inbound frame", {
                reason: frame.reason,
            });
            return;
        }
        switch (frame.type) {
            case "welcome": {
                // A welcome racing an explicit close() (close() called, the
                // socket's own close event not yet delivered) must not
                // resurrect the client — close() is documented terminal.
                if (this.explicitlyClosed) {
                    this.logger.warn("ignoring welcome frame after close()");
                    return;
                }
                // First welcome resolves the connect() promise. A second
                // welcome would be a server bug — log and ignore.
                if (this.welcomeResolver) {
                    clearTimeout(this.welcomeResolver.timer);
                    const r = this.welcomeResolver;
                    this.welcomeResolver = null;
                    // Snapshot isReconnect BEFORE resolve() flips the
                    // wasEverConnected flag inside it. Customers branching on
                    // isReconnect for "reconnected, please re-subscribe" UI
                    // want true on every welcome AFTER the first.
                    const isReconnect = this.wasEverConnected;
                    r.resolve();
                    this.lastCloseCode = null;
                    // TURN credentials live under welcome.metadata.iceServers
                    // (a customer convention — the wire protocol treats
                    // metadata as an opaque JSON bag). Refreshed on every
                    // reconnect so JWT-rotated TURN creds land automatically.
                    const iceServers = extractIceServersFromMetadata(frame.payload.metadata);
                    this.serverMaxMessageSize = frame.payload.maxMessageSize;
                    this.events.emit("connected", {
                        peerId: frame.payload.peerId,
                        serverTime: frame.payload.serverTime,
                        expiresAt: frame.payload.expiresAt,
                        isReconnect,
                        maxMessageSize: frame.payload.maxMessageSize,
                        ...(iceServers ? { iceServers } : {}),
                    });
                    // Replay tracked subscriptions on a reconnect's welcome
                    // (NOT the initial welcome — there's nothing to replay).
                    // Customer-side `connected` handlers run before this; the
                    // subscribe handler in customer code might race with the
                    // SDK's replay, but server-side subscribe is idempotent
                    // so the worst case is a redundant ack.
                    //
                    // Fresh connection → fresh replay-retry budget.
                    this.replayRetryCounts.clear();
                    if (isReconnect && this.autoResubscribe) {
                        this.replayActiveSubscriptions();
                    }
                }
                else {
                    this.logger.warn("unexpected welcome frame");
                }
                return;
            }
            case "ack": {
                const pending = this.pendingAcks.get(frame.requestId);
                if (pending) {
                    clearTimeout(pending.timer);
                    this.pendingAcks.delete(frame.requestId);
                    pending.resolve();
                }
                return;
            }
            case "error": {
                // Two flavours:
                //   - requestId present → correlated rejection for a pending
                //     subscribe/publish/send
                //   - requestId absent → server-initiated (e.g.
                //     over_message_quota with no specific request to fail);
                //     emit as the "server-error" event for customer handling
                if (frame.payload.requestId) {
                    const pending = this.pendingAcks.get(frame.payload.requestId);
                    if (pending) {
                        clearTimeout(pending.timer);
                        this.pendingAcks.delete(frame.payload.requestId);
                        const err = new Error(frame.payload.message ?? frame.payload.code);
                        err.name = frame.payload.code;
                        pending.reject(err);
                        return;
                    }
                }
                // Old-server compatibility for the heartbeat: a pre-ping server
                // answers our `ping` with `error { code: "unknown_type" }` and no
                // requestId (the SDK's ping carries none). Swallow precisely that
                // shape — gating on requestId-less keeps the swallow narrow so a
                // future client-emitted novel type carrying a requestId would
                // still surface its own unknown_type rejection to the customer.
                if (frame.payload.code === "unknown_type" &&
                    !frame.payload.requestId) {
                    this.logger.debug("ignoring unknown_type error (server lacks app-level ping support)");
                    return;
                }
                this.events.emit("server-error", frame.payload);
                return;
            }
            case "message":
                this.events.emit("message", frame.payload);
                return;
            case "direct":
                this.events.emit("direct", frame.payload);
                return;
            case "presence":
                this.events.emit("presence", frame.payload);
                return;
            case "going_away":
                this.events.emit("going-away", frame.payload);
                return;
            case "pong":
                // Heartbeat reply. armInactivityTimer + armHeartbeatTimer
                // already fired in onMessage — nothing else to do here. Kept
                // as an explicit case so the parser-strict default never logs
                // a "malformed" warning for our own keepalive.
                return;
        }
    }
    handleClose(code, reason) {
        this.logger.info("ws closed", { code, reason });
        this.clearInactivityTimer();
        this.clearHeartbeatTimer();
        // Pending replay retries target THIS connection; the next welcome
        // replays the full subscription set from scratch.
        this.clearReplayRetryTimers();
        // Welcome timeout might have already rejected — guard.
        if (this.welcomeResolver) {
            clearTimeout(this.welcomeResolver.timer);
            this.welcomeResolver.reject(new SignallingConnectError(code, reason));
            this.welcomeResolver = null;
        }
        // Reject any pending acks with a disconnected error so callers
        // don't hang. Snapshot first so the iteration isn't perturbed.
        const snapshot = [...this.pendingAcks.entries()];
        this.pendingAcks.clear();
        for (const [, pending] of snapshot) {
            clearTimeout(pending.timer);
            const err = new Error(`connection closed before ack: code=${code} reason='${reason}'`);
            err.name = "DisconnectedError";
            pending.reject(err);
        }
        this.socket = null;
        this.lastCloseCode = code;
        // Slow-backoff close codes (4010 OverConcurrentLimit) force the
        // NEXT reconnect's delay to a longer floor — give the bottleneck
        // time to clear instead of hammering the quota gate. Clears
        // automatically once consumed by scheduleReconnect.
        if (SLOW_BACKOFF_CLOSE_CODES.has(code)) {
            this.nextDelayFloorMs = SLOW_BACKOFF_FLOOR_MS;
        }
        const willReconnect = this.shouldScheduleReconnect(code);
        this.events.emit("disconnected", {
            code,
            reason,
            willReconnect,
        });
        if (willReconnect) {
            // scheduleReconnect transitions state to "reconnecting" itself
            // — don't pre-transition to closed here.
            this.scheduleReconnect();
        }
        else {
            this.transitionTo("closed");
        }
    }
    sendWithAck(buildFrame) {
        if (this._state !== "connected") {
            const err = new Error(`SignallingClient: not connected (state=${this._state})`);
            // Stable name: "this frame never left the client" — distinct
            // from DisconnectedError ("sent, but the connection dropped
            // before the ack"). subscribe() branches on it to roll back
            // tracking, and customers can too.
            err.name = "NotConnectedError";
            return Promise.reject(err);
        }
        const socket = this.socket;
        if (!socket) {
            return Promise.reject(new Error("SignallingClient: socket missing"));
        }
        const requestId = generateRequestId();
        let frame;
        try {
            frame = buildFrame(requestId);
        }
        catch (err) {
            // Builder threw (validation failure) — surface synchronously
            // via promise rejection so the customer's await sees it.
            return Promise.reject(err);
        }
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingAcks.delete(requestId);
                reject(new Error(`ack timeout for requestId=${requestId} (no server ack within ${DEFAULT_ACK_TIMEOUT_MS}ms)`));
            }, DEFAULT_ACK_TIMEOUT_MS);
            this.pendingAcks.set(requestId, { resolve, reject, timer });
            try {
                socket.send(frame);
            }
            catch (err) {
                clearTimeout(timer);
                this.pendingAcks.delete(requestId);
                reject(err);
            }
        });
    }
    /**
     * Schedule the inactivity watchdog against a SPECIFIC socket
     * captured locally. If the timer fires after a reconnect has
     * already replaced `this.socket`, closing the captured socket is
     * a no-op (already closed) instead of accidentally closing the
     * new live one. There's no current code path that triggers this
     * (clearInactivityTimer runs in handleClose before reconnect), but
     * the local capture makes the invariant explicit at low cost.
     */
    armInactivityTimer(socket) {
        // Non-finite / non-positive = watchdog disabled by the customer.
        // The guard must live here (not just at the heartbeat): setTimeout
        // coerces Infinity/NaN/negative to ~1ms, which would turn
        // "disabled" into a watchdog that closes every connection with
        // 4000 immediately after open.
        if (!Number.isFinite(this.inactivityTimeoutMs) ||
            this.inactivityTimeoutMs <= 0) {
            return;
        }
        this.clearInactivityTimer();
        this.inactivityTimer = setTimeout(() => {
            this.logger.warn("inactivity timeout — closing connection", {
                ms: this.inactivityTimeoutMs,
            });
            try {
                socket.close(4000, "inactivity timeout");
            }
            catch {
                /* already closing / closed */
            }
        }, this.inactivityTimeoutMs);
    }
    /**
     * Schedule the next heartbeat ping against a SPECIFIC socket captured
     * locally — same idiom as armInactivityTimer. Re-armed on open and on
     * every inbound frame (so active traffic suppresses pings), and again
     * by the timer itself after firing (so a dead link still gets a second
     * attempt before the watchdog closes the connection).
     *
     * No-op when the derived interval is non-finite or non-positive — the
     * customer disabled the inactivity watchdog and we follow.
     */
    armHeartbeatTimer(socket) {
        if (!Number.isFinite(this.heartbeatIntervalMs) ||
            this.heartbeatIntervalMs <= 0) {
            return;
        }
        this.clearHeartbeatTimer();
        this.heartbeatTimer = setTimeout(() => {
            this.heartbeatTimer = null;
            // Stale-socket guard: a reconnect may have swapped this.socket
            // while we were waiting. The fresh socket arms its own heartbeat
            // via its own onOpen / onMessage path.
            if (this.socket !== socket)
                return;
            this.sendPing(socket);
            this.armHeartbeatTimer(socket);
        }, this.heartbeatIntervalMs);
    }
    clearHeartbeatTimer() {
        if (this.heartbeatTimer !== null) {
            clearTimeout(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }
    // Fire-and-forget ping; gated on the connection being live so we
    // never probe the connecting/reconnecting window.
    sendPing(socket) {
        if (this._state !== "connected")
            return;
        // Belt-and-braces: a close-in-flight can leave _state === "connected"
        // for a tick while readyState has already transitioned. Skipping
        // here avoids a noisy warn log on every clean teardown.
        if (socket.readyState !== 1 /* OPEN */)
            return;
        try {
            socket.send(buildPing());
        }
        catch (err) {
            // scrubError strips ?key= / ?token= / SDP creds from the error
            // string so a customer's Sentry hook doesn't ship them upstream.
            this.logger.warn("failed to send heartbeat ping", {
                err: scrubError(err).message,
            });
        }
    }
    clearInactivityTimer() {
        if (this.inactivityTimer !== null) {
            clearTimeout(this.inactivityTimer);
            this.inactivityTimer = null;
        }
    }
    /** @internal — test hook; reconnection gates on this flag. */
    _explicitlyClosed() {
        return this.explicitlyClosed;
    }
}
_SignallingClientImpl_credential = new WeakMap();

// Wire-protocol type DECLARATIONS — the public-facing event payload
// shapes and ErrorCode union. Parsers + validators live in
// src/protocol/parser.ts; builders in src/protocol/builders.ts.
//
// These types track the Metered Realtime Messaging service's JSON
// wire format byte-for-byte. Service-side changes (new error codes,
// payload fields) get mirrored here in lockstep.
/**
 * WebSocket close codes the server may emit. Re-exported as a const
 * object (NOT enum) for tree-shakability and so customers can branch
 * on a runtime value without importing types-only.
 */
const WsCloseCode = {
    GoingAway: 1001,
    PolicyViolation: 1008,
    MessageTooBig: 1009,
    // Client-initiated. The SDK closes the connection with this code
    // when its inactivity watchdog fires (no server frames within
    // inactivityTimeoutMs — default 60s). Customers branching on
    // close codes should see this as "transient — auto-reconnect
    // handled it." Not in the server's WsCloseCode enum because the
    // server never emits it.
    ClientInactivity: 4000,
    InvalidToken: 4001,
    TokenExpired: 4002,
    ChannelNotAuthorized: 4003,
    OverConcurrentLimit: 4010,
    OverMessageRate: 4011,
    AccountSuspended: 4012,
    AdminDisconnect: 4020,
};

/**
 * Longest track id we accept from a remote SDP. Real ids are UUIDs
 * (36-38 chars); the cap keeps a malformed description from handing
 * an arbitrarily long string to the metadata lookup.
 */
const MAX_MSID_TRACK_ID_LEN = 256;
/**
 * Map of `mid -> track id` from each m-section's msid appdata
 * (`a=msid:<streamId> <trackId>`, or the legacy
 * `a=ssrc:<n> msid:<streamId> <trackId>`) — the track id the sender
 * signalled for that m-section.
 *
 * Receivers can't rely on `ev.track.id` matching the sender's
 * MediaStreamTrack.id: only Chromium copies the msid track id onto the
 * remote track; Firefox and Safari generate their own. Chromium,
 * Safari and libwebrtc / aiortc senders put their real track id in
 * the appdata, so this recovers it for them. Firefox senders write a
 * separate generated id there, which nothing is keyed by (callers fall
 * back to stream id + kind).
 */
function msidTrackIdsByMid(sdp) {
    const out = new Map();
    for (const section of sdp.split(/\r?\nm=/).slice(1)) {
        let mid;
        let trackId;
        for (const line of section.split(/\r?\n/)) {
            if (mid === undefined && line.startsWith("a=mid:")) {
                mid = line.slice(6);
            }
            else if (trackId === undefined) {
                trackId = /^a=(?:ssrc:\d+ )?msid:\S+ (\S+)$/.exec(line)?.[1];
            }
        }
        if (!mid || trackId === undefined || trackId.length > MAX_MSID_TRACK_ID_LEN)
            continue;
        out.set(mid, trackId);
    }
    return out;
}

// RTCPeerConnection wrapper + perfect-negotiation SDP exchange.
//
// Pairs with a remote SDK instance over the signalling-server's
// `send` / `direct` channel. The two peers exchange `rtc-description`
// and `rtc-ice` payloads — the server is oblivious (opaque JSON).
//
// Perfect-negotiation pattern (W3C reference): both peers are
// symmetric; either can initiate. On offer collision the `polite`
// side rolls back its own offer and accepts the remote. The other
// side ignores the late offer. The caller decides politeness — e.g.
// `polite = localPeerId < remotePeerId` (lexical tie-break).
//
// Why not the modern setLocalDescription() with no args? The signature
// is implementation-progressive: browsers have it; older `wrtc` builds
// don't. Using explicit createOffer/createAnswer + setLocalDescription
// works across both, which we need for the `wrtc`-backed Node-side
// integration test.
// Caps on inbound ICE-candidate flooding. A hostile peer
// can publish 100k+ candidates aimed at random IPs to fan out STUN
// probes via the browser; the cap bounds both per-cycle count and
// per-candidate string length. Reset on every successful
// setRemoteDescription (new negotiation generation).
const MAX_ICE_CANDIDATES_PER_GENERATION = 200;
const MAX_ICE_CANDIDATE_STRING = 1000;
// ICE-restart backoff ladder. Mirrors the WebSocket reconnect
// schedule: exponential with a floor and a max-attempt cap. On a
// permanently-broken link this prevents the SDK from burning the
// customer's battery and signalling-server quota with instant
// retries.
//
// Budget: 9 attempts → ~121 s total under an exponential curve
// (0 + 1 + 2 + 4 + 8 + 16 + 30 + 30 + 30 s, the last three pinned
// at the 30 s per-attempt cap). This spans real-world recovery
// scenarios (TURN-server failover, Wi-Fi → cellular roam on weak
// signal, mobile background-resume) without giving up prematurely.
//
// Trade-off: a permanently-broken link keeps the SDK in
// "reconnecting" for ~2 minutes before surfacing the give-up
// negotiation-error. Most apps prefer 2 minutes of patient retry
// to false-negative giving-up after 15 s on a weak mobile signal.
const ICE_RESTART_BASE_DELAY_MS = 1000;
const ICE_RESTART_MAX_DELAY_MS = 30000;
const ICE_RESTART_MAX_ATTEMPTS = 9;
// How long to wait for the remote's answer after shipping a restart
// offer. A lost answer (remote transport down, tab gone before the
// server notices) parks ICE in "new" — no further state transitions —
// so without this watchdog one lost answer would strand the ladder
// mid-budget and the terminal give-up signal would never fire. On
// expiry the attempt counts as failed and the ladder advances.
const ICE_RESTART_ANSWER_TIMEOUT_MS = 15000;
class PeerConnection extends EventEmitter {
    constructor(opts) {
        super();
        this._state = "idle";
        this.isMakingOffer = false;
        // True while a remote ANSWER is being applied. Part of the W3C
        // perfect-negotiation predicate: during that window signalingState
        // still reads "have-local-offer", but an offer arriving behind the
        // answer is NOT a collision — the operations chain applies the
        // answer first, so the offer lands on a stable connection. Without
        // this flag the impolite peer misclassifies and silently drops such
        // offers (the remote's renegotiation is lost until something else
        // triggers negotiation).
        this.isSettingRemoteAnswerPending = false;
        // Remote OFFERs being applied or answered: counted from the call to
        // setRemoteDescription until our answer has been applied (or either
        // step failed). While a remote offer is still queued, neither
        // signalingState nor remoteDescriptionGeneration shows it, so a local
        // offer resolving then looks fresh — yet applying it would queue
        // behind the remote offer and be rejected ("have-remote-offer"). A
        // count, not a flag, so an answer or another offer settling in
        // between cannot clear it early.
        this.remoteOffersInProgress = 0;
        // Set when we detect an unresolvable offer collision (impolite side).
        // Pending remote ICE candidates received during that window are
        // dropped silently instead of surfacing as errors.
        this.ignoreOffer = false;
        // Guards against runaway restart attempts when ICE failure persists.
        // Set when we kick off createOffer({iceRestart:true}); cleared when
        // iceConnectionState leaves "failed". Without this a permanently-
        // broken path would re-trigger restart on every state event.
        this.iceRestartInFlight = false;
        // Restart-ladder bookkeeping. Attempt counter resets to
        // 0 when connectionState reaches "connected" — a recovered link
        // restarts the budget. The scheduled-restart timer reference lets
        // close() cancel a pending restart so we don't fire after teardown.
        this.iceRestartAttempt = 0;
        this.iceRestartTimer = null;
        // Watchdog for a restart offer's answer — see
        // ICE_RESTART_ANSWER_TIMEOUT_MS. Cleared when any remote
        // description applies, on full recovery, and on close().
        this.iceRestartAnswerTimer = null;
        // Latched once the restart ladder is exhausted so the terminal
        // negotiation-error is emitted exactly once. A real RTCPeerConnection
        // oscillates iceConnectionState back into "failed" repeatedly on a
        // permanently-broken link; without this latch each oscillation would
        // re-emit, flooding a customer's `on("negotiation-error", …)` sink.
        // Reset alongside iceRestartAttempt when the link recovers
        // ("connected"), so a recovered-then-failed link gets a fresh budget
        // AND a fresh terminal signal.
        this.iceRestartGaveUp = false;
        // Inbound ICE candidate counter per negotiation generation
        //. Reset on every successful setRemoteDescription.
        this.candidatesThisGeneration = 0;
        this.candidateCapWarned = false;
        // Bumped every time an inbound remote description is applied. The
        // offer paths snapshot it before createOffer and abandon the offer
        // if it moved — a remote description processed mid-create makes the
        // created offer stale even when signalingState has already settled
        // back to "stable" (offer applied AND answered while we awaited).
        this.remoteDescriptionGeneration = 0;
        // Once closed, all event handlers are detached and the state machine
        // refuses further transitions. close() is idempotent.
        this.closed = false;
        // ---------- Internal handlers ----------
        /**
         * Browser fires `negotiationneeded` automatically whenever the local
         * description set is no longer compatible — typical triggers are
         * addTrack(), createDataChannel(), or an ICE restart request. We
         * respond by issuing an offer.
         *
         * The `isMakingOffer` flag is the collision-detection signal for
         * the polite peer: if remote sends an offer while we're mid-offer,
         * we know to roll back.
         */
        this.onNegotiationNeeded = (_ev) => {
            if (this.closed)
                return;
            void (async () => {
                try {
                    this.isMakingOffer = true;
                    const generation = this.remoteDescriptionGeneration;
                    const offer = await this.pc.createOffer();
                    if (this.closed)
                        return;
                    // Glare: a remote description was applied while createOffer
                    // was in flight (the polite path in handleDescription). Our
                    // offer is stale — applying it would either throw or kick off
                    // a redundant negotiation round. Abandon; the browser re-fires
                    // negotiationneeded once signaling returns to stable if
                    // renegotiation is still needed. The generation counter
                    // catches the applied-AND-answered interleaving where
                    // signalingState has already settled back to "stable";
                    // "have-local-offer" (our own earlier offer, unanswered) is
                    // NOT a collision — re-applying a fresh local offer there is
                    // legal and replaces the pending one. A remote offer still
                    // being applied counts as applied (see isRemoteOfferInProgress).
                    if (this.remoteDescriptionGeneration !== generation || this.isRemoteOfferInProgress()) {
                        this.logger.debug?.("abandoning local offer — remote description applied or pending mid-createOffer", { peer: this.remotePeerId, signalingState: this.pc.signalingState });
                        return;
                    }
                    await this.pc.setLocalDescription(offer);
                    if (this.closed)
                        return;
                    const local = this.pc.localDescription;
                    if (!local) {
                        throw new Error("setLocalDescription succeeded but localDescription is null");
                    }
                    if (this.closed)
                        return; // final guard before signalling-bound send
                    await this.sendLocalDescription(local);
                }
                catch (err) {
                    if (this.closed)
                        return;
                    this.emit("negotiation-error", { err: scrubError(err) });
                }
                finally {
                    this.isMakingOffer = false;
                    // ICE may have failed while this offer held the
                    // isMakingOffer lock — the ladder's skip branch can't
                    // re-enter on its own (iceconnectionstatechange only fires
                    // on transitions). No-op when ICE is healthy.
                    this.reenterLadderIfStillFailed();
                }
            })();
        };
        this.onLocalIceCandidate = (ev) => {
            if (this.closed)
                return;
            // RTCPeerConnectionIceEvent.candidate is RTCIceCandidate | null;
            // null is the end-of-candidates marker. We forward both — the
            // remote uses null to know our local agent has finished gathering.
            const candidate = ev.candidate;
            // toJSON() yields RTCIceCandidateInit (the wire-safe object); the
            // RTCIceCandidate object itself isn't JSON-stringifiable in all
            // implementations (browser/Node split), so we always serialize it.
            const wire = candidate === null ? null : (candidate.toJSON?.() ?? toCandidateInit(candidate));
            void this.signallingSender
                .send(this.remotePeerId, { type: "rtc-ice", candidate: wire })
                .catch((err) => {
                // Trickling is fire-and-forget — a failed send shouldn't
                // tank the connection. Surface to logger so debugging is
                // possible without bubbling out of the event handler.
                // Scrub the message in case the underlying signalling client
                // surfaced a URL with token=… in the rejection.
                this.logger.warn?.("failed to send local ICE candidate", {
                    peer: this.remotePeerId,
                    err: scrubError(err).message,
                });
            });
        };
        this.onTrack = (ev) => {
            if (this.closed)
                return;
            const { track, streams, transceiver } = ev;
            // The track event fires after the remote description is applied,
            // so remoteDescription holds the m-section for this mid.
            const sdp = this.pc.remoteDescription?.sdp;
            if (typeof sdp !== "string") {
                this.emit("track", { track, streams });
                return;
            }
            const byMid = msidTrackIdsByMid(sdp);
            const mid = transceiver?.mid;
            const msidTrackId = typeof mid === "string" ? byMid.get(mid) : undefined;
            this.emit("track", {
                track,
                streams,
                msidTrackIds: new Set(byMid.values()),
                ...(msidTrackId !== undefined ? { msidTrackId } : {}),
            });
        };
        this.onDataChannel = (ev) => {
            if (this.closed)
                return;
            const { channel } = ev;
            this.emit("data-channel", { channel });
        };
        /**
         * ICE-level state transitions. The aggregate `connectionState` is
         * a better signal for the public state machine, but iceConnectionState
         * is where the failure-recovery hook lives: when ICE transitions to
         * "failed", we schedule a `createOffer({ iceRestart: true })` to
         * renegotiate ICE candidates without rebuilding the connection.
         *
         * Restart ladder:
         *   attempt 1: immediate
         *   attempt 2: 1 s
         *   attempt 3: 2 s
         *   attempt 4: 4 s
         *   attempt 5: 8 s
         *   attempt 6: 16 s
         *   attempt 7: 30 s   (capped at ICE_RESTART_MAX_DELAY_MS)
         *   attempt 8: 30 s
         *   attempt 9: 30 s   (cumulative ≈ 121 s)
         *   attempt 10+: GIVE UP — emit one negotiation-error whose
         *                err.name === "IceRestartExhaustedError", stop
         *                retrying. The customer's app code must close()
         *                and reconnect.
         *
         * The attempt counter resets on `connectionState === "connected"`
         * (see onConnectionStateChange), so a recovered link gets a fresh
         * budget. Both peers may fire this concurrently — perfect negotiation
         * absorbs the resulting offer collision.
         */
        this.onIceConnectionStateChange = (_ev) => {
            if (this.closed)
                return;
            const ice = this.pc.iceConnectionState;
            if (ice !== "failed") {
                // Recovered (or never failed) — clear the in-flight guard so a
                // future failure can re-enter the ladder.
                this.iceRestartInFlight = false;
                return;
            }
            if (this.iceRestartInFlight || this.isMakingOffer) {
                this.logger.debug?.("ICE failed but restart already in flight, skipping", {
                    peer: this.remotePeerId,
                });
                return;
            }
            // A restart is already scheduled. iceRestartInFlight alone can't
            // guard this: a transient excursion out of "failed" (e.g. a
            // remote-initiated restart that then fails again) clears the
            // in-flight flag while the timer is still pending; re-entering
            // here would overwrite the timer reference and double-fire.
            if (this.iceRestartTimer !== null) {
                return;
            }
            this.scheduleNextRestartAttempt();
        };
        this.onConnectionStateChange = (_ev) => {
            if (this.closed)
                return;
            const cs = this.pc.connectionState;
            let next;
            switch (cs) {
                case "new":
                case "connecting":
                    next = "connecting";
                    break;
                case "connected":
                    // A fully-up connection earns a fresh restart budget — the
                    // attempt counter resets so a future ICE failure starts the
                    // ladder over from delay 0, and the give-up latch clears so a
                    // subsequent permanent failure emits its terminal error again.
                    this.iceRestartAttempt = 0;
                    this.iceRestartGaveUp = false;
                    this.clearRestartAnswerTimer();
                    next = "connected";
                    break;
                case "disconnected":
                case "failed":
                    // "disconnected" may self-heal; "failed" routes through the
                    // ICE-restart ladder in onIceConnectionStateChange. Either
                    // way, surface as "reconnecting" so the customer's UI can
                    // show a transient state without distinguishing.
                    next = "reconnecting";
                    break;
                case "closed":
                    next = "closed";
                    break;
                default:
                    return;
            }
            this.setState(next);
        };
        this.localPeerId = opts.localPeerId;
        this.remotePeerId = opts.remotePeerId;
        this.polite = opts.polite;
        this.signallingSender = opts.signallingSender;
        this.logger = opts.logger ?? {};
        const factory = opts.rtcPeerConnectionFactory ??
            ((config) => {
                // globalThis.RTCPeerConnection is present in browsers and
                // Node 22+; for older Node the customer is expected to inject
                // a factory (typically @roamhq/wrtc) via the option. A bare
                // `new undefined(...)` would throw with a cryptic TypeError;
                // pre-check so the customer sees what they need to do.
                const ctor = globalThis.RTCPeerConnection;
                if (typeof ctor !== "function") {
                    throw new Error("RTCPeerConnection is not available on globalThis. In Node, " +
                        "install @roamhq/wrtc and pass " +
                        "`rtcPeerConnectionFactory: (cfg) => new (require('@roamhq/wrtc').RTCPeerConnection)(cfg)`.");
                }
                return new ctor(config);
            });
        const config = {};
        if (opts.iceServers)
            config.iceServers = opts.iceServers;
        this.pc = factory(config);
        this.handlers = {
            negotiationneeded: this.onNegotiationNeeded,
            icecandidate: this.onLocalIceCandidate,
            track: this.onTrack,
            datachannel: this.onDataChannel,
            connectionstatechange: this.onConnectionStateChange,
            iceconnectionstatechange: this.onIceConnectionStateChange,
        };
        this.pc.addEventListener("negotiationneeded", this.handlers.negotiationneeded);
        this.pc.addEventListener("icecandidate", this.handlers.icecandidate);
        this.pc.addEventListener("track", this.handlers.track);
        this.pc.addEventListener("datachannel", this.handlers.datachannel);
        this.pc.addEventListener("connectionstatechange", this.handlers.connectionstatechange);
        this.pc.addEventListener("iceconnectionstatechange", this.handlers.iceconnectionstatechange);
    }
    get state() {
        return this._state;
    }
    /** Underlying PC for advanced callers (RemotePeer.pc escape hatch). */
    get peerConnection() {
        return this.pc;
    }
    /**
     * Hot-swap the ICE servers on a live connection. Typical caller:
     * MeteredPeer listening for `connected` welcomes with
     * refreshed iceServers and pushing them down to every active
     * PeerConnection. Calls into the underlying RTCPeerConnection.
     * setConfiguration which the W3C spec explicitly allows for the
     * iceServers field post-construction.
     *
     * No-op after close.
     */
    updateIceServers(iceServers) {
        if (this.closed)
            return;
        try {
            this.pc.setConfiguration({ iceServers });
        }
        catch (err) {
            // Scrub credential fields from the error in case setConfiguration
            // echoes back an offending iceServer entry.
            this.logger.warn?.("setConfiguration({iceServers}) threw", {
                peer: this.remotePeerId,
                err: err instanceof Error ? scrubSdpCredentials(err.message) : String(err),
            });
        }
    }
    /**
     * Proactively kick off an ICE restart — typically called when TURN
     * credentials rotate. Equivalent to the spec's
     * RTCPeerConnection.restartIce(): the next createOffer will use a
     * fresh ICE generation, picking up the new credentials applied via
     * updateIceServers.
     *
     * The wrapper's existing onIceConnectionStateChange ladder handles
     * retries / backoff if the restart itself fails. This entry point
     * resets the attempt counter so a proactive restart doesn't count
     * against a permanently-broken link's budget.
     *
     * No-op after close.
     */
    forceIceRestart() {
        if (this.closed)
            return;
        if (this.iceRestartInFlight || this.isMakingOffer) {
            this.logger.debug?.("forceIceRestart skipped — restart already in flight", {
                peer: this.remotePeerId,
            });
            return;
        }
        // Reset counter so a customer-initiated proactive restart starts
        // fresh, not on the curve of a previous failure window. Clear the
        // give-up latch too: a proactive restart re-arms the budget, so a
        // subsequent permanent failure must be able to emit its terminal
        // negotiation-error again (otherwise the latch would suppress it).
        this.iceRestartAttempt = 0;
        this.iceRestartGaveUp = false;
        // Modern RTCPeerConnection has restartIce() which sets a flag
        // and fires negotiationneeded — our existing handler then picks
        // up and sends the iceRestart offer through the ladder. Older
        // wrtc builds may lack it; fall back to triggering our own
        // restart path directly.
        const native = this.pc;
        if (typeof native.restartIce === "function") {
            native.restartIce();
            return;
        }
        this.iceRestartInFlight = true;
        void this.triggerIceRestart();
    }
    /**
     * Process an inbound SDP / ICE signal previously delivered by the
     * orchestrator via the SignallingClient's `direct` event. The
     * orchestrator filters by `isRtcSignal(data)` before calling.
     *
     * Errors during set*Description / addIceCandidate are caught and
     * surfaced via `negotiation-error` / `ice-candidate-error` so the
     * caller's `await handleSignal(...)` doesn't reject — one bad
     * inbound shouldn't throw out of an event dispatcher.
     */
    async handleSignal(signal) {
        if (this.closed)
            return;
        try {
            if (signal.type === "rtc-description") {
                await this.handleDescription(signal.description);
            }
            else if (signal.type === "rtc-ice") {
                await this.handleIce(signal.candidate);
            }
        }
        catch (err) {
            // scrubError strips SDP credential fields (ice-pwd, ice-ufrag,
            // credential) from message + stack so a customer's Sentry hook
            // doesn't ship TURN secrets to their error monitor.
            this.emit("negotiation-error", { err: scrubError(err) });
        }
    }
    /**
     * Close the underlying RTCPeerConnection, detach all listeners,
     * and transition to "closed". Idempotent — safe to call multiple
     * times. After close, handleSignal is a no-op.
     */
    close() {
        if (this.closed)
            return;
        this.closed = true;
        // Cancel any pending ICE-restart timers so we don't fire after
        // teardown.
        if (this.iceRestartTimer) {
            clearTimeout(this.iceRestartTimer);
            this.iceRestartTimer = null;
        }
        this.clearRestartAnswerTimer();
        this.pc.removeEventListener("negotiationneeded", this.handlers.negotiationneeded);
        this.pc.removeEventListener("icecandidate", this.handlers.icecandidate);
        this.pc.removeEventListener("track", this.handlers.track);
        this.pc.removeEventListener("datachannel", this.handlers.datachannel);
        this.pc.removeEventListener("connectionstatechange", this.handlers.connectionstatechange);
        this.pc.removeEventListener("iceconnectionstatechange", this.handlers.iceconnectionstatechange);
        try {
            this.pc.close();
        }
        catch (err) {
            this.logger.warn?.("RTCPeerConnection.close threw", {
                peer: this.remotePeerId,
                err: err instanceof Error ? scrubSdpCredentials(err.message) : String(err),
            });
        }
        this.setState("closed");
        this.removeAllListeners();
    }
    /**
     * Ship a local description over the signalling channel. Delivery
     * failures are NOT negotiation errors — the local negotiation state
     * machine is intact; the transport just couldn't carry the frame
     * (typically the signalling WS is mid-reconnect during a network
     * switch, when ICE failure is detected before the socket's own
     * liveness watchdog fires). Logged instead of emitted: surfacing a
     * customer-visible negotiation-error per ICE-restart attempt during
     * routine recovery would be indistinguishable from a real
     * negotiation failure. Recovery comes from the ICE ladder re-firing
     * once the transport is back, or from the signalling-level
     * reconcile replacing the connection outright.
     */
    async sendLocalDescription(local) {
        try {
            await this.signallingSender.send(this.remotePeerId, {
                type: "rtc-description",
                description: { type: local.type, sdp: local.sdp },
            });
        }
        catch (err) {
            this.logger.warn?.("failed to send local description", {
                peer: this.remotePeerId,
                descriptionType: local.type,
                err: scrubError(err).message,
            });
        }
    }
    /**
     * Advance the ladder by one attempt: immediate for the first,
     * exponential backoff after, terminal give-up past the budget.
     * Shared by the ICE-failed event path and the answer-timeout
     * watchdog — the watchdog exists because a restart offer whose
     * answer is lost parks ICE in "new" with no further state
     * transitions, which would otherwise strand the ladder mid-budget
     * and the give-up guarantee with it.
     */
    scheduleNextRestartAttempt() {
        if (this.iceRestartAttempt >= ICE_RESTART_MAX_ATTEMPTS) {
            // Permanent failure path — quit retrying. Customer's app code
            // sees a final negotiation-error and decides whether to close.
            // Latch so we emit exactly once: iceConnectionState can re-enter
            // "failed" many times on a dead link, but the documented contract
            // is a single terminal signal.
            if (!this.iceRestartGaveUp) {
                this.iceRestartGaveUp = true;
                const err = new Error(`ICE restart gave up after ${this.iceRestartAttempt} attempts`);
                // Stable name — the ONE terminal signal on this event.
                // Customers branch on err.name (message strings are not
                // contract) to tell "connection is dead, close and rebuild"
                // apart from transient negotiation noise.
                err.name = "IceRestartExhaustedError";
                this.emit("negotiation-error", { err });
            }
            return;
        }
        const attempt = this.iceRestartAttempt;
        this.iceRestartAttempt += 1;
        this.iceRestartInFlight = true;
        if (attempt === 0) {
            // First attempt fires immediately — the ladder only kicks in
            // for repeated failures within a window. Preserves the snappy
            // recovery customers expect when ICE briefly hiccups.
            this.logger.debug?.("ICE restart attempt 1 (immediate)", {
                peer: this.remotePeerId,
            });
            void this.triggerIceRestart();
            return;
        }
        const delayMs = Math.min(ICE_RESTART_BASE_DELAY_MS * 2 ** (attempt - 1), ICE_RESTART_MAX_DELAY_MS);
        this.logger.debug?.("scheduling ICE restart", {
            peer: this.remotePeerId,
            attempt: attempt + 1,
            delayMs,
        });
        const generationAtSchedule = this.remoteDescriptionGeneration;
        this.iceRestartTimer = setTimeout(() => {
            this.iceRestartTimer = null;
            if (this.closed)
                return;
            // The link recovered, or a remote description landed while we
            // waited (their restart taking over, or a late answer) — don't
            // disrupt the progressing negotiation with a redundant restart.
            // If THAT path fails again, the failed-event handler re-enters
            // the ladder. (Checked via recovery state + the description
            // generation rather than `!== "failed"`: the answer-timeout
            // path schedules attempts while ICE is parked in "new", which a
            // failed-only check would wrongly skip.)
            const ice = this.pc.iceConnectionState;
            if (ice === "connected" || ice === "completed") {
                this.iceRestartInFlight = false;
                return;
            }
            if (this.remoteDescriptionGeneration !== generationAtSchedule) {
                this.iceRestartInFlight = false;
                return;
            }
            void this.triggerIceRestart();
        }, delayMs);
    }
    /**
     * Arm the answer watchdog for a just-sent restart offer. On expiry
     * with no recovery and no remote description since the send, the
     * attempt counts as failed and the ladder advances (or gives up).
     */
    armRestartAnswerTimer() {
        this.clearRestartAnswerTimer();
        const generationAtSend = this.remoteDescriptionGeneration;
        this.iceRestartAnswerTimer = setTimeout(() => {
            this.iceRestartAnswerTimer = null;
            if (this.closed)
                return;
            const ice = this.pc.iceConnectionState;
            if (ice === "connected" || ice === "completed")
                return;
            // A remote description landed since the send — negotiation is
            // progressing; the failed-event path re-drives if it fails.
            if (this.remoteDescriptionGeneration !== generationAtSend)
                return;
            if (this.isMakingOffer) {
                // Another local offer is mid-flight; acting now would corrupt
                // the collision signal. Keep the watchdog alive — the offer
                // settles in milliseconds, the next expiry acts.
                this.armRestartAnswerTimer();
                return;
            }
            this.logger.debug?.("ICE-restart answer timeout — advancing the ladder", {
                peer: this.remotePeerId,
                attempt: this.iceRestartAttempt,
            });
            this.iceRestartInFlight = false;
            this.scheduleNextRestartAttempt();
        }, ICE_RESTART_ANSWER_TIMEOUT_MS);
    }
    clearRestartAnswerTimer() {
        if (this.iceRestartAnswerTimer !== null) {
            clearTimeout(this.iceRestartAnswerTimer);
            this.iceRestartAnswerTimer = null;
        }
    }
    async triggerIceRestart() {
        // Serialize against any other in-flight local offer — two
        // concurrent local offers would corrupt the isMakingOffer
        // collision signal that perfect negotiation depends on. Checked
        // BEFORE the try so the finally below can't clear the OTHER
        // offer's flag. That offer's own finally re-enters the ladder
        // once it settles, picking this restart back up.
        if (this.isMakingOffer) {
            this.iceRestartInFlight = false;
            return;
        }
        // Likewise while a remote offer is being applied or answered: an
        // offer created now would run in "have-remote-offer", which some
        // engines reject outright. Answering that offer may restart ICE by
        // itself; handleDescription re-enters the ladder once it settles.
        if (this.remoteOffersInProgress > 0) {
            this.iceRestartInFlight = false;
            return;
        }
        // Our answer to a remote offer failed to apply, leaving the
        // connection in "have-remote-offer" with nothing left to answer it:
        // no offer can be made. Spend the attempt without one so the ladder
        // still runs on to its terminal give-up.
        if (this.pc.signalingState === "have-remote-offer") {
            this.iceRestartInFlight = false;
            this.reenterLadderIfStillFailed();
            return;
        }
        try {
            this.isMakingOffer = true;
            const generation = this.remoteDescriptionGeneration;
            const offer = await this.pc.createOffer({ iceRestart: true });
            if (this.closed)
                return;
            // Glare: a remote description was applied while createOffer was
            // in flight — typically the remote's own restart offer during a
            // symmetric failure (both sides' relay allocations died
            // together). Answering theirs restarts ICE just as well; our
            // stale offer is abandoned and the ladder re-enters if the link
            // is still down afterwards. The generation counter catches the
            // applied-AND-answered interleaving where signalingState already
            // settled back to "stable". ("have-local-offer" — our previous
            // restart offer still unanswered, e.g. the answer was lost —
            // is NOT a collision: the fresh restart offer legally replaces
            // the pending one, which is exactly how the ladder keeps
            // retrying an undelivered restart.)
            if (this.remoteDescriptionGeneration !== generation || this.isRemoteOfferInProgress()) {
                this.logger.debug?.("abandoning ICE-restart offer — remote description applied or pending mid-createOffer", { peer: this.remotePeerId, signalingState: this.pc.signalingState });
                this.iceRestartInFlight = false;
                return;
            }
            await this.pc.setLocalDescription(offer);
            if (this.closed)
                return;
            // New negotiation generation begins here on the local side
            //. handleDescription resets this on
            // the inbound path; for local-initiated restarts the reset
            // belongs here so the per-generation cap applies fresh to any
            // remote candidates that trickle in while we wait for the answer.
            this.candidatesThisGeneration = 0;
            this.candidateCapWarned = false;
            const local = this.pc.localDescription;
            if (!local) {
                throw new Error("ICE restart: setLocalDescription succeeded but localDescription is null");
            }
            // Final closed-check before the signalling-bound send — close()
            // may have run while we were mid-await. A transport-level send
            // failure is logged, not emitted (see sendLocalDescription) —
            // the restarted ICE agent will fail again and re-enter the
            // ladder, and by then the signalling WS may be back.
            if (this.closed)
                return;
            await this.sendLocalDescription(local);
            // Offer is out (or dropped by a dead transport — same outcome
            // from here): if no answer lands within the window, ICE parks
            // in "new" and only this watchdog keeps the ladder moving.
            this.armRestartAnswerTimer();
        }
        catch (err) {
            if (this.closed)
                return;
            // Restart failed (createOffer / setLocalDescription) — clear
            // the in-flight guard so a subsequent state event can re-enter
            // the ladder. The attempt counter stays incremented so the
            // backoff curves through this failure too.
            this.iceRestartInFlight = false;
            this.emit("negotiation-error", { err: scrubError(err) });
        }
        finally {
            this.isMakingOffer = false;
            // Covers the abandoned-offer and failed-restart paths: ICE can
            // sit at "failed" with no further state transitions, so nothing
            // else would re-trigger the ladder. No-op when ICE is healthy
            // or a restart is already in flight / scheduled.
            this.reenterLadderIfStillFailed();
        }
    }
    /**
     * Re-enter the restart ladder on the next tick if ICE is still
     * failed. Needed after an offer settles while ICE sits at "failed"
     * (abandoned restart, glare, or a failure that arrived while the
     * offer held the isMakingOffer lock): iceconnectionstatechange only
     * fires on transitions, so a link that STAYS failed would otherwise
     * never re-trigger the ladder. Deferred a tick so it runs after the
     * calling offer's `finally` has cleared isMakingOffer; the ladder's
     * own guards (in-flight, scheduled timer, attempt budget) make a
     * redundant re-entry a no-op.
     */
    reenterLadderIfStillFailed() {
        setTimeout(() => {
            if (this.closed)
                return;
            if (this.pc.iceConnectionState !== "failed")
                return;
            this.onIceConnectionStateChange(undefined);
        }, 0);
    }
    /**
     * True while a remote offer is being applied or answered, or has been
     * applied without an answer. A local offer created then is stale and
     * cannot be applied.
     */
    isRemoteOfferInProgress() {
        return this.remoteOffersInProgress > 0 || this.pc.signalingState === "have-remote-offer";
    }
    // ---------- SDP / ICE handlers ----------
    async handleDescription(description) {
        // Perfect-negotiation collision check: another offer arrived while
        // we have a local offer in flight (or are mid-creating one). The
        // impolite peer ignores; the polite peer rolls back its own offer
        // by accepting setRemoteDescription unconditionally (which
        // implicitly rolls back per WebRTC spec).
        //
        // isSettingRemoteAnswerPending (per the W3C reference pattern):
        // while a remote ANSWER is mid-application, signalingState still
        // reads "have-local-offer" — but an offer queued behind that
        // answer is NOT a collision, because the operations chain applies
        // the answer first and the offer lands on a stable connection.
        // Without this, the impolite peer drops a legitimate
        // renegotiation that the remote sent right after answering.
        const offerCollision = description.type === "offer" &&
            (this.isMakingOffer ||
                (this.pc.signalingState !== "stable" &&
                    !this.isSettingRemoteAnswerPending));
        this.ignoreOffer = !this.polite && offerCollision;
        if (this.ignoreOffer) {
            this.logger.debug?.("ignoring offer due to collision (impolite peer)", {
                peer: this.remotePeerId,
                signalingState: this.pc.signalingState,
                isMakingOffer: this.isMakingOffer,
            });
            return;
        }
        const isOffer = description.type === "offer";
        this.isSettingRemoteAnswerPending = description.type === "answer";
        if (isOffer)
            this.remoteOffersInProgress += 1;
        let local = null;
        try {
            try {
                await this.pc.setRemoteDescription(description);
            }
            finally {
                this.isSettingRemoteAnswerPending = false;
            }
            // close() may have run while we awaited — re-check before we
            // touch more state.
            if (this.closed)
                return;
            // New negotiation generation — reset the inbound-candidate
            // counter so the cap applies fresh per cycle, and invalidate any
            // local offer currently mid-createOffer (it predates this remote
            // description and must be abandoned, not applied).
            this.candidatesThisGeneration = 0;
            this.candidateCapWarned = false;
            this.remoteDescriptionGeneration += 1;
            // A remote description arrived — the restart-answer watchdog's
            // wait is over (its generation check would no-op anyway; clearing
            // avoids the stray wakeup).
            this.clearRestartAnswerTimer();
            if (isOffer) {
                const answer = await this.pc.createAnswer();
                if (this.closed)
                    return;
                await this.pc.setLocalDescription(answer);
                if (this.closed)
                    return;
                local = this.pc.localDescription;
                if (!local) {
                    throw new Error("setLocalDescription(answer) succeeded but localDescription is null");
                }
            }
        }
        finally {
            if (isOffer) {
                this.remoteOffersInProgress -= 1;
                // An ICE restart that came due while this offer was being
                // applied or answered was deferred (see triggerIceRestart).
                // Re-check the ladder now, without waiting on the answer's send;
                // it reschedules with the usual backoff.
                this.reenterLadderIfStillFailed();
            }
        }
        // Transport failure on the answer is logged, not thrown (see
        // sendLocalDescription) — the remote re-offers / ICE-fails and
        // retries through its own ladder if the answer never lands.
        if (local)
            await this.sendLocalDescription(local);
    }
    async handleIce(candidate) {
        // null is the end-of-candidates marker — always cheap, doesn't
        // count toward the cap.
        if (candidate !== null) {
            // Per-string length cap. Real candidates are
            // typically <200 chars; 1000 is generous. A grossly oversized
            // string is dropped silently — emitting a per-candidate error
            // would itself be a DoS amplifier.
            const candStr = candidate.candidate;
            if (typeof candStr === "string" && candStr.length > MAX_ICE_CANDIDATE_STRING) {
                this.logger.warn?.("dropping oversized inbound ICE candidate", {
                    peer: this.remotePeerId,
                    size: candStr.length,
                    cap: MAX_ICE_CANDIDATE_STRING,
                });
                return;
            }
            // Per-generation count cap. The first overflow
            // logs once; subsequent overflows in the same generation drop
            // silently to avoid flooding the customer's logger too.
            if (this.candidatesThisGeneration >= MAX_ICE_CANDIDATES_PER_GENERATION) {
                if (!this.candidateCapWarned) {
                    this.candidateCapWarned = true;
                    this.logger.warn?.("inbound ICE candidate cap reached", {
                        peer: this.remotePeerId,
                        cap: MAX_ICE_CANDIDATES_PER_GENERATION,
                    });
                }
                return;
            }
            this.candidatesThisGeneration += 1;
        }
        try {
            await this.pc.addIceCandidate(candidate ?? undefined);
        }
        catch (err) {
            // close() may have run while we awaited — don't emit through
            // a now-detached EventEmitter.
            if (this.closed)
                return;
            // Candidate add failures during a collision are expected (the
            // remote description we ignored isn't there yet). Surface only
            // when not in the ignore window so debug noise stays low.
            if (!this.ignoreOffer) {
                this.emit("ice-candidate-error", { err: scrubError(err) });
            }
        }
    }
    // ---------- State transition ----------
    setState(next) {
        if (next === this._state)
            return;
        const from = this._state;
        this._state = next;
        this.emit("state-change", { from, to: next });
    }
}
/**
 * Fallback for implementations whose RTCIceCandidate lacks a usable
 * toJSON() — Node's `wrtc` historically returns one but not always
 * the four fields the wire format needs. Plucking explicitly keeps
 * the wire payload stable across implementations.
 */
function toCandidateInit(c) {
    return {
        candidate: c.candidate,
        sdpMid: c.sdpMid ?? null,
        sdpMLineIndex: c.sdpMLineIndex ?? null,
        usernameFragment: c.usernameFragment ?? null,
    };
}

// RemotePeer — the per-remote-peer object the customer interacts with.
//
// Each MeteredPeer holds a Map<peerId, RemotePeer>. A RemotePeer
// wraps the underlying PeerConnection plus the metadata the server
// stamped on the JWT.
//
// Public surface:
//   readonly id, metadata
//   readonly state (mirrors PeerConnection.state, with reconcile filter)
//   readonly polite (perfect-negotiation tie-break flag)
//   send(data)  — shorthand for `peer.sendTo(remote.id, data)`
//   state-change / negotiation-error / ice-candidate-error / track /
//   data-channel / stream-added / stream-removed events
//   escape hatch: `pc` (underlying RTCPeerConnectionLike)
//
// The PeerConnection wrapper itself is held in an ES-private field
// (#connection) so customer code can't forge SDP / ICE by calling
// connection.handleSignal directly. MeteredPeer reaches it via the
// `_handleSignal` bridge below.
var _RemotePeer_instances, _RemotePeer_connection, _RemotePeer_sendImpl, _RemotePeer_state, _RemotePeer_trackMetadata, _RemotePeer_streamLiveTracks, _RemotePeer_streamRef, _RemotePeer_trackEndedListeners, _RemotePeer_streamRemoveTrackListeners, _RemotePeer_forwardStateChange, _RemotePeer_setState, _RemotePeer_forwardNegotiationError, _RemotePeer_forwardIceCandidateError, _RemotePeer_forwardTrack, _RemotePeer_lookupTrackMetadata, _RemotePeer_ensureRemoveTrackListener, _RemotePeer_dropTrackFromStream, _RemotePeer_detachRemoveTrackListener, _RemotePeer_detachAllRemoveTrackListeners, _RemotePeer_forwardDataChannel, _RemotePeer_attachConnectionListeners, _RemotePeer_detachConnectionListeners;
/**
 * Cap on the per-RemotePeer #trackMetadata cache. A hostile or
 * compromised remote can fire __meteredTrackMeta control messages
 * with unique trackIds forever, growing the cache unboundedly. 512
 * is comfortably above any realistic per-peer track count (typical
 * apps are 1-10) but low enough that an adversary can't pin
 * meaningful memory.
 *
 * Eviction is FIFO via Map insertion order; the oldest entry is
 * evicted on overflow.
 */
const MAX_TRACK_METADATA_ENTRIES = 512;
class RemotePeer extends EventEmitter {
    constructor(init) {
        super();
        _RemotePeer_instances.add(this);
        // ES private — out of reach for JSON.stringify, for..in, and any
        // customer code attempting to forge handleSignal calls. MeteredPeer
        // reaches handleSignal via the `_handleSignal` bridge below.
        //
        // Mutable: reconcile swaps in a fresh PC on the local
        // side's WS reconnect, preserving the RemotePeer instance identity
        // for surviving customer refs.
        _RemotePeer_connection.set(this, void 0);
        // Reassigned to a rejector in _close() so a customer-held stale ref
        // can't ship send frames at a peerId the server might have reused
        // for a different session.
        _RemotePeer_sendImpl.set(this, void 0);
        // Tracked independently of #connection.state so MeteredPeer can
        // override it during reconcile (e.g., "connected → reconnecting"
        // on WS drop, before any PC state-change has fired). The
        // forwardStateChange listener filters the new PC's initial
        // "connecting" hop while we're at "reconnecting" so customers
        // see option-B state flicker:  connected → reconnecting → connected.
        _RemotePeer_state.set(this, "idle");
        // Per-track metadata received from the sender via the reserved-key
        // signalling control message, keyed by the SENDER's
        // MediaStreamTrack.id. MeteredPeer.onDirect intercepts the control
        // message and calls _setTrackMetadata; #lookupTrackMetadata reads
        // from this map at track-event time. The remote track's own id only
        // matches the key on Chromium receivers, hence the streamId + kind
        // carried alongside (see #lookupTrackMetadata).
        _RemotePeer_trackMetadata.set(this, new Map());
        // Per-stream lifecycle accounting for stream-added / stream-removed
        // events. `#streamLiveTracks` is keyed by stream.id (NOT MediaStream
        // ref) so reconcile — which gives us a brand-new MediaStream object
        // with the same id — doesn't reset the accounting prematurely.
        //
        // The current MediaStream ref is stashed in `#streamRef` for the
        // stream-removed event payload (we surface the same MediaStream the
        // customer received in the matching stream-added).
        _RemotePeer_streamLiveTracks.set(this, new Map());
        _RemotePeer_streamRef.set(this, new Map());
        // Per-track ended listeners. Kept so we can detach them on _close()
        // and not leak listeners against tracks that outlive the RemotePeer
        // (e.g., a track held by the customer in a <video> element after
        // the RemotePeer was torn down).
        _RemotePeer_trackEndedListeners.set(this, new Map());
        // Per-stream `removetrack` listeners — the signal real
        // (unified-plan) browsers fire when the SENDER removes a track:
        // the receiver-side track goes muted, NOT ended, so stream-removed
        // accounting cannot ride on `ended` alone. Keyed by stream.id; the
        // value pins the exact MediaStream OBJECT we listened to (reconcile
        // surfaces a new object with the same id, and the listener must
        // follow the object).
        _RemotePeer_streamRemoveTrackListeners.set(this, new Map());
        // Cached forwarders so we can detach the SAME refs in _close().
        // EventEmitter.off matches by handler identity; closure-fresh
        // arrow functions per call wouldn't pair.
        _RemotePeer_forwardStateChange.set(this, (ev) => {
            // State-flicker option B: when we're
            // mid-reconcile (RemotePeer state was manually set to
            // "reconnecting" by MeteredPeer before swapping the PC), filter
            // the new PC's intermediate "connecting" hop so the customer
            // sees:  connected → reconnecting → connected
            // instead of:
            //         connected → reconnecting → connecting → connected.
            //
            // Once the new PC reaches "connected" the filter stops applying
            // and subsequent ICE failures / states flow through normally.
            if (__classPrivateFieldGet(this, _RemotePeer_state, "f") === "reconnecting" && ev.to === "connecting") {
                return;
            }
            __classPrivateFieldGet(this, _RemotePeer_instances, "m", _RemotePeer_setState).call(this, ev.to);
        });
        _RemotePeer_forwardNegotiationError.set(this, (ev) => {
            this.emit("negotiation-error", ev);
        });
        _RemotePeer_forwardIceCandidateError.set(this, (ev) => {
            this.emit("ice-candidate-error", ev);
        });
        _RemotePeer_forwardTrack.set(this, (ev) => {
            // Look up per-track metadata (stashed by MeteredPeer.onDirect's
            // isTrackMetaMessage filter, which fires BEFORE the SDP offer
            // carrying this track lands on the wire — both go via the
            // single TCP-ordered signalling WS).
            const metadata = __classPrivateFieldGet(this, _RemotePeer_instances, "m", _RemotePeer_lookupTrackMetadata).call(this, ev);
            // Emit the per-track event first — fine-grained subscribers see
            // every track. Includes metadata so customers using only `track`
            // events still get the per-track data.
            this.emit("track", {
                track: ev.track,
                streams: ev.streams,
                ...(metadata !== undefined ? { metadata } : {}),
            });
            // Per-stream accounting for stream-added / stream-removed events.
            for (const stream of ev.streams) {
                const wasSeen = __classPrivateFieldGet(this, _RemotePeer_streamLiveTracks, "f").has(stream.id);
                let liveTracks = __classPrivateFieldGet(this, _RemotePeer_streamLiveTracks, "f").get(stream.id);
                if (!liveTracks) {
                    liveTracks = new Set();
                    __classPrivateFieldGet(this, _RemotePeer_streamLiveTracks, "f").set(stream.id, liveTracks);
                }
                liveTracks.add(ev.track);
                // Always update the stashed ref — across reconcile the
                // MediaStream OBJECT differs from the prior one (the old PC
                // was torn down), so a customer who bound the OLD ref to
                // <video>.srcObject would have a stalled element. Stashing the
                // fresh ref so stream-removed surfaces what's actually live.
                __classPrivateFieldGet(this, _RemotePeer_streamRef, "f").set(stream.id, stream);
                __classPrivateFieldGet(this, _RemotePeer_instances, "m", _RemotePeer_ensureRemoveTrackListener).call(this, stream);
                if (!wasSeen) {
                    this.emit("stream-added", {
                        stream,
                        ...(metadata !== undefined ? { metadata } : {}),
                    });
                }
            }
            // Wire onended for the transceiver-stop / connection-close cases.
            // Sender-side removeTrack does NOT end the receiver track in
            // unified-plan browsers — the track goes muted and the stream
            // fires `removetrack`, which #ensureRemoveTrackListener handles —
            // so both signals converge on the same idempotent accounting in
            // #dropTrackFromStream. Reconcile clears #streamLiveTracks (in
            // _setConnection below) so handlers firing after the swap no-op.
            const onEnded = () => {
                for (const stream of ev.streams) {
                    __classPrivateFieldGet(this, _RemotePeer_instances, "m", _RemotePeer_dropTrackFromStream).call(this, stream.id, ev.track, stream);
                }
                __classPrivateFieldGet(this, _RemotePeer_trackEndedListeners, "f").delete(ev.track);
            };
            // One listener per track — a re-fired track event for the same
            // track (renegotiation toggling a transceiver direction) must not
            // stack a second listener that the cleanup maps can't pair.
            if (!__classPrivateFieldGet(this, _RemotePeer_trackEndedListeners, "f").has(ev.track)) {
                ev.track.addEventListener("ended", onEnded);
                __classPrivateFieldGet(this, _RemotePeer_trackEndedListeners, "f").set(ev.track, onEnded);
            }
        });
        _RemotePeer_forwardDataChannel.set(this, (ev) => {
            this.emit("data-channel", ev);
        });
        this.id = init.id;
        this.metadata = init.metadata;
        __classPrivateFieldSet(this, _RemotePeer_connection, init.connection, "f");
        __classPrivateFieldSet(this, _RemotePeer_sendImpl, init.send, "f");
        // Mirror the initial connection state — usually "idle" at
        // construction time. Subsequent state changes come through the
        // forwarder.
        __classPrivateFieldSet(this, _RemotePeer_state, __classPrivateFieldGet(this, _RemotePeer_connection, "f").state, "f");
        __classPrivateFieldGet(this, _RemotePeer_instances, "m", _RemotePeer_attachConnectionListeners).call(this);
    }
    get state() {
        return __classPrivateFieldGet(this, _RemotePeer_state, "f");
    }
    /** Perfect-negotiation politeness flag. Exposed for introspection / tests. */
    get polite() {
        return __classPrivateFieldGet(this, _RemotePeer_connection, "f").polite;
    }
    /**
     * Escape hatch — the underlying RTCPeerConnectionLike. For advanced
     * callers needing `getStats()`, custom event listeners, or other
     * low-level access. NOTE: mutating its configuration via
     * `setConfiguration()` bypasses MeteredPeer's iceServer validation;
     * only do that if you really need to.
     */
    get pc() {
        return __classPrivateFieldGet(this, _RemotePeer_connection, "f").peerConnection;
    }
    /**
     * Send `data` directly to this peer (server-routed via the
     * signalling channel's `send` frame). Rejects with the underlying
     * error if the signalling socket isn't connected or the server
     * rejects the request. Shorthand for `peer.send(remote.id, data)`.
     *
     * After `_close()`, this rejects with "RemotePeer is closed" so
     * a stale ref held by customer code can't ship frames at a
     * potentially-reused peerId.
     */
    send(data) {
        return __classPrivateFieldGet(this, _RemotePeer_sendImpl, "f").call(this, data);
    }
    /**
     * Toggle JSON.stringify-safety. The default toJSON on EventEmitter
     * would still expose nothing useful, but pinning this here makes
     * the intent loud and means a future refactor can't accidentally
     * leak the connection / sendImpl bag.
     */
    toJSON() {
        return { id: this.id, state: this.state };
    }
    // ---------- @internal — MeteredPeer collaborators ----------
    /**
     * @internal — MeteredPeer routes inbound RTC signals from `direct`
     * events through this bridge. Kept off the public surface so
     * customer code can't inject forged SDP / ICE candidates.
     */
    _handleSignal(signal) {
        return __classPrivateFieldGet(this, _RemotePeer_connection, "f").handleSignal(signal);
    }
    /**
     * @internal — reconcile entry. MeteredPeer drives the
     * RemotePeer state directly when the local-side WS reconnect cycle
     * needs explicit transitions the underlying PC can't generate
     * (specifically: "connected → reconnecting" on WS drop, before
     * any PC state change has fired).
     */
    _setState(next) {
        __classPrivateFieldGet(this, _RemotePeer_instances, "m", _RemotePeer_setState).call(this, next);
    }
    /**
     * @internal — reconcile entry. Refresh metadata from
     * the post-reconnect snapshot. If a peer's peerMetadata claim
     * changed during the disconnect window (e.g., they updated their
     * display name on their own backend), the reconcile snapshot
     * carries the new metadata and the survivor's RemotePeer needs
     * to reflect it.
     *
     * The public `metadata` field is documented as readonly to
     * customer code; the cast here is intentional and contained.
     */
    _setMetadata(metadata) {
        this.metadata = metadata;
    }
    /**
     * @internal — reconcile entry. Swaps the underlying
     * PeerConnection without firing peer-left / peer-joined. Detaches
     * all listeners from the old PC, closes it, swaps in `newConn`,
     * and re-attaches listeners. Does NOT reset RemotePeer.state —
     * the caller controls the transition (typically: customer is
     * already at "reconnecting"; new PC's events drive the eventual
     * "connected" transition, with the option-B filter dropping the
     * intermediate "connecting" hop).
     *
     * Idempotent against repeat swaps: a second call closes the
     * second-old PC and rewires to the new one.
     *
     * Throws if called after _close(). Unreachable in current
     * MeteredPeer code (swapPeerConnection only iterates this.peers,
     * which removePeer empties before _close fires), but defensive
     * against future refactors that might race a swap with a close.
     */
    _setConnection(newConn) {
        if (__classPrivateFieldGet(this, _RemotePeer_state, "f") === "closed") {
            throw new Error(`RemotePeer ${this.id} is closed — cannot swap connection`);
        }
        __classPrivateFieldGet(this, _RemotePeer_instances, "m", _RemotePeer_detachConnectionListeners).call(this);
        __classPrivateFieldGet(this, _RemotePeer_connection, "f").close();
        // Closing the old PC ends its inbound tracks → fires onended for
        // each. We DON'T want those to fire stream-removed during a
        // reconcile (the customer's perception should be "stream still
        // there, just on a refreshed PC"). Clearing #streamLiveTracks
        // before the close events fire neutralizes those handlers: the
        // onended callback looks up an empty map and exits without
        // emitting stream-removed.
        //
        // The new PC's track events will repopulate the map with fresh
        // MediaStream refs (same stream.id, new object identity) and
        // fire stream-added on the FIRST track per stream (the
        // wasSeen-check in #forwardTrack — `wasSeen` is now false
        // because we just cleared the map).
        __classPrivateFieldGet(this, _RemotePeer_streamLiveTracks, "f").clear();
        __classPrivateFieldGet(this, _RemotePeer_streamRef, "f").clear();
        // Same suppression applies to the old streams' removetrack
        // listeners — detach so a late event from the torn-down PC's
        // streams can't fire (and so we don't pin the old objects).
        __classPrivateFieldGet(this, _RemotePeer_instances, "m", _RemotePeer_detachAllRemoveTrackListeners).call(this);
        // Track-ended listeners on the old PC's tracks: the underlying
        // MediaStreamTracks are about to go to "ended" and the listeners
        // will fire, but they no-op because the live-tracks map is
        // empty. Best-effort detach anyway so we don't keep references
        // alive past the swap.
        for (const [track, listener] of __classPrivateFieldGet(this, _RemotePeer_trackEndedListeners, "f")) {
            try {
                track.removeEventListener("ended", listener);
            }
            catch {
                // Some test rigs / older browsers may throw on a track
                // already in "ended" state. Silent — the listener wouldn't
                // fire again anyway.
            }
        }
        __classPrivateFieldGet(this, _RemotePeer_trackEndedListeners, "f").clear();
        // DON'T clear #trackMetadata. Reconcile can be asymmetric:
        // if only the RECEIVER's WS drops, the SENDER doesn't know to
        // re-send metadata. Clearing here would lose it. Entries are keyed
        // by the sender's track id and carry its stream id, neither of
        // which changes across PC swaps, so old entries stay valid; they
        // get overwritten in-place when the sender DOES re-send (the
        // symmetric-drop case). For genuinely-removed
        // tracks the sender sends a clear-message at removeTrack time,
        // which arrives independently of any reconcile.
        __classPrivateFieldSet(this, _RemotePeer_connection, newConn, "f");
        __classPrivateFieldGet(this, _RemotePeer_instances, "m", _RemotePeer_attachConnectionListeners).call(this);
        // Surface the swap AFTER listeners are re-attached: a handler
        // that immediately calls `remote.pc.createDataChannel(...)`
        // negotiates on the new connection and its data-channel /
        // state-change events flow back through this RemotePeer. This is
        // the only negotiation-independent signal a data-channel-only app
        // has — with no tracks attached, the swapped-in PC stays dormant
        // until the app creates something on it.
        this.emit("connection-reset", {});
    }
    /**
     * @internal — multi-stream metadata entry. MeteredPeer's
     * onDirect filter routes inbound `__meteredTrackMeta` control
     * messages through this bridge. The metadata is stashed by the
     * sender's track id (with its stream id + kind, when sent) and read
     * by #forwardTrack at track-event time.
     *
     * Pass `undefined` to clear an entry (sender called removeTrack).
     */
    _setTrackMetadata(trackId, metadata, streamId, kind) {
        if (metadata === undefined) {
            __classPrivateFieldGet(this, _RemotePeer_trackMetadata, "f").delete(trackId);
            return;
        }
        // Bounded cache. If we're at the cap AND this is a new
        // trackId (i.e., not an in-place update), evict the oldest entry
        // before inserting. Map insertion order is the FIFO queue. Update-
        // in-place doesn't grow the cache so it's exempt.
        if (!__classPrivateFieldGet(this, _RemotePeer_trackMetadata, "f").has(trackId) &&
            __classPrivateFieldGet(this, _RemotePeer_trackMetadata, "f").size >= MAX_TRACK_METADATA_ENTRIES) {
            const oldestKey = __classPrivateFieldGet(this, _RemotePeer_trackMetadata, "f").keys().next().value;
            if (oldestKey !== undefined)
                __classPrivateFieldGet(this, _RemotePeer_trackMetadata, "f").delete(oldestKey);
        }
        __classPrivateFieldGet(this, _RemotePeer_trackMetadata, "f").set(trackId, {
            metadata,
            ...(streamId !== undefined ? { streamId } : {}),
            ...(kind !== undefined ? { kind } : {}),
        });
    }
    /**
     * @internal — MeteredPeer calls this from its peer-left handler /
     * disconnect path. PeerConnection.close is idempotent so doing it
     * twice is safe.
     */
    _close() {
        __classPrivateFieldGet(this, _RemotePeer_instances, "m", _RemotePeer_detachConnectionListeners).call(this);
        __classPrivateFieldGet(this, _RemotePeer_connection, "f").close();
        // Detach per-track ended listeners. The tracks are about to end
        // (PC close) and the listeners would fire after we've already
        // removed our own listeners — they'd no-op because the live
        // tracks map is empty, but cleanup keeps the GC honest.
        for (const [track, listener] of __classPrivateFieldGet(this, _RemotePeer_trackEndedListeners, "f")) {
            try {
                track.removeEventListener("ended", listener);
            }
            catch {
                // ignore (see _setConnection's matching cleanup)
            }
        }
        __classPrivateFieldGet(this, _RemotePeer_trackEndedListeners, "f").clear();
        __classPrivateFieldGet(this, _RemotePeer_instances, "m", _RemotePeer_detachAllRemoveTrackListeners).call(this);
        __classPrivateFieldGet(this, _RemotePeer_streamLiveTracks, "f").clear();
        __classPrivateFieldGet(this, _RemotePeer_streamRef, "f").clear();
        __classPrivateFieldGet(this, _RemotePeer_trackMetadata, "f").clear();
        __classPrivateFieldGet(this, _RemotePeer_instances, "m", _RemotePeer_setState).call(this, "closed");
        // After close, any further send attempts from a customer-held
        // stale ref get a typed rejection instead of silently shipping
        // to a server that may have reassigned the peerId to a different
        // session.
        __classPrivateFieldSet(this, _RemotePeer_sendImpl, () => Promise.reject(new Error(`RemotePeer ${this.id} is closed`)), "f");
        this.removeAllListeners();
    }
}
_RemotePeer_connection = new WeakMap(), _RemotePeer_sendImpl = new WeakMap(), _RemotePeer_state = new WeakMap(), _RemotePeer_trackMetadata = new WeakMap(), _RemotePeer_streamLiveTracks = new WeakMap(), _RemotePeer_streamRef = new WeakMap(), _RemotePeer_trackEndedListeners = new WeakMap(), _RemotePeer_streamRemoveTrackListeners = new WeakMap(), _RemotePeer_forwardStateChange = new WeakMap(), _RemotePeer_forwardNegotiationError = new WeakMap(), _RemotePeer_forwardIceCandidateError = new WeakMap(), _RemotePeer_forwardTrack = new WeakMap(), _RemotePeer_forwardDataChannel = new WeakMap(), _RemotePeer_instances = new WeakSet(), _RemotePeer_setState = function _RemotePeer_setState(next) {
    if (next === __classPrivateFieldGet(this, _RemotePeer_state, "f"))
        return;
    const from = __classPrivateFieldGet(this, _RemotePeer_state, "f");
    __classPrivateFieldSet(this, _RemotePeer_state, next, "f");
    this.emit("state-change", { from, to: next });
}, _RemotePeer_lookupTrackMetadata = function _RemotePeer_lookupTrackMetadata(ev) {
    const direct = (ev.msidTrackId !== undefined
        ? __classPrivateFieldGet(this, _RemotePeer_trackMetadata, "f").get(ev.msidTrackId)
        : undefined) ?? __classPrivateFieldGet(this, _RemotePeer_trackMetadata, "f").get(ev.track.id);
    if (direct !== undefined)
        return direct.metadata;
    if (ev.streams.length === 0)
        return undefined;
    let match;
    let matchJson;
    for (const [trackId, entry] of __classPrivateFieldGet(this, _RemotePeer_trackMetadata, "f")) {
        if (entry.kind !== ev.track.kind ||
            entry.streamId === undefined ||
            ev.msidTrackIds?.has(trackId) === true ||
            !ev.streams.some((s) => s.id === entry.streamId)) {
            continue;
        }
        const json = JSON.stringify(entry.metadata);
        if (matchJson === undefined) {
            match = entry.metadata;
            matchJson = json;
        }
        else if (json !== matchJson) {
            return undefined;
        }
    }
    return match;
}, _RemotePeer_ensureRemoveTrackListener = function _RemotePeer_ensureRemoveTrackListener(stream) {
    const existing = __classPrivateFieldGet(this, _RemotePeer_streamRemoveTrackListeners, "f").get(stream.id);
    if (existing?.stream === stream)
        return; // already wired to this object
    if (existing)
        __classPrivateFieldGet(this, _RemotePeer_instances, "m", _RemotePeer_detachRemoveTrackListener).call(this, stream.id);
    if (typeof stream.addEventListener !== "function")
        return;
    const listener = (ev) => {
        const track = ev.track;
        if (!track)
            return;
        __classPrivateFieldGet(this, _RemotePeer_instances, "m", _RemotePeer_dropTrackFromStream).call(this, stream.id, track, stream);
    };
    stream.addEventListener("removetrack", listener);
    __classPrivateFieldGet(this, _RemotePeer_streamRemoveTrackListeners, "f").set(stream.id, { stream, listener });
}, _RemotePeer_dropTrackFromStream = function _RemotePeer_dropTrackFromStream(streamId, track, fallbackRef) {
    const liveTracks = __classPrivateFieldGet(this, _RemotePeer_streamLiveTracks, "f").get(streamId);
    if (!liveTracks)
        return; // cleared by reconcile / close — drop
    liveTracks.delete(track);
    if (liveTracks.size === 0) {
        __classPrivateFieldGet(this, _RemotePeer_streamLiveTracks, "f").delete(streamId);
        const ref = __classPrivateFieldGet(this, _RemotePeer_streamRef, "f").get(streamId) ?? fallbackRef;
        __classPrivateFieldGet(this, _RemotePeer_streamRef, "f").delete(streamId);
        __classPrivateFieldGet(this, _RemotePeer_instances, "m", _RemotePeer_detachRemoveTrackListener).call(this, streamId);
        this.emit("stream-removed", { stream: ref });
    }
}, _RemotePeer_detachRemoveTrackListener = function _RemotePeer_detachRemoveTrackListener(streamId) {
    const entry = __classPrivateFieldGet(this, _RemotePeer_streamRemoveTrackListeners, "f").get(streamId);
    if (!entry)
        return;
    __classPrivateFieldGet(this, _RemotePeer_streamRemoveTrackListeners, "f").delete(streamId);
    try {
        entry.stream.removeEventListener("removetrack", entry.listener);
    }
    catch {
        /* defensive — torn-down streams / minimal fakes */
    }
}, _RemotePeer_detachAllRemoveTrackListeners = function _RemotePeer_detachAllRemoveTrackListeners() {
    for (const streamId of Array.from(__classPrivateFieldGet(this, _RemotePeer_streamRemoveTrackListeners, "f").keys())) {
        __classPrivateFieldGet(this, _RemotePeer_instances, "m", _RemotePeer_detachRemoveTrackListener).call(this, streamId);
    }
}, _RemotePeer_attachConnectionListeners = function _RemotePeer_attachConnectionListeners() {
    __classPrivateFieldGet(this, _RemotePeer_connection, "f").on("state-change", __classPrivateFieldGet(this, _RemotePeer_forwardStateChange, "f"));
    __classPrivateFieldGet(this, _RemotePeer_connection, "f").on("negotiation-error", __classPrivateFieldGet(this, _RemotePeer_forwardNegotiationError, "f"));
    __classPrivateFieldGet(this, _RemotePeer_connection, "f").on("ice-candidate-error", __classPrivateFieldGet(this, _RemotePeer_forwardIceCandidateError, "f"));
    __classPrivateFieldGet(this, _RemotePeer_connection, "f").on("track", __classPrivateFieldGet(this, _RemotePeer_forwardTrack, "f"));
    __classPrivateFieldGet(this, _RemotePeer_connection, "f").on("data-channel", __classPrivateFieldGet(this, _RemotePeer_forwardDataChannel, "f"));
}, _RemotePeer_detachConnectionListeners = function _RemotePeer_detachConnectionListeners() {
    __classPrivateFieldGet(this, _RemotePeer_connection, "f").off("state-change", __classPrivateFieldGet(this, _RemotePeer_forwardStateChange, "f"));
    __classPrivateFieldGet(this, _RemotePeer_connection, "f").off("negotiation-error", __classPrivateFieldGet(this, _RemotePeer_forwardNegotiationError, "f"));
    __classPrivateFieldGet(this, _RemotePeer_connection, "f").off("ice-candidate-error", __classPrivateFieldGet(this, _RemotePeer_forwardIceCandidateError, "f"));
    __classPrivateFieldGet(this, _RemotePeer_connection, "f").off("track", __classPrivateFieldGet(this, _RemotePeer_forwardTrack, "f"));
    __classPrivateFieldGet(this, _RemotePeer_connection, "f").off("data-channel", __classPrivateFieldGet(this, _RemotePeer_forwardDataChannel, "f"));
};

// MediaStream attach / detach helpers.
//
// These functions operate on an RTCPeerConnectionLike directly. They
// don't trigger renegotiation themselves — that happens automatically
// in the underlying RTCPeerConnection: addTrack and removeTrack queue
// a `negotiationneeded` event, which PeerConnection's handler picks up
// and turns into an SDP offer.
//
// replaceTrack is the exception — it deliberately bypasses renegotiation
// so a camera swap (or screen-share swap) doesn't re-do the entire ICE
// dance. The spec only allows this when the new track's codec is
// compatible; if it isn't, the underlying replaceTrack() rejects.
/**
 * Attach every track in `stream` to the peer connection. Each addTrack
 * call queues a negotiationneeded event in the underlying PC; the
 * PeerConnection wrapper batches those into a single SDP offer via the
 * spec's automatic coalescing.
 *
 * Returns the senders in the same order as `stream.getTracks()` so
 * callers can later replaceTrack / removeTrack on them directly.
 */
/**
 * Attach a single track. Convenience wrapper around addTrack so callers
 * don't have to manage the rest-args style.
 */
function attachTrack(pc, track, stream) {
    return stream ? pc.addTrack(track, stream) : pc.addTrack(track);
}
/**
 * Detach the sender currently sourcing `track`, if any. Returns true
 * iff a sender was matched and removed — useful for callers that need
 * to know if their cleanup actually fired.
 */
function detachTrack(pc, track) {
    for (const sender of pc.getSenders()) {
        if (sender.track === track) {
            pc.removeTrack(sender);
            return true;
        }
    }
    return false;
}
/**
 * Swap the track currently being sent on the sender owned by `oldTrack`
 * for `newTrack` (or null to silence the sender). Does NOT trigger
 * renegotiation when the new track's codec is compatible with the
 * existing transceiver — that's the whole point.
 *
 * Returns true iff a matching sender was found.
 *
 * Throws if the underlying replaceTrack() rejects (incompatible codec,
 * sender stopped, etc.) — that's an unrecoverable condition the caller
 * needs to handle (typically by removeTrack + addTrack instead).
 */
async function replaceTrack(pc, oldTrack, newTrack) {
    for (const sender of pc.getSenders()) {
        if (sender.track === oldTrack) {
            await sender.replaceTrack(newTrack);
            return true;
        }
    }
    return false;
}

// WebRTC layer types. Wraps RTCPeerConnection and routes SDP / ICE
// through the SignallingClient's direct-message channel.
//
// Remote SDK instances exchange `rtc-description` / `rtc-ice`
// payloads via the signalling-server's `send` → `direct` path.
// The server is oblivious to the payload (opaque JSON).
/**
 * Type-guard for incoming `direct` payloads. MeteredPeer's orchestrator
 * uses this to decide whether to forward to PeerConnection.handleSignal
 * or surface to the customer as a regular direct message.
 *
 * Defensive: tolerates anything that doesn't look like an Object. A
 * malicious peer could publish `null`, primitives, or pathological
 * shapes — we don't want to crash on that.
 */
function isRtcSignal(data) {
    if (typeof data !== "object" || data === null)
        return false;
    const t = data.type;
    if (t === "rtc-description") {
        const d = data.description;
        if (typeof d !== "object" || d === null)
            return false;
        const dt = d.type;
        const sdp = d.sdp;
        return (dt === "offer" || dt === "answer") && typeof sdp === "string";
    }
    if (t === "rtc-ice") {
        const c = data.candidate;
        return c === null || (typeof c === "object" && c !== null);
    }
    return false;
}

// MeteredPeer — the public orchestrator that wraps SignallingClient
// + per-remote PeerConnection into the 80%-case customer API.
//
// Reconnect handling cooperates across three layers:
//
//   1. WebSocket layer: SignallingClient auto-reconnects with
//      exponential backoff, refreshes tokens, replays subscribes,
//      runs an inactivity watchdog, drops stale-socket events.
//
//   2. Per-peer WebRTC layer: each PeerConnection has an ICE-restart
//      ladder for TURN failover / network roam, 9 attempts spanning
//      ~121 s.
//
//   3. Channel-level peer-state reconcile: preserves RemotePeer
//      identity through transient WS drops. On
//      `disconnected{willReconnect: true}`, MeteredPeer transitions
//      to "reconnecting" and the peers map is kept intact (each
//      RemotePeer's state goes to "reconnecting"). On the post-
//      reconnect welcome (`isReconnect: true`), the next presence
//      event for our channel is treated as a snapshot — diff'd
//      against the preserved map:
//        - departures (in map, not in snapshot)  → peer-left
//        - newcomers  (in snapshot, not in map)  → peer-joined
//        - survivors  (in both)                  → silent PC swap
//                                                   inside the same
//                                                   RemotePeer ref
//      Then state goes back to "joined". Customer-held RemotePeer
//      refs to survivors remain valid; subscribed listeners keep
//      receiving events from the new underlying PC.
//
// Server-side requirement: presence-on-subscribe must carry the
// FULL channel snapshot (not just deltas). That's what the
// auto-resubscribe-after-reconnect flow relies on for the reconcile
// diff.
var _MeteredPeer_instances, _MeteredPeer_opts, _MeteredPeer_trackedTracks, _MeteredPeer_reconcilePending, _MeteredPeer_reconcileDeadlineTimer, _MeteredPeer_reconcileResubscribes, _MeteredPeer_joinOpts, _MeteredPeer_sendTrackMeta, _MeteredPeer_armReconcileDeadline, _MeteredPeer_clearReconcileDeadline, _MeteredPeer_onReconcileDeadline;
/**
 * Reserved channel-name prefixes the server refuses to accept.
 * Mirrored here so the SDK rejects synchronously with a typed error
 * instead of letting the customer's join() round-trip and bounce
 * back with a server-jargon `channel_reserved` rejection. Case-
 * insensitive on the prefix per the server's matcher.
 */
const RESERVED_CHANNEL_PREFIX_RE = /^_(metered|internal|system)\//i;
/**
 * Fallback maxMessageSize used when we need to size-check a send
 * BEFORE the welcome has arrived. Matches the server's default
 * (65 536 bytes) — the state gate normally prevents pre-welcome
 * sends, but if a future code path bypasses the gate this value
 * stays in sync with the server rather than false-positive-rejecting
 * legitimate sub-64 KB payloads.
 */
const FALLBACK_MAX_MESSAGE_SIZE = 65536;
/**
 * Defensive cap on the number of RemotePeer instances MeteredPeer
 * will track for a single channel. The browser caps RTCPeerConnection
 * instances around 256; we hit that ceiling first if a hostile or
 * compromised server fans out presence-joined to thousands of peers.
 * Picked at 256 to match the typical browser ceiling.
 */
const MAX_PEERS_PER_CHANNEL = 256;
/**
 * Reconcile watchdog. After a reconnect's welcome, the server is
 * expected to answer the SDK's resubscribe with a presence snapshot
 * for the joined channel — that snapshot is what completes the
 * reconcile and returns the peer to "joined". If it doesn't arrive
 * within this window (resubscribe frame lost, rejected, or the
 * snapshot itself dropped), the SDK re-issues the subscribe itself
 * (idempotent server-side) up to MAX_RECONCILE_RESUBSCRIBES times,
 * then surfaces a `ReconcileTimeoutError` on the `error` event so
 * the customer's app can recover (close + construct a new instance)
 * instead of sitting in "reconnecting" forever.
 */
const RECONCILE_DEADLINE_MS = 10000;
const MAX_RECONCILE_RESUBSCRIBES = 2;
/**
 * Reserved-key prefix the SDK uses to ride control messages over the
 * customer-visible `direct` channel. Any payload arriving with this
 * exact field is intercepted by onDirect and never surfaced to the
 * customer's `data` event. Customers MUST NOT send payloads with this
 * key — see `peer.addTrack` docs for the documented limitation.
 */
const TRACK_META_KEY = "__meteredTrackMeta";
function trackMetaBody(track, metadata, stream) {
    if (metadata === undefined)
        return { trackId: track.id };
    return {
        trackId: track.id,
        metadata,
        kind: track.kind,
        ...(stream !== undefined && stream.id !== "" ? { streamId: stream.id } : {}),
    };
}
/** Longest streamId / kind accepted inbound; real values are UUIDs / "audio" | "video". */
const MAX_TRACK_META_ID_LEN = 256;
function isOptionalId(value) {
    return (value === undefined ||
        (typeof value === "string" && value.length > 0 && value.length <= MAX_TRACK_META_ID_LEN));
}
/**
 * Plain-object check for `metadata`. Excludes arrays (which are
 * objects in JS), null, primitives. Customer code does
 * `Object.assign(target, ev.metadata)` and `for (const k in ev.metadata)`
 * — both behave surprisingly on arrays / null / primitives, so we
 * reject malformed shapes at the receive boundary instead of letting
 * them masquerade as StreamMetadata.
 */
function isPlainObjectMetadata(value) {
    if (typeof value !== "object" || value === null)
        return false;
    if (Array.isArray(value))
        return false;
    return true;
}
/**
 * Close codes that always mean "your code or your auth is wrong" —
 * the reconnect ladder won't recover. We surface these as MeteredPeer.error
 * so customers wiring a single error listener get notified.
 *
 * Codes per the hosted errors-and-codes reference: 4001 invalid_token,
 * 4002 token_expired, 4003 channel_not_authorized, 4012
 * account_suspended, 4020 admin_kick.
 * Other terminal closes (1001 going_away, etc.) are routed via
 * the standard disconnected/left events.
 */
function isFatalCloseCode(code) {
    return code === 4001 || code === 4002 || code === 4003 || code === 4012 || code === 4020;
}
function closeCodeName(code) {
    switch (code) {
        case 4001: return "invalid_token";
        case 4002: return "token_expired";
        case 4003: return "channel_not_authorized";
        case 4012: return "account_suspended";
        case 4020: return "admin_disconnect";
        default: return `close_${code}`;
    }
}
function isTrackMetaMessage(data) {
    if (typeof data !== "object" || data === null)
        return false;
    const wrapper = data[TRACK_META_KEY];
    if (typeof wrapper !== "object" || wrapper === null)
        return false;
    const { trackId, metadata, streamId, kind } = wrapper;
    if (typeof trackId !== "string" || trackId.length === 0)
        return false;
    if (!isOptionalId(streamId) || !isOptionalId(kind)) {
        return false;
    }
    // metadata is optional (clear-message has no metadata field). When
    // present, it MUST be a plain object — adversarial peers can't slip
    // arrays / null / strings into customer-visible metadata fields.
    if (metadata !== undefined && !isPlainObjectMetadata(metadata)) {
        return false;
    }
    return true;
}
/**
 * Thrown by `send()` when the JSON-serialized payload would exceed
 * the server's per-message cap. Typed so customers can branch on
 * `instanceof MeteredPeerOversizedError` without parsing message
 * strings.
 */
class MeteredPeerOversizedError extends Error {
    constructor(size, cap) {
        super(`MeteredPeer.send: payload ${size} bytes exceeds server cap ${cap} bytes`);
        this.name = "MeteredPeerOversizedError";
        this.size = size;
        this.cap = cap;
    }
}
/**
 * Thrown by `send()` when the channel name uses a server-reserved
 * prefix or when the SDK isn't in a state that can accept sends
 * (not currently joined).
 */
class MeteredPeerSendError extends Error {
    constructor(code, message) {
        super(message);
        this.name = "MeteredPeerSendError";
        this.code = code;
    }
}
/**
 * Thrown by `replaceTrack()` when ANY peer's underlying replaceTrack
 * rejects. Carries per-peer success / failure so customers can
 * converge surgically rather than guessing which side of the
 * fanout completed.
 *
 * Why a typed error and not just a single rejected promise: the
 * underlying `Promise.allSettled` fanout means a partial failure
 * leaves the channel in a split state — peers 1, 2, 4 on newTrack,
 * peer 3 still on oldTrack. Without the failed/succeeded lists,
 * the customer's natural retry (`removeStream` + `addStream`) can't
 * reconcile because `detachStream` matches by `sender.track === track`
 * and already-replaced peers won't match. With the lists, the
 * customer can call replaceTrack(newTrack, oldTrack) on just the
 * failed subset (or removeTrack from PC + addStream the new track)
 * without disturbing the already-replaced peers.
 */
/**
 * Thrown synchronously by methods that can't safely act in the
 * current `MeteredPeer.state` — `join`, `addStream`, `addTrack`,
 * `removeStream`, `removeTrack`, `replaceTrack`. Typed so customers
 * can branch via `instanceof` / `e.code` instead of parsing message
 * strings (which the SDK doesn't promise to keep stable).
 *
 * Codes:
 *   - `invalid_state` — generic "wrong state for this call". The
 *     `method` and `currentState` fields tell you which.
 *   - `track_already_attached` — addTrack/addStream called for a
 *     track already in the SDK's tracking map with a different
 *     stream association. Multi-stream membership (one track shared
 *     across multiple MediaStreams) is not currently supported; the
 *     SDK rejects loudly instead of silently dropping the second
 *     association.
 */
class MeteredPeerStateError extends Error {
    constructor(code, method, message, currentState) {
        super(message);
        this.name = "MeteredPeerStateError";
        this.code = code;
        this.method = method;
        if (currentState !== undefined)
            this.currentState = currentState;
    }
}
class MeteredPeerReplaceTrackError extends Error {
    constructor(succeeded, failed) {
        super(`MeteredPeer.replaceTrack: ${failed.length} of ${succeeded.length + failed.length} peer(s) failed`);
        this.name = "MeteredPeerReplaceTrackError";
        this.succeeded = succeeded;
        this.failed = failed;
    }
}
class MeteredPeer extends EventEmitter {
    constructor(opts) {
        super();
        _MeteredPeer_instances.add(this);
        // ES private — apiKey / tokenProvider live inside `opts`. A `private`
        // TS field is still enumerable at runtime; JSON.stringify(peer)
        // would ship the credential to Sentry/console.dir-style surfaces.
        // # makes it actually unreachable, preserving the credential
        // isolation invariant.
        _MeteredPeer_opts.set(this, void 0);
        this._state = "idle";
        this._localPeerId = null;
        this._channel = null;
        this._iceServers = undefined;
        this._maxMessageSize = FALLBACK_MAX_MESSAGE_SIZE;
        this.peers = new Map();
        // Tracks the customer added via addTrack / addStream. Single source
        // of truth for "what local tracks does this peer want every PC to
        // receive." A peer joining LATER, or a survivor's PC getting swapped
        // during reconcile, both iterate this map to (re)attach.
        //
        // Keyed by MediaStreamTrack reference; value carries the optional
        // stream association (for stream-id signalling on the wire) and
        // optional per-track metadata.
        //
        // Why a Map and not separate Set<stream> + Set<track>: tracks are
        // the wire-level unit (one pc.addTrack call per entry). Streams are
        // a sender-side ergonomic grouping. Tracking by track keeps the
        // model honest with WebRTC's actual surface.
        _MeteredPeer_trackedTracks.set(this, new Map());
        // True from the moment we observe `disconnected{willReconnect:true}`
        // until the post-reconnect presence event for our channel arrives
        // and we've reconciled against it. Multiple reconnect cycles in
        // quick succession keep this set until the final presence lands.
        _MeteredPeer_reconcilePending.set(this, false);
        // Reconcile watchdog — armed on each reconnect welcome while a
        // reconcile is pending, cleared when the presence snapshot lands
        // (or on disconnect / teardown). See RECONCILE_DEADLINE_MS.
        _MeteredPeer_reconcileDeadlineTimer.set(this, null);
        _MeteredPeer_reconcileResubscribes.set(this, 0);
        // JoinOptions from the last join(), stashed so reconcile-deadline
        // resubscribes carry the customer's original intent
        // (includeSenderMetadata).
        _MeteredPeer_joinOpts.set(this, {});
        // ---------- SignallingClient handlers ----------
        this.onSignallingConnected = (ev) => {
            this._localPeerId = ev.peerId;
            // Preserve previous iceServers if this welcome omits them. The
            // server may skip the field on a reconnect welcome (degraded mode,
            // future server-side optimisation, etc.); without this guard the
            // next PC construction would be TURN-less and fail to reach peers
            // behind symmetric NAT. Explicit empty array `[]` still passes
            // through — `??` only catches undefined / null.
            this._iceServers = ev.iceServers ?? this._iceServers;
            this._maxMessageSize = ev.maxMessageSize;
            // Mark the next presence event for our channel as the snapshot
            // to reconcile against. onSignallingDisconnected already set
            // #reconcilePending = true on the willReconnect path, so this
            // is a defensive belt — covers the case where the SignallingClient
            // surfaces an isReconnect=true welcome without the corresponding
            // disconnected event having reached us (e.g., due to handler
            // ordering quirks).
            if (ev.isReconnect && this._state === "reconnecting") {
                if (this.peers.size === 0) {
                    // Nothing to reconcile: no tracked peers means no connections
                    // to swap and no departures to detect. Complete immediately —
                    // waiting on the roster snapshot adds nothing here, and this
                    // also tolerates servers that omit the empty snapshot (the
                    // watchdog below would otherwise escalate to a spurious
                    // timeout). Members who joined during the drop arrive as
                    // normal presence deltas (or as a snapshot, which an empty
                    // peer map processes identically).
                    __classPrivateFieldSet(this, _MeteredPeer_reconcilePending, false, "f");
                    __classPrivateFieldGet(this, _MeteredPeer_instances, "m", _MeteredPeer_clearReconcileDeadline).call(this);
                    this.setState("joined");
                    return;
                }
                __classPrivateFieldSet(this, _MeteredPeer_reconcilePending, true, "f");
                // Fresh connection → fresh resubscribe budget for the reconcile
                // watchdog. The deadline runs from THIS welcome: the server's
                // presence snapshot answers the resubscribe that follows it.
                __classPrivateFieldSet(this, _MeteredPeer_reconcileResubscribes, 0, "f");
                __classPrivateFieldGet(this, _MeteredPeer_instances, "m", _MeteredPeer_armReconcileDeadline).call(this);
            }
        };
        this.onSignallingDisconnected = (ev) => {
            if (this._state === "closed" || this._state === "leaving")
                return;
            if (this._state === "joining") {
                // A drop while join() is in flight: the awaited connect() /
                // subscribe() inside join() rejects with this same close, and
                // join()'s catch resets the wrapper to "idle" so the customer
                // can retry on the same instance. There's no session to tear
                // down and no `left` event for a session that never started —
                // but the underlying client must stop too: left alone it would
                // keep auto-reconnecting and replay the never-acked
                // subscription, holding a server connection (and a concurrent-
                // connection slot) for a join the customer saw fail.
                if (isFatalCloseCode(ev.code)) {
                    const err = new Error(`connection closed terminally (code ${ev.code})${ev.reason ? `: ${ev.reason}` : ""}`);
                    err.name = closeCodeName(ev.code);
                    this.emit("error", { err });
                }
                if (ev.willReconnect)
                    void this.client.close();
                return;
            }
            if (ev.willReconnect &&
                (this._state === "joined" || this._state === "reconnecting")) {
                // Transient — preserve the peer map; reconcile when the post-
                // reconnect presence arrives. Each surviving RemotePeer goes
                // to "reconnecting" so customer UIs can show a per-peer
                // indicator without losing the peer reference.
                //
                // "idle" peers are exempt: they never negotiated (data-only /
                // presence-only usage — no tracks, no data channels), so there
                // is no connection to recover and the swapped-in PC will stay
                // dormant. Forcing them to "reconnecting" would pin them there
                // forever — no PC event ever fires to move them back.
                //
                // The peers map and #reconcilePending stay set across nested
                // reconnect cycles (drop → reconnect attempt → drop again
                // before presence arrives); only the final post-reconnect
                // presence does the reconcile. The reconcile deadline, by
                // contrast, is per-connection — cleared here, re-armed by the
                // next welcome.
                __classPrivateFieldGet(this, _MeteredPeer_instances, "m", _MeteredPeer_clearReconcileDeadline).call(this);
                __classPrivateFieldSet(this, _MeteredPeer_reconcilePending, true, "f");
                for (const peer of this.peers.values()) {
                    if (peer.state !== "reconnecting" &&
                        peer.state !== "closed" &&
                        peer.state !== "idle") {
                        peer._setState("reconnecting");
                    }
                }
                if (this._state !== "reconnecting")
                    this.setState("reconnecting");
                return;
            }
            // Terminal — full teardown. Either willReconnect=false (server
            // kicked us; reconnect ladder gave up; non-recoverable close
            // code), or we were in a state where preservation doesn't make
            // sense (joining/idle).
            //
            // Surface terminal closes that the customer must react to
            // (auth-level, admin-kick, suspended) via the error event BEFORE
            // tearing down listeners in removePeer. Customers wiring a single
            // `error` listener get a typed signal even though the underlying
            // event was a WS close code, not an `error` frame.
            if (!ev.willReconnect && isFatalCloseCode(ev.code)) {
                const err = new Error(`connection closed terminally (code ${ev.code})${ev.reason ? `: ${ev.reason}` : ""}`);
                err.name = closeCodeName(ev.code);
                this.emit("error", { err });
            }
            // A drop can land here with the wrapper "idle" but the client
            // still live and auto-reconnecting beneath it (join() failed at
            // the subscribe step, leaving the connection up). The wrapper is
            // about to report "closed" — stop the client too, mirroring the
            // joining branch above, so no background connection outlives the
            // session it belonged to.
            if (ev.willReconnect)
                void this.client.close();
            for (const peer of Array.from(this.peers.values())) {
                this.removePeer(peer.id);
            }
            __classPrivateFieldSet(this, _MeteredPeer_reconcilePending, false, "f");
            __classPrivateFieldGet(this, _MeteredPeer_instances, "m", _MeteredPeer_clearReconcileDeadline).call(this);
            // Same snapshot pattern as close() — capture before clearing.
            const closedPeerId = this._localPeerId;
            const closedChannel = this._channel;
            this._channel = null;
            this.setState("closed");
            this.emit("left", {
                peerId: closedPeerId,
                channel: closedChannel,
                reason: ev.reason || `disconnected (code ${ev.code})`,
            });
        };
        /**
         * Server-error events that customers need to see as fatal.
         *
         * Most server-errors are correlated to a pending request and come
         * back as Promise.reject from subscribe/publish/sendTo. Those
         * never reach this handler. The uncorrelated ones (server-initiated
         * rejections without a requestId — typically over_message_quota
         * mid-stream) DO surface here.
         *
         * Filter for codes the customer must react to (account suspended,
         * channel unauthorized, action not permitted on the joined channel).
         * Pure quota / rate-limit signals stay below the noise floor and
         * customers can read them off `server-error` directly if needed.
         */
        this.onServerError = (ev) => {
            const fatal = new Set([
                "account_suspended",
                "channel_not_authorized",
                "action_not_permitted",
                "invalid_token",
                "token_expired",
            ]);
            if (!fatal.has(ev.code))
                return;
            const err = new Error(`server error: ${ev.code}${ev.message ? ` — ${ev.message}` : ""}`);
            err.name = ev.code;
            this.emit("error", { err });
        };
        /**
         * Token provider has failed N consecutive reconnect attempts.
         * The SignallingClient's reconnect ladder keeps retrying internally,
         * but at this point the customer's auth pipeline is the bottleneck
         * — surface it to the customer-facing error channel so a UI can
         * prompt re-login.
         *
         * The threshold mirrors the default in SignallingClient's
         * token-provider-error event (3 consecutive failures); we don't
         * over-amplify by re-emitting on every retry.
         */
        this.onTokenProviderError = (ev) => {
            // SignallingClient only fires this event AT the threshold, so
            // we can forward unconditionally. The wrapper Error preserves
            // the inner cause for customer debugging.
            const err = new Error(`token provider failed ${ev.consecutiveFailures} consecutive attempts: ${ev.err.message}`);
            err.name = "TokenProviderError";
            this.emit("error", { err });
        };
        this.onPresence = (ev) => {
            if (ev.channel !== this._channel)
                return;
            if (__classPrivateFieldGet(this, _MeteredPeer_reconcilePending, "f")) {
                // Treat this presence as a snapshot: server's resubscribe
                // handler sends presence with `joined: [all current channel
                // members]`. Subsequent presence events for this channel revert
                // to delta semantics.
                __classPrivateFieldSet(this, _MeteredPeer_reconcilePending, false, "f");
                __classPrivateFieldGet(this, _MeteredPeer_instances, "m", _MeteredPeer_clearReconcileDeadline).call(this);
                this.reconcileFromSnapshot(ev.joined);
                return;
            }
            for (const p of ev.joined) {
                this.addPeer(p.peerId, p.metadata);
            }
            for (const p of ev.left) {
                this.removePeer(p.peerId);
            }
        };
        this.onDirect = (ev) => {
            // Three paths:
            //   - RTC control signal (rtc-description / rtc-ice): route to
            //     the corresponding PeerConnection's handleSignal. NEVER
            //     surface to the customer — those bytes are SDP, not data.
            //   - Reserved-key track-metadata control message: stash on the
            //     sender's RemotePeer for the receive-side track / stream-added
            //     event to consume. NEVER surface to the customer.
            //   - anything else: customer payload — emit "data" iff the
            //     sender is a known channel member.
            if (isRtcSignal(ev.data)) {
                const peer = this.peers.get(ev.from);
                if (!peer) {
                    // Edge case: a signal from a peerId we don't know about.
                    // Most likely the presence event from the server is racing
                    // the SDP. For v1 we drop the signal; the remote peer's
                    // negotiation logic will surface a `negotiation-error`
                    // event when its answer never arrives. A future tweak could
                    // buffer briefly, but the race is rare in practice (presence
                    // is delivered before peer-to-peer routing opens).
                    return;
                }
                void peer._handleSignal(ev.data);
                return;
            }
            if (isTrackMetaMessage(ev.data)) {
                const peer = this.peers.get(ev.from);
                if (!peer) {
                    // Metadata for a peer we haven't seen yet. Drop — when the
                    // presence event eventually arrives the sender's own
                    // newcomer-fanout (in addPeer above) will re-send the
                    // metadata to whoever joined. This is the inverse race of
                    // the rtc-signal handler.
                    return;
                }
                const { trackId, metadata, streamId, kind } = ev.data[TRACK_META_KEY];
                peer._setTrackMetadata(trackId, metadata, streamId, kind);
                return;
            }
            // Drop direct messages from peers outside our joined channel.
            // The wire protocol allows cross-channel direct sends within a
            // tenant; the MeteredPeer contract scopes data events to peers
            // we've seen via presence. Customers wanting unscoped direct
            // messaging use SignallingClient directly. Defense-in-depth if
            // server tenant isolation ever loosens or has a bug.
            if (!this.peers.has(ev.from)) {
                __classPrivateFieldGet(this, _MeteredPeer_opts, "f").logger?.debug?.("MeteredPeer: dropping direct from unknown peerId", { from: ev.from });
                return;
            }
            this.emit("data", {
                senderPeerId: ev.from,
                data: ev.data,
                kind: "direct",
                ...(ev.fromMetadata !== undefined
                    ? { senderMetadata: ev.fromMetadata }
                    : {}),
            });
        };
        this.onMessage = (ev) => {
            if (ev.channel !== this._channel)
                return;
            // Skip own broadcasts — the server may echo to publishers if
            // they're also subscribed; emitting `data` for our own send
            // would surprise customers.
            if (this._localPeerId !== null && ev.from === this._localPeerId)
                return;
            this.emit("data", {
                senderPeerId: ev.from,
                data: ev.data,
                kind: "broadcast",
                ...(ev.fromMetadata !== undefined
                    ? { senderMetadata: ev.fromMetadata }
                    : {}),
            });
        };
        /**
         * The signalling adapter passed into every PeerConnection. Wraps
         * SignallingClient.send so SDP / ICE signals route through the
         * server's `direct` channel to the target peer.
         */
        this.signallingSender = {
            send: (toPeerId, data) => this.client.send(toPeerId, data),
        };
        // MeteredPeer's reconcile flow REQUIRES the automatic resubscribe:
        // the post-reconnect presence snapshot only arrives in response to
        // the replayed subscribe. With autoResubscribe off, the first WS
        // blip would strand the peer in "reconnecting" forever. Reject the
        // combination loudly instead of letting it brick at runtime.
        if (opts.autoResubscribe === false) {
            throw new TypeError("MeteredPeer: `autoResubscribe: false` is not supported — MeteredPeer " +
                "relies on the automatic re-subscribe to restore your channel after " +
                "a reconnect. Use SignallingClient directly for manual subscription " +
                "control.");
        }
        __classPrivateFieldSet(this, _MeteredPeer_opts, opts, "f");
        this.client = new SignallingClient(opts);
        this.client.on("connected", this.onSignallingConnected);
        this.client.on("disconnected", this.onSignallingDisconnected);
        this.client.on("presence", this.onPresence);
        this.client.on("direct", this.onDirect);
        this.client.on("message", this.onMessage);
        // Surface protocol-level / auth-level fatal conditions as
        // MeteredPeer.error so customers wiring a single error handler
        // (e.g., the React hook's useMeteredPeer().error) actually
        // receive something. Per-event filters live in the handlers.
        this.client.on("server-error", this.onServerError);
        this.client.on("token-provider-error", this.onTokenProviderError);
    }
    /**
     * toJSON override. Prevents accidental credential leak when a
     * customer's logging / observability tooling stringifies the peer
     * (Sentry breadcrumbs, console.dir, JSON.stringify). The ES-private
     * #opts already makes this technically safe; pinning toJSON here
     * documents the intent explicitly and survives field refactors.
     */
    toJSON() {
        return { state: this._state, peerId: this._localPeerId, channel: this._channel };
    }
    // ---------- Public state ----------
    get state() {
        return this._state;
    }
    /** Stable peerId assigned by the server at first welcome. */
    get peerId() {
        return this._localPeerId;
    }
    /** The channel currently joined, or null. */
    get channel() {
        return this._channel;
    }
    /** Snapshot of currently-connected remote peers. */
    get remotePeers() {
        return Array.from(this.peers.values());
    }
    // ---------- Send ----------
    /**
     * Broadcast `data` to every peer in the channel via the
     * signalling-server's `publish` frame. The local peer's own send
     * is NOT echoed back to its own `data` event listener.
     *
     * Rejects if not currently joined or the server rejects the publish
     * (e.g., `over_message_quota`). For per-peer direct messaging use
     * `sendTo(peerId, data)`.
     */
    send(data) {
        if (this._state !== "joined") {
            return Promise.reject(new MeteredPeerSendError("not_joined", `MeteredPeer.send: not joined (state=${this._state}); call join() first`));
        }
        if (data === undefined) {
            return Promise.reject(new MeteredPeerSendError("invalid_args", "MeteredPeer.send(data): data must not be undefined"));
        }
        if (this._channel === null) {
            return Promise.reject(new MeteredPeerSendError("not_joined", "MeteredPeer.send: not in a channel; call join() first"));
        }
        const sizeError = this.checkPayloadSize(data);
        if (sizeError)
            return Promise.reject(sizeError);
        return this.client.publish(this._channel, data);
    }
    /**
     * Send `data` directly to a single peer via the signalling-server's
     * `send` frame (server-routed, not WebRTC P2P). Use this for
     * lightweight messages without setting up a DataChannel.
     *
     * Rejects with a typed `MeteredPeerSendError` for `not_joined`,
     * `invalid_args`, or `self_send`; with `MeteredPeerOversizedError`
     * if the payload exceeds the server cap; or with the underlying
     * server error for missing peers / quota / authorization.
     */
    sendTo(peerId, data) {
        if (this._state !== "joined") {
            return Promise.reject(new MeteredPeerSendError("not_joined", `MeteredPeer.sendTo: not joined (state=${this._state}); call join() first`));
        }
        if (typeof peerId !== "string" || peerId.length === 0) {
            return Promise.reject(new MeteredPeerSendError("invalid_args", "MeteredPeer.sendTo(peerId, data): peerId must be a non-empty string"));
        }
        if (data === undefined) {
            return Promise.reject(new MeteredPeerSendError("invalid_args", "MeteredPeer.sendTo(peerId, data): data must not be undefined"));
        }
        if (this._localPeerId !== null && peerId === this._localPeerId) {
            return Promise.reject(new MeteredPeerSendError("self_send", "MeteredPeer.sendTo: cannot send to self (peerId equals local peerId)"));
        }
        // Defense-in-depth: warn loudly when a customer payload uses the
        // SDK's reserved control-message key. We still SHIP the message —
        // breaking customer code retroactively if they happen to use this
        // exact key would be worse than logging — but the warn surfaces
        // the collision before it manifests as "remote metadata mysteriously
        // changes when I send this kind of payload."
        if (typeof data === "object" &&
            data !== null &&
            TRACK_META_KEY in data) {
            __classPrivateFieldGet(this, _MeteredPeer_opts, "f").logger?.warn?.(`MeteredPeer.sendTo: payload uses reserved key '${TRACK_META_KEY}'; ` +
                `this collides with the SDK's track-metadata control channel and ` +
                `may be interpreted as a metadata update on the receiver. ` +
                `Use a different key for your payload.`, { toPeerId: peerId });
        }
        // Same collision class, sharper consequence: a payload shaped like
        // the SDK's WebRTC signalling messages is consumed by the
        // recipient's negotiation machinery and never reaches their `data`
        // event. Warn (loudly) but still ship — consistent with the
        // reserved-key policy above.
        if (isRtcSignal(data)) {
            __classPrivateFieldGet(this, _MeteredPeer_opts, "f").logger?.warn?.("MeteredPeer.sendTo: payload matches the SDK's internal WebRTC " +
                "signalling shape (type 'rtc-description' / 'rtc-ice'); the " +
                "recipient SDK will consume it as a connection signal instead " +
                "of delivering it to the 'data' event. Use a different 'type' " +
                "value in your payload.", { toPeerId: peerId });
        }
        const sizeError = this.checkPayloadSize(data);
        if (sizeError)
            return Promise.reject(sizeError);
        return this.client.send(peerId, data);
    }
    /**
     * Pre-compute the JSON-serialised byte length of an outbound
     * payload and reject if it would exceed the welcome-advertised cap.
     * Cheaper than waiting for the server to close the socket with
     * code 1009. Returns null on success.
     *
     * utf8ByteLength measures the serialized payload without requiring a
     * global TextEncoder, so the check works on runtimes that lack one
     * (some React Native / Hermes versions). Shared with the DataChannel
     * wrapper.
     */
    checkPayloadSize(data) {
        let serialised;
        try {
            serialised = JSON.stringify(data);
        }
        catch {
            // Non-serialisable data (circular, BigInt) — let the SignallingClient's
            // own send path handle the TypeError so error messages stay layered.
            return null;
        }
        const size = utf8ByteLength(serialised);
        if (size > this._maxMessageSize) {
            return new MeteredPeerOversizedError(size, this._maxMessageSize);
        }
        return null;
    }
    // ---------- Media streams ----------
    /**
     * Attach every track in `stream` to every current and future
     * RemotePeer. Sugar over `addTrack(t, stream, metadata)` per track.
     *
     * `metadata`, if provided, is stamped on EACH of the stream's tracks
     * (a fresh copy per track to avoid customer-side aliasing). The
     * receiver surfaces it on the `track` event and on `stream-added`
     * (which fires when the stream's id first appears at the remote).
     *
     * Tracks are tracked on this MeteredPeer so peers joining AFTER this
     * call also receive them. Calling addStream with the same stream
     * twice is idempotent — already-tracked tracks are skipped.
     *
     * Throws if the peer is in a terminal state (`leaving` / `closed`).
     * During `reconnecting`, tracks are added to the tracking map but
     * not fanned out to the in-flight (about-to-be-discarded) connections;
     * once the connection recovers, every tracked stream is automatically
     * re-attached to each surviving peer's new connection.
     */
    addStream(stream, metadata) {
        if (this._state === "leaving" || this._state === "closed") {
            throw new MeteredPeerStateError("invalid_state", "addStream", `MeteredPeer.addStream: cannot add streams in state '${this._state}'`, this._state);
        }
        for (const track of stream.getTracks()) {
            // Copy metadata per track so customer-side mutation of the bag
            // after addStream doesn't reach back into our tracking map.
            const perTrackMeta = metadata !== undefined ? { ...metadata } : undefined;
            this.addTrack(track, stream, perTrackMeta);
        }
    }
    /**
     * Remove `stream` from every current peer and stop tracking its
     * tracks for future joins. Sugar over `removeTrack(track)` per track.
     *
     * No-op for tracks that were never added. Throws in terminal states
     * (`leaving` / `closed`). During `reconnecting`, tracks are removed
     * from the tracking map but no detach fires — the about-to-be-
     * replaced PCs will be discarded anyway.
     */
    removeStream(stream) {
        if (this._state === "leaving" || this._state === "closed") {
            throw new MeteredPeerStateError("invalid_state", "removeStream", `MeteredPeer.removeStream: cannot remove streams in state '${this._state}'`, this._state);
        }
        for (const track of stream.getTracks()) {
            this.removeTrack(track);
        }
    }
    /**
     * Attach a single track to every current and future RemotePeer. The
     * lower-level primitive that addStream sugars over.
     *
     * Pass `stream` to associate the track with a MediaStream on the
     * wire — the receiver sees that stream in the track event's `streams`
     * array, and (the first time the stream id appears) fires a
     * `stream-added` event. Omit `stream` for an unaffiliated track —
     * the receiver gets `streams: []` on the track event and no
     * `stream-added`.
     *
     * `metadata`, if provided, is propagated to every connected peer via
     * a reserved-key signalling message BEFORE the SDP offer goes out,
     * so the metadata lands at the receiver before the track event
     * fires. Survivors on reconcile get the metadata re-sent during the
     * PC swap; newcomers get it during their initial addTrack fanout.
     *
     * Idempotent on the same `track` reference — calling addTrack twice
     * with the same track is a no-op (metadata + stream from the FIRST
     * call wins; subsequent ones are dropped). To change metadata for an
     * already-tracked track, call `removeTrack(t)` then `addTrack(t, ...)`
     * with the new values.
     *
     * Throws in terminal states (`leaving` / `closed`). During
     * `reconnecting`, the track is added to the tracking map but not
     * fanned out; once the connection recovers, every tracked track is
     * automatically re-attached to each surviving peer's new connection
     * (its metadata is re-sent before the track so ordering is preserved
     * relative to the SDP offer).
     */
    addTrack(track, stream, metadata) {
        if (this._state === "leaving" || this._state === "closed") {
            throw new MeteredPeerStateError("invalid_state", "addTrack", `MeteredPeer.addTrack: cannot add tracks in state '${this._state}'`, this._state);
        }
        // If the track is already tracked, only short-circuit when
        // the customer is re-adding with the SAME stream association.
        // A different stream argument means "share this track across
        // streamA + streamB" — a real WebRTC feature (pc.addTrack(t, s1, s2))
        // we don't currently support. Fail loudly so the customer can
        // see it rather than silently dropping the second association
        // (which would later get nuked by removeStream(streamA)).
        const existing = __classPrivateFieldGet(this, _MeteredPeer_trackedTracks, "f").get(track);
        if (existing !== undefined) {
            if (existing.stream === stream)
                return; // idempotent
            throw new MeteredPeerStateError("track_already_attached", "addTrack", `MeteredPeer.addTrack: track is already attached to ${existing.stream === undefined ? "an orphan slot" : `stream '${existing.stream.id}'`}. Multi-stream membership (one track shared across multiple ` +
                `MediaStreams) is not currently supported — use distinct tracks per ` +
                `stream, or removeTrack(t) before re-adding.`);
        }
        // Validate metadata size synchronously so an over-cap payload
        // fails at the call site rather than queueing a server-rejected
        // sendTo + getting re-sent on every reconcile (infinite-loop
        // territory). The framing wraps metadata in a small envelope, so
        // we check against the maxMessageSize budget directly.
        if (metadata !== undefined) {
            const sizeError = this.checkPayloadSize({
                [TRACK_META_KEY]: trackMetaBody(track, metadata, stream),
            });
            if (sizeError)
                throw sizeError;
        }
        __classPrivateFieldGet(this, _MeteredPeer_trackedTracks, "f").set(track, { stream, metadata });
        // Fan out only when peers are live and the channel is up. Other
        // states (idle/joining/reconnecting) defer to addPeer (for new
        // peers) or swapPeerConnection (for surviving peers on reconcile);
        // both iterate #trackedTracks.
        if (this._state === "joined") {
            for (const peer of this.peers.values()) {
                // Send metadata FIRST so the receiver has it before the SDP
                // offer arrives (both go via the same TCP-ordered signalling
                // WS). Skip if there's no metadata — sending `{trackId}`
                // alone wastes a message. The metadata
                // sendTo is fire-and-forget; logged on rejection but never
                // fails the addTrack.
                if (metadata !== undefined) {
                    __classPrivateFieldGet(this, _MeteredPeer_instances, "m", _MeteredPeer_sendTrackMeta).call(this, peer.id, track, metadata, stream);
                }
                attachTrack(peer.pc, track, stream);
            }
        }
    }
    /**
     * Remove a single track from every current peer and stop tracking it
     * for future joins. Counterpart to addTrack.
     *
     * No-op if `track` was never added. Throws in terminal states
     * (`leaving` / `closed`). During `reconnecting`, the track is
     * removed from the tracking map but no detach fires.
     */
    removeTrack(track) {
        if (this._state === "leaving" || this._state === "closed") {
            throw new MeteredPeerStateError("invalid_state", "removeTrack", `MeteredPeer.removeTrack: cannot remove tracks in state '${this._state}'`, this._state);
        }
        const entry = __classPrivateFieldGet(this, _MeteredPeer_trackedTracks, "f").get(track);
        if (entry === undefined)
            return;
        __classPrivateFieldGet(this, _MeteredPeer_trackedTracks, "f").delete(track);
        if (this._state === "joined") {
            for (const peer of this.peers.values()) {
                // Clear metadata only if we sent any. Saves a redundant
                // clear-message on every removeTrack of a no-metadata track.
                if (entry.metadata !== undefined) {
                    __classPrivateFieldGet(this, _MeteredPeer_instances, "m", _MeteredPeer_sendTrackMeta).call(this, peer.id, track, undefined);
                }
                detachTrack(peer.pc, track);
            }
        }
    }
    /**
     * Look up the metadata the SDK is tracking for a sender-side track.
     * Returns undefined if `track` was never addTrack'd / addStream'd,
     * or if it was added without metadata.
     */
    getTrackMetadata(track) {
        return __classPrivateFieldGet(this, _MeteredPeer_trackedTracks, "f").get(track)?.metadata;
    }
    /**
     * Look up the metadata the SDK is tracking for a sender-side stream.
     * Sugar for `getTrackMetadata(stream.getTracks()[0])` — returns the
     * first track's metadata. For uniform-metadata streams (the addStream
     * path), this is the metadata the customer passed. For mixed-metadata
     * streams (advanced addTrack with different metas per track),
     * customers needing per-track precision should use getTrackMetadata
     * directly.
     *
     * Returns undefined if the stream has no tracks, no tracks of the
     * stream are tracked, or the first tracked one was added without
     * metadata.
     */
    getStreamMetadata(stream) {
        for (const track of stream.getTracks()) {
            const entry = __classPrivateFieldGet(this, _MeteredPeer_trackedTracks, "f").get(track);
            if (entry !== undefined)
                return entry.metadata;
        }
        return undefined;
    }
    /**
     * Swap `oldTrack` for `newTrack` (or null to silence) across every
     * RemotePeer where it's currently being sent. Doesn't trigger
     * renegotiation when codecs match — the whole point of replaceTrack.
     *
     * Resolves when every peer's replaceTrack has resolved. If ANY peer
     * rejects (typical cause: incompatible codec), throws a typed
     * `MeteredPeerReplaceTrackError` carrying per-peer succeeded /
     * failed lists. Customers can converge surgically:
     *
     *   try { await peer.replaceTrack(oldT, newT); }
     *   catch (e) {
     *     if (e instanceof MeteredPeerReplaceTrackError) {
     *       // peers in e.succeeded are on newT; e.failed are still on oldT.
     *       // retry only the failed subset, or rebuild via removeStream
     *       // + addStream targeted at e.failed peers.
     *     }
     *   }
     *
     * If 0 peers are connected, resolves trivially with no work done.
     */
    async replaceTrack(oldTrack, newTrack) {
        // State gate — replaceTrack acts on live senders. During
        // reconnecting, senders live on about-to-be-discarded PCs;
        // the customer's intent (swap THIS track for THAT one) wouldn't
        // persist across the reconcile because we'd need to update
        // #trackedTracks consistently — and we only get bare track args.
        //
        // Allowing idle/joining for the trivial-no-peers case keeps
        // test 4.4's contract ("resolves trivially with 0 peers") intact.
        if (this._state === "reconnecting" ||
            this._state === "leaving" ||
            this._state === "closed") {
            throw new MeteredPeerStateError("invalid_state", "replaceTrack", `MeteredPeer.replaceTrack: cannot replace tracks in state '${this._state}'. ` +
                `Wait for state === 'joined' (listen via the 'state-change' event) and retry.`, this._state);
        }
        // Defensive — replaceTrackHelper matches by sender.track === oldTrack
        // and a null/undefined argument would silently match nothing (or
        // worse: match trackless senders whose sender.track is currently null).
        // Customer's getTrackById() returning undefined would silently
        // resolve with no work done. Reject the call instead so the bug
        // surfaces at the call site.
        if (oldTrack == null) {
            throw new TypeError("MeteredPeer.replaceTrack: oldTrack must be a MediaStreamTrack (got null/undefined). " +
                "To remove a stream from peers, use removeStream() instead.");
        }
        // Snapshot peers ↔ peerId so per-peer results can be reported
        // back to the customer with the right id, even if a peer leaves
        // between fanout and resolution.
        const targets = Array.from(this.peers.values()).map((p) => ({
            id: p.id,
            pc: p.pc,
        }));
        const results = await Promise.allSettled(targets.map((t) => replaceTrack(t.pc, oldTrack, newTrack)));
        const succeeded = [];
        const failed = [];
        results.forEach((r, i) => {
            const target = targets[i];
            if (r.status === "fulfilled") {
                succeeded.push(target.id);
            }
            else {
                // Pass the underlying rejection through scrubError so an SDP
                // credential field (ice-pwd / ice-ufrag) accidentally landing
                // in the error's message or stack doesn't ship to a customer's
                // Sentry / logger when they serialize the failed[] array.
                failed.push({
                    peerId: target.id,
                    err: scrubError(r.reason),
                });
            }
        });
        // Keep #trackedTracks in sync with the live PC senders.
        // Without this, the next reconcile / newcomer-join iterates
        // #trackedTracks and re-attaches the STALE oldTrack — the
        // common camera↔screen swap flow would silently revert on any
        // wifi blip. Re-key the entry under newTrack so it (and its
        // associated stream + metadata) propagates correctly.
        //
        // Only update the map when at least one peer succeeded — a total
        // failure means the live PCs are still on oldTrack and our state
        // should reflect that. (Partial failures still update — the
        // customer will reconcile via MeteredPeerReplaceTrackError.failed,
        // and the map should track the dominant post-fanout state.)
        //
        // Metadata moves with the track. The receive-side keys metadata
        // by track.id, which CHANGES with replaceTrack (new track, new id).
        // We re-send the metadata under newTrack.id to every peer that
        // succeeded so their #trackMetadata cache stays consistent.
        if (newTrack !== null && (succeeded.length > 0 || targets.length === 0)) {
            const entry = __classPrivateFieldGet(this, _MeteredPeer_trackedTracks, "f").get(oldTrack);
            if (entry !== undefined) {
                __classPrivateFieldGet(this, _MeteredPeer_trackedTracks, "f").delete(oldTrack);
                __classPrivateFieldGet(this, _MeteredPeer_trackedTracks, "f").set(newTrack, entry);
                if (entry.metadata !== undefined) {
                    for (const id of succeeded) {
                        // Clear old key, set new key. Both via the same TCP-
                        // ordered signalling WS so order is preserved.
                        __classPrivateFieldGet(this, _MeteredPeer_instances, "m", _MeteredPeer_sendTrackMeta).call(this, id, oldTrack, undefined);
                        __classPrivateFieldGet(this, _MeteredPeer_instances, "m", _MeteredPeer_sendTrackMeta).call(this, id, newTrack, entry.metadata, entry.stream);
                    }
                }
            }
        }
        else if (newTrack === null && (succeeded.length > 0 || targets.length === 0)) {
            // replaceTrack(t, null) silences the sender. The track is no
            // longer being sent — drop it from the tracking map and clear
            // metadata on the receive side. Matches removeTrack's
            // semantics without the renegotiation a real removeTrack
            // would trigger.
            //
            // The `targets.length === 0` arm mirrors the newTrack!==null
            // branch above: silencing while ALONE in the channel must still
            // drop the track from #trackedTracks, otherwise a later joiner's
            // addPeer fanout re-attaches the track the customer believed they
            // had stopped sending (privacy-relevant). The succeeded loop is a
            // no-op when there are no peers, so no spurious metadata sends.
            const entry = __classPrivateFieldGet(this, _MeteredPeer_trackedTracks, "f").get(oldTrack);
            if (entry !== undefined) {
                __classPrivateFieldGet(this, _MeteredPeer_trackedTracks, "f").delete(oldTrack);
                if (entry.metadata !== undefined) {
                    for (const id of succeeded) {
                        __classPrivateFieldGet(this, _MeteredPeer_instances, "m", _MeteredPeer_sendTrackMeta).call(this, id, oldTrack, undefined);
                    }
                }
            }
        }
        if (failed.length > 0) {
            throw new MeteredPeerReplaceTrackError(succeeded, failed);
        }
    }
    // ---------- Lifecycle ----------
    /**
     * Connect to the signalling-server (if not connected) and subscribe
     * to `channel`. Resolves once the subscribe ack lands; peers are
     * discovered asynchronously via the server's `presence` event.
     *
     * Idempotent only in the success sense — re-joining the same channel
     * while already joined throws. To switch channels, construct a new
     * MeteredPeer (close() is terminal).
     */
    async join(channel, opts = {}) {
        if (this._state !== "idle") {
            throw new MeteredPeerStateError("invalid_state", "join", `MeteredPeer.join: cannot join in state '${this._state}'`, this._state);
        }
        // Reserved-prefix check — server rejects these with the
        // channel_reserved error code; failing fast client-side avoids
        // a WS round-trip and surfaces a clear typed error in IDE
        // autocomplete-driven workflows.
        if (RESERVED_CHANNEL_PREFIX_RE.test(channel)) {
            throw new MeteredPeerSendError("reserved_channel", `MeteredPeer.join: '${channel}' uses a reserved prefix (_metered/, _internal/, _system/)`);
        }
        this.setState("joining");
        try {
            // "closed" happens after a previous join() failed mid-flight
            // (the drop-during-join path closes the client so it doesn't
            // reconnect for a session the customer never got); connect()
            // accepts both idle and closed.
            if (this.client.state === "idle" || this.client.state === "closed") {
                await this.client.connect();
            }
            __classPrivateFieldSet(this, _MeteredPeer_joinOpts, { ...opts }, "f");
            await this.client.subscribe(channel, opts);
            this._channel = channel;
            this.setState("joined");
            if (this._localPeerId !== null) {
                this.emit("joined", { peerId: this._localPeerId, channel });
            }
        }
        catch (err) {
            // Drop the channel from the client's auto-resubscribe tracking —
            // a failed join must not leave a subscription behind that a
            // future reconnect of this client would replay. unsubscribe()
            // removes the tracked entry before attempting the (likely
            // offline) send; that send's rejection is irrelevant here.
            void this.client.unsubscribe(channel).catch(() => { });
            // Reset for retry only if the failure didn't race a close() —
            // "leaving"/"closed" are terminal and must not be resurrected.
            // (Read via the getter: TS's flow analysis still narrows
            // `this._state` to "idle" from the entry gate and doesn't see
            // setState's mutation.)
            if (this.state === "joining")
                this.setState("idle");
            throw err;
        }
    }
    /**
     * Close every remote peer connection, close the signalling socket,
     * and transition to "closed". Terminal — once close() has been
     * called, the MeteredPeer instance can't be reused; construct a new
     * one to rejoin. Idempotent.
     */
    async close(reason) {
        const stateAtClose = this._state;
        if (stateAtClose === "closed" ||
            stateAtClose === "idle" ||
            stateAtClose === "leaving") {
            // "leaving" also short-circuits — a customer's peer-left
            // handler can call close() during the close cascade and
            // we shouldn't double-run the cleanup. The outer close()
            // will finish the transition.
            if (stateAtClose !== "leaving") {
                this.setState("closed");
                // An "idle" peer can still own a live connection: join()
                // succeeded at connect but the server rejected the subscribe,
                // leaving the wrapper idle with the client up. close() is the
                // customer's only stop signal — always pass it down
                // (idempotent on an idle or already-closed client).
                await this.client.close();
            }
            return;
        }
        this.setState("leaving");
        __classPrivateFieldGet(this, _MeteredPeer_instances, "m", _MeteredPeer_clearReconcileDeadline).call(this);
        // Close peers BEFORE closing the WS — gives PeerConnection.close
        // a chance to fire any final state-change events while the
        // outbound signalling sender is still available (idempotent
        // anyway; this is mostly for tidy event ordering).
        for (const peer of Array.from(this.peers.values())) {
            this.removePeer(peer.id);
        }
        // Drop tracked-track refs so the peer object doesn't keep the
        // customer's tracks alive after close. Customer holds their own
        // refs too, so this is just defensive cleanup.
        __classPrivateFieldGet(this, _MeteredPeer_trackedTracks, "f").clear();
        // Snapshot peerId + channel BEFORE clearing — the `left` event
        // surfaces what the just-closed session was. Both can already be
        // null if close() fires before welcome (peerId) or before subscribe
        // ack (channel).
        const closedPeerId = this._localPeerId;
        const closedChannel = this._channel;
        await this.client.close();
        this._channel = null;
        this.setState("closed");
        this.emit("left", {
            peerId: closedPeerId,
            channel: closedChannel,
            ...(reason !== undefined ? { reason } : {}),
        });
    }
    /**
     * Reconcile: diff the post-reconnect snapshot against
     * `this.peers`. Order of operations:
     *
     *   1. Build the snapshot ID set (deduped, self filtered)
     *   2. Process departures FIRST — peers no longer in the channel.
     *      Fires `peer-left` with the OLD RemotePeer for each.
     *   3. Process snapshot entries:
     *      - Existing  → silent PC swap inside the same RemotePeer
     *      - Missing   → addPeer (fires `peer-joined`)
     *   4. Transition back to "joined"
     *
     * Doing departures first keeps the peers map size monotonically
     * decreasing as we iterate, easier to reason about.
     */
    reconcileFromSnapshot(joined) {
        // Deduped survivor/newcomer ID set, with self filtered.
        const snapshotIds = new Set();
        for (const p of joined) {
            if (p.peerId === this._localPeerId)
                continue;
            snapshotIds.add(p.peerId);
        }
        // Departures — fire peer-left for peers that left during the
        // reconnect window. Snapshot is the source of truth.
        //
        // The per-iteration state guard handles re-entrancy: if a
        // customer's `peer-left` handler calls `peer.close()`
        // synchronously, our state transitions to "leaving" during their
        // handler. Without the guard, the loop
        // continues iterating the (now-emptied) peers map and the
        // survivors loop below would construct PCs for peers the
        // customer has already torn down.
        for (const peerId of Array.from(this.peers.keys())) {
            if (this._state !== "reconnecting")
                return;
            if (!snapshotIds.has(peerId)) {
                this.removePeer(peerId);
            }
        }
        // Survivors get a silent PC swap. Newcomers go through the
        // regular addPeer path (fires peer-joined). Iteration over
        // `joined` is fine because dedup happens inside addPeer (Map.has
        // check) and swapPeerConnection (no-op on missing peer).
        //
        // Per-iteration state guard mirrors the departures loop.
        for (const p of joined) {
            if (this._state !== "reconnecting")
                return;
            if (p.peerId === this._localPeerId)
                continue;
            const existing = this.peers.get(p.peerId);
            try {
                if (existing) {
                    // Survivor: refresh metadata in case it changed during the
                    // disconnect (e.g., the peer rotated their JWT with a fresh
                    // peerMetadata claim) BEFORE the swap so customer-visible
                    // RemotePeer.metadata reflects the snapshot's truth.
                    existing._setMetadata(p.metadata);
                    this.swapPeerConnection(existing);
                }
                else {
                    this.addPeer(p.peerId, p.metadata);
                }
            }
            catch (err) {
                // A throw here (e.g. pc.addTrack rejecting a track in a bad
                // state, or a customer-injected RTCPeerConnection factory that
                // throws) must NOT abort the whole reconcile. If it propagated,
                // the EventEmitter would swallow it, the survivors after this
                // one would keep their stale pre-swap PCs, and the
                // setState("joined") below would never run — pinning the peer
                // in "reconnecting" forever (the next presence is a delta, not
                // a snapshot, so there is no recovery path). Log via the
                // customer's logger and continue; the affected peer keeps its
                // prior connection, which is no worse than skipping it.
                __classPrivateFieldGet(this, _MeteredPeer_opts, "f").logger?.warn?.("reconcile peer swap failed", {
                    peerId: p.peerId,
                    err: err?.message,
                });
            }
        }
        if (this._state === "reconnecting") {
            this.setState("joined");
        }
    }
    /**
     * Silent PC swap for a surviving RemotePeer. Builds a fresh
     * PeerConnection with the latest iceServers + signalling sender,
     * hands it to the RemotePeer (which detaches old listeners, closes
     * the old PC, and re-attaches to the new one), then re-attaches
     * every local stream from `#localStreams` so the new PC ships
     * the customer's media in its first SDP offer.
     *
     * Does NOT fire peer-left / peer-joined — the customer's ref to
     * `remote` is the same instance before and after this call.
     */
    swapPeerConnection(remote) {
        if (this._localPeerId === null)
            return;
        // Defensive — onSignallingDisconnected already transitions every
        // surviving non-idle peer to "reconnecting" before reconcile runs,
        // but hardcoding the precondition here decouples swapPeerConnection
        // from that ordering. The option-B filter in RemotePeer relies
        // on #state === "reconnecting" to drop the new PC's intermediate
        // "connecting" hop; this ensures the precondition holds even if
        // a future refactor splits the flow.
        //
        // "idle" peers stay idle (mirrors onSignallingDisconnected): they
        // never negotiated, so there's nothing to recover. If the swap's
        // re-attach below kicks off a FIRST negotiation (tracks were added
        // during the reconnect window), the customer should see a genuine
        // "connecting" hop, not have it filtered as reconcile flicker.
        if (remote.state !== "reconnecting" &&
            remote.state !== "closed" &&
            remote.state !== "idle") {
            remote._setState("reconnecting");
        }
        const polite = this._localPeerId < remote.id;
        const newConn = new PeerConnection({
            localPeerId: this._localPeerId,
            remotePeerId: remote.id,
            polite,
            signallingSender: this.signallingSender,
            ...(this._iceServers ? { iceServers: this._iceServers } : {}),
            ...(__classPrivateFieldGet(this, _MeteredPeer_opts, "f").rtcPeerConnectionFactory
                ? { rtcPeerConnectionFactory: __classPrivateFieldGet(this, _MeteredPeer_opts, "f").rtcPeerConnectionFactory }
                : {}),
        });
        remote._setConnection(newConn);
        // Re-send track metadata BEFORE re-attaching tracks. Both go via
        // the same TCP-ordered signalling WS; sending metadata first
        // guarantees the receiver has it stashed before the new PC's
        // track events fire (post-ICE). The metadata sends are
        // fire-and-forget — if the WS just opened and the per-message
        // quota rejects, we log via the customer's logger but don't fail
        // the swap.
        for (const [track, entry] of __classPrivateFieldGet(this, _MeteredPeer_trackedTracks, "f")) {
            if (entry.metadata !== undefined) {
                __classPrivateFieldGet(this, _MeteredPeer_instances, "m", _MeteredPeer_sendTrackMeta).call(this, remote.id, track, entry.metadata, entry.stream);
            }
        }
        // Re-attach every tracked local track. The new PC fires
        // negotiationneeded per addTrack which the PeerConnection wrapper
        // coalesces into the first SDP offer.
        for (const [track, entry] of __classPrivateFieldGet(this, _MeteredPeer_trackedTracks, "f")) {
            attachTrack(remote.pc, track, entry.stream);
        }
    }
    // ---------- Peer-set management ----------
    addPeer(peerId, metadata) {
        if (peerId === this._localPeerId)
            return; // ignore self
        if (this.peers.has(peerId))
            return; // dedup
        if (this._localPeerId === null) {
            // We don't know our own ID yet — can't compute politeness.
            // Defer until welcome lands. In practice presence shouldn't
            // arrive before welcome, but be safe.
            return;
        }
        if (this.peers.size >= MAX_PEERS_PER_CHANNEL) {
            // Defensive cap. Either a hostile / compromised server fanning
            // out a huge presence list, or a
            // genuine room beyond what the browser can handle anyway. Log
            // once-per-overflow and drop further joins.
            __classPrivateFieldGet(this, _MeteredPeer_opts, "f").logger?.warn?.("MeteredPeer: peer cap reached, dropping peer-joined", {
                peerId,
                cap: MAX_PEERS_PER_CHANNEL,
            });
            return;
        }
        // Perfect-negotiation tie-break: lex compare. Both peers compute
        // this independently and arrive at opposite values.
        const polite = this._localPeerId < peerId;
        const connection = new PeerConnection({
            localPeerId: this._localPeerId,
            remotePeerId: peerId,
            polite,
            signallingSender: this.signallingSender,
            ...(this._iceServers ? { iceServers: this._iceServers } : {}),
            ...(__classPrivateFieldGet(this, _MeteredPeer_opts, "f").rtcPeerConnectionFactory
                ? { rtcPeerConnectionFactory: __classPrivateFieldGet(this, _MeteredPeer_opts, "f").rtcPeerConnectionFactory }
                : {}),
        });
        const remote = new RemotePeer({
            id: peerId,
            ...(metadata !== undefined ? { metadata } : {}),
            connection,
            // remote.send(data) is shorthand for peer.sendTo(remote.id, data).
            // Route through this.sendTo() so the size cap / state gate /
            // arg validation apply uniformly — same hardening on both
            // entry points. Closing over the id keeps RemotePeer free of
            // any reference to MeteredPeer or its SignallingClient.
            send: (data) => this.sendTo(peerId, data),
        });
        this.peers.set(peerId, remote);
        // Send metadata for every tracked track to the newcomer BEFORE
        // attaching, so the receiver has the bag stashed by the time the
        // SDP offer + track events arrive. Order-preserved via the
        // single signalling WS.
        for (const [track, entry] of __classPrivateFieldGet(this, _MeteredPeer_trackedTracks, "f")) {
            if (entry.metadata !== undefined) {
                __classPrivateFieldGet(this, _MeteredPeer_instances, "m", _MeteredPeer_sendTrackMeta).call(this, peerId, track, entry.metadata, entry.stream);
            }
        }
        // Apply every tracked local track to the freshly-constructed PC
        // BEFORE emitting peer-joined. This way a customer subscribed to
        // peer-joined sees a RemotePeer whose underlying PC already has
        // the local senders attached — they don't need to addTrack-
        // per-peer manually.
        for (const [track, entry] of __classPrivateFieldGet(this, _MeteredPeer_trackedTracks, "f")) {
            attachTrack(remote.pc, track, entry.stream);
        }
        this.emit("peer-joined", { peer: remote });
    }
    removePeer(peerId) {
        const remote = this.peers.get(peerId);
        if (!remote) {
            // Server emitted presence-left for a peerId we never received
            // presence-joined for. Likely a server-state bug or a missed
            // join during a transient WS blip. Log so it's visible without
            // crashing.
            __classPrivateFieldGet(this, _MeteredPeer_opts, "f").logger?.warn?.("MeteredPeer: peer-left for unknown peerId", {
                peerId,
            });
            return;
        }
        this.peers.delete(peerId);
        remote._close();
        this.emit("peer-left", { peer: remote });
    }
    // ---------- State transition ----------
    setState(next) {
        if (next === this._state)
            return;
        const from = this._state;
        this._state = next;
        this.emit("state-change", { from, to: next });
    }
}
_MeteredPeer_opts = new WeakMap(), _MeteredPeer_trackedTracks = new WeakMap(), _MeteredPeer_reconcilePending = new WeakMap(), _MeteredPeer_reconcileDeadlineTimer = new WeakMap(), _MeteredPeer_reconcileResubscribes = new WeakMap(), _MeteredPeer_joinOpts = new WeakMap(), _MeteredPeer_instances = new WeakSet(), _MeteredPeer_sendTrackMeta = function _MeteredPeer_sendTrackMeta(toPeerId, track, metadata, stream) {
    const payload = {
        [TRACK_META_KEY]: trackMetaBody(track, metadata, stream),
    };
    const trackId = track.id;
    // Direct send via SignallingClient (bypasses MeteredPeer.sendTo's
    // public state-gate logic since we may need to send during the
    // brief joining→joined transition for a newly-joined peer). The
    // SignallingClient owns the actual transport-level state check.
    void this.client.send(toPeerId, payload).catch((err) => {
        __classPrivateFieldGet(this, _MeteredPeer_opts, "f").logger?.warn?.("track metadata send failed", {
            toPeerId,
            trackId,
            err: err instanceof Error ? err.message : String(err),
        });
    });
}, _MeteredPeer_armReconcileDeadline = function _MeteredPeer_armReconcileDeadline() {
    __classPrivateFieldGet(this, _MeteredPeer_instances, "m", _MeteredPeer_clearReconcileDeadline).call(this);
    __classPrivateFieldSet(this, _MeteredPeer_reconcileDeadlineTimer, setTimeout(() => {
        __classPrivateFieldSet(this, _MeteredPeer_reconcileDeadlineTimer, null, "f");
        __classPrivateFieldGet(this, _MeteredPeer_instances, "m", _MeteredPeer_onReconcileDeadline).call(this);
    }, RECONCILE_DEADLINE_MS), "f");
}, _MeteredPeer_clearReconcileDeadline = function _MeteredPeer_clearReconcileDeadline() {
    if (__classPrivateFieldGet(this, _MeteredPeer_reconcileDeadlineTimer, "f") !== null) {
        clearTimeout(__classPrivateFieldGet(this, _MeteredPeer_reconcileDeadlineTimer, "f"));
        __classPrivateFieldSet(this, _MeteredPeer_reconcileDeadlineTimer, null, "f");
    }
}, _MeteredPeer_onReconcileDeadline = function _MeteredPeer_onReconcileDeadline() {
    if (!__classPrivateFieldGet(this, _MeteredPeer_reconcilePending, "f") || this._state !== "reconnecting")
        return;
    // If the WS dropped again the deadline is moot — the next welcome
    // re-arms it with a fresh budget.
    if (this.client.state !== "connected")
        return;
    if (this._channel === null)
        return;
    if (__classPrivateFieldGet(this, _MeteredPeer_reconcileResubscribes, "f") < MAX_RECONCILE_RESUBSCRIBES) {
        __classPrivateFieldSet(this, _MeteredPeer_reconcileResubscribes, __classPrivateFieldGet(this, _MeteredPeer_reconcileResubscribes, "f") + 1, "f");
        __classPrivateFieldGet(this, _MeteredPeer_opts, "f").logger?.warn?.("MeteredPeer: no presence snapshot after reconnect; re-issuing subscribe", { channel: this._channel, attempt: __classPrivateFieldGet(this, _MeteredPeer_reconcileResubscribes, "f") });
        void this.client.subscribe(this._channel, __classPrivateFieldGet(this, _MeteredPeer_joinOpts, "f")).catch(() => {
            // Rejection details are logged at the SignallingClient layer;
            // the re-armed deadline below drives the next escalation.
        });
        __classPrivateFieldGet(this, _MeteredPeer_instances, "m", _MeteredPeer_armReconcileDeadline).call(this);
    }
    else {
        const err = new Error("reconcile timed out: no channel presence arrived after reconnect; " +
            "close() this instance and construct a new MeteredPeer to recover");
        err.name = "ReconcileTimeoutError";
        this.emit("error", { err });
    }
};

// RTCDataChannel wrapper with backpressure-aware send().
//
// Provides:
//   - Typed open/close/error/message events via EventEmitter
//   - send() that suspends when the underlying channel's bufferedAmount
//     exceeds maxBufferedAmount (default 1 MB), resuming on the
//     `bufferedamountlow` event
//   - Send serialization via a chained Promise — concurrent send()
//     calls execute in order so the underlying buffer doesn't get
//     bombarded the instant `bufferedamountlow` fires
//   - Idempotent close + automatic listener cleanup
//
// Plain string + ArrayBuffer payloads only. Blob and ArrayBufferView
// support would require a runtime detector for Blob (not in Node);
// could be added in a future minor if customer demand warrants.
const DEFAULT_MAX_BUFFERED_AMOUNT = 1048576; // 1 MB
const DEFAULT_MAX_QUEUED_SENDS = 256;
/**
 * Thrown by `send()` when too many sends are queued behind the
 * backpressure wait. Without this cap, a customer's
 * `for(;;) dc.send(big)` on a stalled link would grow the JS heap
 * until OOM. The cap rejects past `maxQueuedSends` so the producer
 * sees a real signal to back off.
 *
 * Typed so customers can `instanceof DataChannelOverflowError` and
 * branch on it without parsing message strings.
 */
class DataChannelOverflowError extends Error {
    constructor(queued, cap) {
        super(`DataChannel send queue overflowed (${queued} / cap ${cap})`);
        this.name = "DataChannelOverflowError";
        this.queued = queued;
        this.cap = cap;
    }
}
class DataChannel extends EventEmitter {
    constructor(channel, opts = {}) {
        super();
        // Chained promise — each new send awaits the previous. Without this
        // a flurry of concurrent send() calls would each wake from the
        // same `bufferedamountlow` event and re-trip the buffer ceiling.
        this.sendChain = Promise.resolve();
        // Queue-depth counter for the overflow cap. Incremented on send()
        // entry, decremented when the underlying doSend completes (either
        // success or failure). Reading at queue time tells us whether to
        // admit.
        this.queuedSendCount = 0;
        // Active `bufferedamountlow` waiters. On close() each
        // entry is force-rejected so a pending send() waiting on a buffer
        // drain doesn't hang forever — the original implementation left
        // the listener attached, and once the channel was closed the
        // event never fired again, leaking the promise.
        this.pendingLowWaiters = new Set();
        this.closed = false;
        this.onOpen = (_ev) => {
            if (this.closed)
                return;
            this.emit("open", undefined);
        };
        this.onClose = (_ev) => {
            if (this.closed)
                return;
            // Mirror what close() does, but without calling channel.close()
            // again (the close came FROM the channel, not the wrapper).
            this.closed = true;
            this.detachListeners();
            // Release pending backpressure waiters — same rationale as in
            // close().
            for (const release of this.pendingLowWaiters)
                release();
            this.pendingLowWaiters.clear();
            this.emit("close", undefined);
            this.removeAllListeners();
        };
        this.onError = (ev) => {
            if (this.closed)
                return;
            // RTCErrorEvent shape: { error: RTCError }. Some implementations
            // (Node `wrtc`) pass a plain Event without .error — fall back.
            const e = ev.error;
            const err = e instanceof Error
                ? e
                : new Error(typeof e === "string" ? e : "RTCDataChannel error");
            this.emit("error", { err });
        };
        this.onMessage = (ev) => {
            if (this.closed)
                return;
            const data = ev.data;
            this.emit("message", { data });
        };
        this.channel = channel;
        this.label = channel.label;
        this.logger = opts.logger ?? {};
        this.maxBufferedAmount = opts.maxBufferedAmount ?? DEFAULT_MAX_BUFFERED_AMOUNT;
        this.maxQueuedSends = opts.maxQueuedSends ?? DEFAULT_MAX_QUEUED_SENDS;
        const lowThreshold = opts.bufferedAmountLowThreshold ?? Math.floor(this.maxBufferedAmount / 2);
        // Setting this on the underlying channel is what makes the
        // `bufferedamountlow` event fire — RTCDataChannel won't emit
        // it without a non-zero threshold.
        this.channel.bufferedAmountLowThreshold = lowThreshold;
        this.handlers = {
            open: this.onOpen,
            close: this.onClose,
            error: this.onError,
            message: this.onMessage,
        };
        this.channel.addEventListener("open", this.handlers.open);
        this.channel.addEventListener("close", this.handlers.close);
        this.channel.addEventListener("error", this.handlers.error);
        this.channel.addEventListener("message", this.handlers.message);
    }
    get readyState() {
        return this.channel.readyState;
    }
    get bufferedAmount() {
        return this.channel.bufferedAmount;
    }
    /**
     * Queue a send. Resolves once the message has been handed to the
     * underlying channel. Rejects if the channel is not open. Each
     * queued send settles independently — one failed send does not
     * reject the sends queued behind it.
     *
     * Backpressure: if bufferedAmount would exceed maxBufferedAmount,
     * the call suspends until `bufferedamountlow` fires before calling
     * channel.send().
     *
     * Overflow guard: if more than `maxQueuedSends` are
     * already waiting in the chain, this rejects synchronously with a
     * typed `DataChannelOverflowError`. Without the cap, fire-and-
     * forget producers on a stalled link grow JS heap until OOM.
     */
    async send(data) {
        if (this.closed)
            throw new Error("DataChannel is closed");
        if (this.queuedSendCount >= this.maxQueuedSends) {
            throw new DataChannelOverflowError(this.queuedSendCount, this.maxQueuedSends);
        }
        this.queuedSendCount += 1;
        const next = this.sendChain
            .then(() => this.doSend(data))
            .finally(() => {
            this.queuedSendCount -= 1;
        });
        // Don't poison the chain on error — the chain is for sequencing,
        // not error propagation. Callers see their own rejection.
        this.sendChain = next.catch(() => { });
        return next;
    }
    /** Close the underlying channel + detach listeners. Idempotent. */
    close() {
        if (this.closed)
            return;
        this.closed = true;
        this.detachListeners();
        // Force-wake any pending backpressure waiters so their owning
        // send() doesn't hang forever. Each waiter's doSend
        // loop re-checks the closed flag after we resolve and rejects
        // with "DataChannel is closed".
        for (const release of this.pendingLowWaiters)
            release();
        this.pendingLowWaiters.clear();
        try {
            this.channel.close();
        }
        catch (err) {
            this.logger.warn?.("DataChannel close() threw", {
                label: this.label,
                err: err instanceof Error ? err.message : String(err),
            });
        }
        this.removeAllListeners();
    }
    // ---------- Internals ----------
    async doSend(data) {
        if (this.closed)
            throw new Error("DataChannel is closed");
        if (this.channel.readyState !== "open") {
            throw new Error(`DataChannel not open (readyState=${this.channel.readyState})`);
        }
        const incoming = byteLength(data);
        // Loop: another consumer of bufferedamountlow could have refilled
        // the buffer between our wakeup and this check. Re-test until we
        // can fit our payload.
        while (!this.closed &&
            this.channel.bufferedAmount + incoming > this.maxBufferedAmount) {
            await this.waitForLowBuffer();
            // Re-validate state after the wait — the channel could have
            // closed while we were suspended.
            if (this.closed)
                throw new Error("DataChannel is closed");
            if (this.channel.readyState !== "open") {
                throw new Error(`DataChannel closed while waiting for buffer (readyState=${this.channel.readyState})`);
            }
        }
        if (this.closed)
            throw new Error("DataChannel is closed");
        this.channel.send(data);
    }
    waitForLowBuffer() {
        return new Promise((resolve) => {
            const cleanup = () => {
                this.channel.removeEventListener("bufferedamountlow", onLow);
                this.pendingLowWaiters.delete(release);
            };
            const onLow = () => {
                cleanup();
                resolve();
            };
            // `release` is what close() calls to force-wake a stuck waiter
            //. It detaches the listener and resolves — the
            // doSend loop then re-checks closed/readyState and rejects.
            const release = () => {
                cleanup();
                resolve();
            };
            this.channel.addEventListener("bufferedamountlow", onLow);
            this.pendingLowWaiters.add(release);
        });
    }
    detachListeners() {
        this.channel.removeEventListener("open", this.handlers.open);
        this.channel.removeEventListener("close", this.handlers.close);
        this.channel.removeEventListener("error", this.handlers.error);
        this.channel.removeEventListener("message", this.handlers.message);
    }
}
/**
 * Byte length of an outgoing payload. Used to pre-check whether a
 * send would exceed the buffered-amount cap. utf8ByteLength avoids a
 * hard dependency on a global TextEncoder (absent on some React Native
 * / Hermes runtimes) and avoids Blob (absent in Node).
 */
function byteLength(data) {
    if (typeof data === "string") {
        return utf8ByteLength(data);
    }
    return data.byteLength;
}

// Public API surface for @metered-ca/realtime.
//
// What's stable (won't change without a major version):
//   - SignallingClient class shape (constructor opts + method signatures)
//   - MeteredPeer class shape
//   - TokenProvider type
//   - Logger interface
//   - Event names emitted from SignallingClient + MeteredPeer
//   - Type names exported from this file
//
// Anything NOT exported here is internal and may change without notice.
//
// INTENTIONALLY INTERNAL:
//   - src/webrtc/*  (PeerConnection, DataChannel, stream helpers)
//   - src/internal/* (CredentialStore, scrub, ice-servers, signalling-client impl)
//
// MeteredPeer wraps the WebRTC primitives in a customer-facing API
// (peer.join / peer.send / peer.addStream / peer-joined event).
// Customers reach the WebRTC layer through that class — this lets us
// evolve the internal representation (swap state machine, refactor
// signalling adapter) without breaking the export surface. Advanced
// callers can reach the underlying RTCPeerConnection via the
// `remote.pc` escape hatch when they need getStats() / low-level
// addEventListener hooks the wrapper doesn't surface.
// ---------- SignallingClient ----------
/**
 * Browser WebSocket client speaking the Metered Realtime Messaging
 * wire protocol.
 *
 * Usage (pk_ key path):
 *   const client = new SignallingClient({ apiKey: "pk_live_..." });
 *   await client.connect();
 *   client.on("message", ({ channel, from, data }) => { ... });
 *   await client.subscribe("room-42");
 *   await client.publish("room-42", { hello: "world" });
 *
 * Usage (sk_ JWT path):
 *   const client = new SignallingClient({
 *     tokenProvider: async () => {
 *       const r = await fetch("/api/mint-signalling-token");
 *       const { token } = await r.json();
 *       return token;
 *     },
 *   });
 *   await client.connect();
 *
 * Connection lifecycle:
 *   - connect() resolves after the welcome frame arrives
 *   - close() is terminal — no auto-reconnect after explicit close
 *   - Auto-reconnect on transient drops is built-in (see ReconnectOptions)
 */
class SignallingClient {
    constructor(opts) {
        this._impl = new SignallingClientImpl(opts);
    }
    get state() {
        return this._impl.state;
    }
    connect() {
        return this._impl.connect();
    }
    close(code, reason) {
        return this._impl.close(code, reason);
    }
    subscribe(channel, opts) {
        return this._impl.subscribe(channel, opts);
    }
    unsubscribe(channel) {
        return this._impl.unsubscribe(channel);
    }
    publish(channel, data, opts) {
        return this._impl.publish(channel, data, opts);
    }
    send(toPeerId, data, opts) {
        return this._impl.send(toPeerId, data, opts);
    }
    on(event, handler) {
        this._impl.on(event, handler);
        return this;
    }
    off(event, handler) {
        this._impl.off(event, handler);
        return this;
    }
    once(event, handler) {
        this._impl.once(event, handler);
        return this;
    }
}

export { ConsoleLogger, DataChannel, DataChannelOverflowError, MeteredPeer, MeteredPeerOversizedError, MeteredPeerReplaceTrackError, MeteredPeerSendError, MeteredPeerStateError, NoopLogger, OversizedPayloadError, SignallingClient, SignallingConnectError, WsCloseCode };
