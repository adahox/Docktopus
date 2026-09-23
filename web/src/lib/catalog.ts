export const RUNTIMES = [
  ["php84", "PHP 8.4"],
  ["php83", "PHP 8.3"],
  ["php82", "PHP 8.2"],
  ["php81", "PHP 8.1"],
  ["node20", "Node.js 20"],
  ["node18", "Node.js 18"],
  ["node22", "Node.js 22"],
  ["python312", "Python 3.12"],
  ["python311", "Python 3.11"],
  ["go122", "Go 1.22"],
] as const;

export const WEBSERVERS = [
  ["nginx", "Nginx"],
  ["apache", "Apache"],
  ["none", "Direto"],
] as const;

export const DATABASES = [
  ["mysql8", "MySQL 8"],
  ["postgres16", "PostgreSQL 16"],
  ["postgres15", "PostgreSQL 15"],
  ["redis", "Redis"],
  ["mongo", "MongoDB"],
  ["rabbitmq", "RabbitMQ"],
] as const;

export function markKey(id: string): string {
  if (id.startsWith("php")) return "php";
  if (id.startsWith("node")) return "node";
  if (id.startsWith("python")) return "python";
  if (id.startsWith("go")) return "go";
  if (id.startsWith("mysql")) return "mysql";
  if (id.startsWith("postgres")) return "postgres";
  if (id in { nginx: 1, apache: 1, redis: 1, mongo: 1, rabbitmq: 1, github: 1 }) return id;
  return "";
}

export function labelOf(options: readonly (readonly [string, string])[], value: string): string {
  return options.find(([id]) => id === value)?.[1] || value;
}
