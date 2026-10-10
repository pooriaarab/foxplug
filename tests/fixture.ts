import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** One request that the fixture API server received. */
export interface Seen {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

/** A real HTTP server on 127.0.0.1. With no handler it answers `{"ok":true}`. */
export async function fixture(handler?: (seen: Seen, res: ServerResponse) => void) {
  const seen: Seen[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const item = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body };
    seen.push(item);
    if (handler) return handler(item, res);
    res.setHeader("content-type", "application/json");
    res.end('{"ok":true}');
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  return {
    host: `127.0.0.1:${port}`,
    port,
    seen,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}
