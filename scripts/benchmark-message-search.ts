import { bodyString, filterMessages } from "../src/utils/messageSearch";
import type { PeekedMessage } from "../src/types";

const messages = Array.from({ length: 5000 }, (_, index) => ({
  messageId: `order-${index}`, sequenceNumber: String(index + 1),
  body: { orderId: index, description: "Realistic order line description. ".repeat(300), status: index % 3 ? "fulfilled" : "retry" },
  subject: "OrderSubmitted", contentType: "application/json", correlationId: null, partitionKey: null,
  traceParent: null, applicationProperties: null, enqueuedTimeUtc: null, expiresAtUtc: null, _source: "dlq",
} satisfies PeekedMessage));
const queries = ["order", "description", "fulfilled", "retry", "missing-value"];
const measure = (fn: (query: string) => unknown) => {
  const times = queries.map((query) => { const start = performance.now(); fn(query); return performance.now() - start; });
  return { totalMs: +times.reduce((a, b) => a + b, 0).toFixed(2), queryMs: times.map((time) => +time.toFixed(2)) };
};
const baseline = measure((query) => messages.filter((message) => bodyString(message.body).toLowerCase().includes(query)));
const cached = measure((body) => filterMessages(messages, { body, messageId: "", deadLetterReason: "", deadLetterErrorDescription: "" }));
const warm = measure((body) => filterMessages(messages, { body, messageId: "", deadLetterReason: "", deadLetterErrorDescription: "" }));
console.log(JSON.stringify({ messages: messages.length, serializedMiB: +(new TextEncoder().encode(JSON.stringify(messages)).byteLength / 1024 / 1024).toFixed(2), baseline, cached, warm }, null, 2));
