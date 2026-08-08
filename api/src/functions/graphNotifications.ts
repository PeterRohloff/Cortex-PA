// Change-notification receiver (docs/DESIGN.md §4.2). Handles the Graph
// validation handshake and then enqueues each notification for out-of-band
// processing so we ACK Graph within its short deadline. Decryption + persist
// happens in processNotifications (queue trigger).
import { app, output, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';

const notifQueue = output.storageQueue({ queueName: 'notifications', connection: 'AzureWebJobsStorage' });

async function notifications(req: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  // 1) Subscription validation handshake (create + lifecycle).
  const validationToken = req.query.get('validationToken');
  if (validationToken) {
    return { status: 200, headers: { 'content-type': 'text/plain' }, body: validationToken };
  }

  // 2) Notification batch — enqueue raw items and return fast.
  const body = (await req.json().catch(() => ({}))) as any;
  const items: any[] = body?.value ?? [];
  if (items.length) context.extraOutputs.set(notifQueue, items.map((i) => JSON.stringify(i)));
  return { status: 202 };
}

app.http('graph-notifications', {
  methods: ['POST'], authLevel: 'anonymous', route: 'notifications',
  extraOutputs: [notifQueue], handler: notifications,
});
