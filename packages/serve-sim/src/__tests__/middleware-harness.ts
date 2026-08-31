import { simMiddleware } from "../middleware";

export const TOKEN = "test-token-abc123";
export const authorized = { Authorization: `Bearer ${TOKEN}` };

export function passedTheGate(response: Response): boolean {
  return response.status !== 401 && response.status !== 403;
}

export function setupMiddleware(): {
  origin: string;
  request: (path: string, init?: RequestInit) => Promise<Response>;
} {
  const handler = simMiddleware({ basePath: "/", execToken: TOKEN });
  const origin = "http://127.0.0.1:34567";
  return {
    origin,
    request: async (path, init) => {
      const response = await handler(new Request(`${origin}${path}`, init));
      if (!response) throw new Error(`Unhandled request: ${path}`);
      return response;
    },
  };
}
