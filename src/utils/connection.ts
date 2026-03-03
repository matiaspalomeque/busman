/** Extracts the namespace hostname from an Azure Service Bus connection string. */
export function extractNamespace(connectionString: string): string {
  const match = connectionString.match(/Endpoint=sb:\/\/([^/;]+)/i);
  return match ? match[1] : connectionString;
}
