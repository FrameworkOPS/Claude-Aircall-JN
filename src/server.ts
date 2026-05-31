import Fastify, { type FastifyInstance } from 'fastify';
import type { AppContext } from './context';
import { registerWebhooks } from './webhooks/routes';

/**
 * Build the Fastify app. A custom JSON parser keeps the raw body around so the
 * webhook handlers can verify HMAC signatures over the exact bytes received.
 */
export function buildServer(ctx: AppContext): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 5 * 1024 * 1024 });

  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (req, body, done) => {
      (req as { rawBody?: string }).rawBody = body as string;
      try {
        done(null, body === '' ? {} : JSON.parse(body as string));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  app.get('/health', async () => ({ status: 'ok', ts: new Date().toISOString() }));

  registerWebhooks(app, ctx);

  return app;
}
