// OpenTelemetry for the Bun server, configured entirely from OTEL_* env (in the cluster, the operator's
// inject-sdk annotation sets them). Node auto-instrumentations don't patch Bun.serve or Bun's fetch,
// so this wraps both by hand: a server span per request, and a client span per upstream fetch.
import { NodeSDK } from '@opentelemetry/sdk-node';
import { context, propagation, trace, SpanKind, SpanStatusCode } from '@opentelemetry/api';

new NodeSDK().start();
const tracer = trace.getTracer('oci-layers-proxy');

function finish(span, res) {
  span.setAttribute('http.response.status_code', res.status);
  if (res.status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
  return res;
}

function fail(span, err) {
  span.recordException(err);
  span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
  throw err;
}

const getter = { keys: (h) => [...h.keys()], get: (h, k) => h.get(k) ?? undefined };
const setter = { set: (h, k, v) => h.set(k, v) };

export function traced(handler) {
  return (req, server) => {
    const url = new URL(req.url);
    const parent = propagation.extract(context.active(), req.headers, getter);
    const attributes = {
      'http.request.method': req.method,
      'url.path': url.pathname,
      'url.scheme': url.protocol.slice(0, -1),
      'server.address': url.hostname,
      'user_agent.original': req.headers.get('user-agent') ?? undefined,
    };
    return tracer.startActiveSpan(req.method, { kind: SpanKind.SERVER, attributes }, parent, (span) =>
      Promise.resolve()
        .then(() => handler(req, server))
        .then((res) => finish(span, res), (err) => fail(span, err))
        .finally(() => span.end()),
    );
  };
}

const rawFetch = globalThis.fetch;
globalThis.fetch = (input, init = {}) => {
  // only read url/method/headers from a Request, and pass Bun's own init options through untouched
  const req = new Request(input, init);
  const headers = new Headers(req.headers);
  const url = new URL(req.url);
  const attributes = {
    'http.request.method': req.method,
    'url.full': `${url.origin}${url.pathname}`,
    'server.address': url.hostname,
    'server.port': Number(url.port) || (url.protocol === 'https:' ? 443 : 80),
  };
  return tracer.startActiveSpan(req.method, { kind: SpanKind.CLIENT, attributes }, (span) => {
    propagation.inject(context.active(), headers, setter);
    return rawFetch(input, { ...init, headers })
      .then((res) => finish(span, res), (err) => fail(span, err))
      .finally(() => span.end());
  });
};
