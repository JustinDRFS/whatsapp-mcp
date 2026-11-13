// Réglages lus dans les variables d'environnement (jamais en argument d'une commande).

export interface Config {
  port: number;
  dataDir: string;
  mcpToken: string;
  adminPassword: string;
  openaiApiKey?: string;
  openaiModel?: string;
  publicHost?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const problems: string[] = [];
  const mcpToken = env.MCP_TOKEN ?? '';
  const adminPassword = env.ADMIN_PASSWORD ?? '';
  if (!/^[0-9a-f]{64}$/i.test(mcpToken)) problems.push('MCP_TOKEN doit faire 64 caractères hexadécimaux (openssl rand -hex 32)');
  if (adminPassword.length < 16) problems.push('ADMIN_PASSWORD doit faire au moins 16 caractères');
  if (problems.length) throw new Error(`Configuration incomplète :\n- ${problems.join('\n- ')}`);
  return {
    port: Number(env.PORT ?? 8080),
    dataDir: env.DATA_DIR ?? '/data',
    mcpToken,
    adminPassword,
    openaiApiKey: env.OPENAI_API_KEY || undefined,
    openaiModel: env.OPENAI_MODEL || undefined,
    publicHost: env.PUBLIC_HOST || undefined,
  };
}
