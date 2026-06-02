import Fastify, { type FastifyInstance } from 'fastify';
import type { AppContext } from './context';
import { registerWebhooks } from './webhooks/routes';
import { verifyRecordingSig, verifyResourceSig } from './lib/recordingUrl';
import { streamAircallContactsCsv } from './flows/exportCsv';

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

  // Self-hosted recording playback. The signed URL we put in JobNimbus activity
  // notes points here; we re-verify the HMAC + expiry, fetch the call's recording
  // from Aircall, and stream the audio to the rep's browser so it plays inline.
  app.get('/recordings/:callId', async (req, reply) => {
    const { callId } = req.params as { callId: string };
    const q = req.query as { exp?: string; sig?: string };
    const exp = Number(q.exp);
    const ok = verifyRecordingSig({
      callId,
      exp,
      sig: q.sig ?? '',
      secret: ctx.config.RECORDING_URL_SECRET,
    });
    if (!ok) {
      return reply.code(401).send({ error: 'invalid or expired link' });
    }

    let call;
    try {
      call = await ctx.aircall.getCall(callId);
    } catch (err) {
      ctx.logger.warn({ err: String(err), callId }, 'recording playback: getCall failed');
      return reply.code(404).send({ error: 'call not found' });
    }
    if (!call.recording) {
      return reply.code(404).send({ error: 'no recording for this call' });
    }

    const upstream = await ctx.aircall.streamRecording(call.recording);
    if (upstream.statusCode < 200 || upstream.statusCode >= 300) {
      ctx.logger.warn({ callId, upstream: upstream.statusCode }, 'recording playback: upstream non-2xx');
      return reply.code(502).send({ error: 'recording fetch failed' });
    }

    reply.header('content-type', upstream.contentType || 'audio/mpeg');
    reply.header('content-disposition', `inline; filename="aircall-call-${callId}.mp3"`);
    if (upstream.contentLength) reply.header('content-length', upstream.contentLength);
    reply.header('cache-control', 'private, no-store');
    reply.header('accept-ranges', 'none');
    return reply.send(upstream.body);
  });

  // Always-current CSV of every named JobNimbus contact with a valid phone, in
  // Aircall's CSV import format. Designed to be downloaded then uploaded into
  // Aircall Desktop's "Import contacts" UI (Aircall offers no programmatic
  // bulk-import endpoint). HMAC-signed + expiring; reuses RECORDING_URL_SECRET
  // so we don't need another env var.
  app.get('/export/aircall-contacts.csv', async (req, reply) => {
    const q = req.query as { exp?: string; sig?: string };
    const ok = verifyResourceSig({
      resource: 'export',
      path: '/export/aircall-contacts.csv',
      exp: Number(q.exp),
      sig: q.sig ?? '',
      secret: ctx.config.RECORDING_URL_SECRET,
    });
    if (!ok) return reply.code(401).send({ error: 'invalid or expired link' });

    const stamp = new Date().toISOString().slice(0, 10);
    reply.header('content-type', 'text/csv; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="aircall_contacts_${stamp}.csv"`);
    reply.header('cache-control', 'private, no-store');

    // Pipe each CSV line directly to the response.
    const chunks: string[] = [];
    const write = (line: string) => chunks.push(line + '\n');
    const { rows, skipped } = await streamAircallContactsCsv(ctx, write);
    ctx.logger.info({ rows, skipped }, 'served aircall-contacts.csv');
    return reply.send(chunks.join(''));
  });

  registerWebhooks(app, ctx);

  return app;
}
