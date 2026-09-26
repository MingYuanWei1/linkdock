// 端到端测试使用的本地实例配置（仅用于测试，与部署环境无关）。
export const E2E_PORT = 8799;
export const BASE_URL = `http://127.0.0.1:${E2E_PORT}`;
export const E2E_PERSIST_DIR = ".wrangler/e2e-state";
export const E2E_SECRETS = {
  APP_PASSWORD: "e2e password 123",
  UPLOAD_KEY: "e2e-upload-key-0123456789abcdef",
  SESSION_SECRET: "e2e-session-secret-0123456789abcdef",
};

export function devCommand(port: number, persistDir: string): string {
  const vars = Object.entries(E2E_SECRETS)
    .map(([k, v]) => `--var "${k}:${v}"`)
    .join(" ");
  return [
    `rm -rf ${persistDir}`,
    `npx wrangler d1 migrations apply linkdock --local --persist-to ${persistDir}`,
    `npx wrangler dev --ip 127.0.0.1 --port ${port} --persist-to ${persistDir} --show-interactive-dev-session=false ${vars}`,
  ].join(" && ");
}
