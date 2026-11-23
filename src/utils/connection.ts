import type { Connection } from "../types";

/** Extracts the namespace hostname from an Azure Service Bus connection string. */
export function extractNamespace(connectionString: string): string {
  const match = connectionString.match(/Endpoint=sb:\/\/([^/;]+)/i);
  return match ? match[1] : connectionString;
}

export function groupConnections(connections: Connection[]) {
  const environments = new Map<string, Connection[]>([["prod", []], ["staging", []], ["dev", []]]);
  const other: Connection[] = [];
  for (const connection of connections) {
    const group = environments.get(connection.environment ?? "") ?? other;
    group.push(connection);
  }
  environments.set("", other);
  return Array.from(environments, ([key, items]) => ({ key, items })).filter(({ items }) => items.length > 0);
}
