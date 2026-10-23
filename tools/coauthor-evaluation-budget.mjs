import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { reserveCost } from "./coauthor-evaluation-core.mjs";

export function createBudgetLedger(profile, currency, limitMicros, maxRequests) {
  assert(Number.isSafeInteger(limitMicros) && limitMicros > 0);
  assert(Number.isSafeInteger(maxRequests) && maxRequests > 0);
  const requestReserve = reserveCost(profile, currency, 1) / 10;
  const records = [];
  let blocked = false;
  const snapshot = () => ({
    currency, limitMicros, requestReserveMicros: requestReserve, blocked,
    conservativeSpentMicros: records.reduce((n, r) => n + r.chargedMicros, 0),
    records: structuredClone(records),
  });
  return {
    snapshot,
    reserve() {
      const spent = snapshot().conservativeSpentMicros;
      if (blocked || records.length >= maxRequests || spent + requestReserve > limitMicros) {
        blocked = true;
        throw new Error("Evaluation budget exhausted; no upstream request sent.");
      }
      const record = { id: records.length + 1, state: "reserved", chargedMicros: requestReserve };
      records.push(record);
      return record.id;
    },
    settle(id, usage, status) {
      const record = records.find((r) => r.id === id);
      assert(record && record.state === "reserved", "Invalid or repeated settlement.");
      record.httpStatus = status;
      const input = usage?.prompt_tokens;
      const output = usage?.completion_tokens;
      const valid = status === 200 && Number.isSafeInteger(input) && input >= 0
        && Number.isSafeInteger(output) && output >= 0;
      if (!valid) {
        record.state = "unknownUsageReserveHeld";
        return;
      }
      const cost = Math.ceil(input * profile.input_price_micros_per_million / 1_000_000)
        + Math.ceil(output * profile.output_price_micros_per_million / 1_000_000);
      if (input > profile.context_window || output > Math.min(profile.max_output_tokens, 2048)
          || !Number.isSafeInteger(cost) || cost > record.chargedMicros) {
        blocked = true;
        record.state = "providerExceededReservation";
        record.chargedMicros = Number.isSafeInteger(cost) ? Math.max(record.chargedMicros, cost) : record.chargedMicros;
        throw new Error("Provider usage exceeded its configured envelope; no further requests allowed.");
      }
      record.state = "settledConservativeUsage";
      record.inputTokens = input;
      record.outputTokens = output;
      // Cache hits are charged at the uncached price here, conservatively.
      record.chargedMicros = cost;
    },
  };
}

export function responseUsage(text, contentType) {
  try {
    if (!contentType.includes("text/event-stream")) return JSON.parse(text).usage ?? null;
    let usage = null;
    // Only complete SSE frames are trusted, including when the client disconnects.
    for (const frame of text.split(/\r?\n\r?\n/).slice(0, -1)) {
      const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart()).join("\n").trim();
      if (!data || data === "[DONE]") continue;
      const message = JSON.parse(data);
      if (message.usage) usage = message.usage;
    }
    return usage;
  } catch { return null; }
}

export async function createBudgetRelay({ profile, currency, limitMicros, maxRequests, fetchImpl = fetch }) {
  const ledger = createBudgetLedger(profile, currency, limitMicros, maxRequests);
  assert(ledger.snapshot().requestReserveMicros <= limitMicros,
    "Budget cannot reserve even one configured request; no provider called.");
  const endpoint = `${profile.base_url.replace(/\/+$/, "")}/chat/completions`;
  const server = createServer(async (request, response) => {
    let id;
    let settled = false;
    const chunks = [];
    let contentType = "";
    let status;
    const controller = new AbortController();
    response.on("close", () => { if (!response.writableEnded) controller.abort(); });
    try {
      assert(request.method === "POST" && request.url === "/v1/chat/completions", "Invalid relay request.");
      assert(/^Bearer [^\r\n]+$/.test(request.headers.authorization ?? ""), "Credential required.");
      const parts = [];
      let bytes = 0;
      for await (const part of request) {
        bytes += part.length;
        assert(bytes <= 2_000_000, "Request too large.");
        parts.push(part);
      }
      const body = Buffer.concat(parts);
      const input = JSON.parse(body);
      assert.equal(input.model, profile.model_id, "Model switching is prohibited.");
      const outputLimit = input.max_tokens ?? input.max_completion_tokens;
      assert(Number.isInteger(outputLimit) && outputLimit > 0
        && outputLimit <= Math.min(profile.max_output_tokens, 2048), "Output limit exceeded.");
      for (const key of ["max_tokens", "max_completion_tokens"]) {
        assert(input[key] === undefined || input[key] === outputLimit, "Conflicting output limits.");
      }
      assert(input.tools === undefined || (Array.isArray(input.tools)
        && input.tools.every((tool) => tool.type === "function")), "Only local function tools allowed.");
      id = ledger.reserve();
      const upstream = await fetchImpl(endpoint, {
        method: "POST", redirect: "error",
        headers: { "Content-Type": "application/json", Authorization: request.headers.authorization },
        body, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(95_000)]),
      });
      contentType = upstream.headers.get("content-type") ?? "application/json";
      status = upstream.status;
      response.writeHead(upstream.status, { "Content-Type": contentType, "Cache-Control": "no-store" });
      let received = 0;
      for await (const part of upstream.body) {
        received += part.length;
        assert(received <= 4_000_000, "Response too large.");
        chunks.push(part);
        if (!response.write(part)) await once(response, "drain", { signal: controller.signal });
      }
      settled = true;
      ledger.settle(id, responseUsage(Buffer.concat(chunks).toString("utf8"), contentType), upstream.status);
      response.end();
    } catch {
      if (id && !settled) {
        settled = true;
        try {
          ledger.settle(id, responseUsage(Buffer.concat(chunks).toString("utf8"), contentType), status);
        } catch { /* The ledger already blocks further requests on excess usage. */ }
      }
      if (!response.headersSent) response.writeHead(ledger.snapshot().blocked ? 402 : 502,
        { "Content-Type": "application/json" }).end(JSON.stringify({
        error: { message: "Evaluation relay stopped this request; consult the credential-free budget ledger." },
      }));
      else response.destroy();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    snapshot: ledger.snapshot,
    async close() {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    },
  };
}
