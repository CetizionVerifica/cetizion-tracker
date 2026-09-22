# Webhooks and n8n

The tracker can tell other systems when something happens, and can take
enquiries in from a website form or n8n. Endpoints are managed under
**Admin → Webhooks**.

## Events

| Event | When |
| --- | --- |
| `enquiry.created` | an enquiry is logged (by hand, from the inbox, or posted in) |
| `quotation.sent` | a quotation is marked sent or its acceptance link goes out |
| `quotation.stage_changed` | a quotation moves on the pipeline |
| `quotation.won` / `quotation.lost` | it reaches Won or Lost |
| `po.received` | a purchase order is registered |
| `project.delivered` | a PO gets its delivery date |
| `invoice.issued` | a payment stage gets an invoice number |
| `invoice.overdue` | an invoice is 1, 15, 30, 45, 60 or 90 days overdue (daily check) |
| `payment.received` | a payment is recorded |
| `visit.scheduled` | a visit is planned |
| `renewal.opened` | a renewal quotation is drafted |
| `task.overdue` | a task passes its due date (daily check) |

Each endpoint can also be limited to a minimum value or one sector.

## What arrives

```http
POST <your url>
Content-Type: application/json
X-Cetizion-Event: quotation.won
X-Cetizion-Delivery: evt_42_ep_3
Idempotency-Key: evt_42_ep_3
X-Cetizion-Signature: t=1789600000,v1=5f2c…
```

```json
{
  "id": "evt_42_ep_3",
  "event": "quotation.won",
  "occurred_at": "2026-09-17T10:00:00.000Z",
  "entity": "quotation",
  "entity_id": "CTZ/QT/2026/062",
  "data": { "quotation_no": "CTZ/QT/2026/062", "client_name": "Hetero", "value": 136000, "currency": "INR", "stage": "Won, PO received" }
}
```

People's names, emails and phone numbers are left out unless the endpoint
has **Include personal data** switched on. No secrets are ever sent.

## Checking the signature

`v1` is HMAC-SHA256 of `"<t>.<raw body>"` with the endpoint's secret (shown
once, when the endpoint is created or its secret rotated). Reject the call
if the signature differs or `t` is more than five minutes old. Use the
`Idempotency-Key` to ignore a delivery you have already handled.

In an n8n **Code** node after the Webhook node (with "Raw body" on):

```js
const crypto = require('crypto');
const secret = $env.CETIZION_WEBHOOK_SECRET;
const header = $json.headers['x-cetizion-signature'];
const raw = Buffer.from($binary.data.data, 'base64').toString('utf8');
const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')));
const expected = crypto.createHmac('sha256', secret).update(`${parts.t}.${raw}`).digest('hex');
if (expected !== parts.v1 || Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) throw new Error('Bad signature');
return [{ json: JSON.parse(raw) }];
```

## Retries

A delivery that does not get a 2xx answer within ten seconds is retried
after 1, 5, 15, 60, 180, 360 and 720 minutes, then marked failed with the
last answer. Any delivery can be replayed from the Webhooks page. Turning an
endpoint off either holds its events until it is back on, or drops them, as
chosen on the endpoint.

## Recipe 1: post wins to a chat group

1. In n8n, add a **Webhook** node (POST, raw body on) and copy its production URL.
2. In the tracker, add an endpoint with that URL and the event `quotation.won`.
   Keep the secret in n8n as `CETIZION_WEBHOOK_SECRET`.
3. Add the **Code** node above, then a **Microsoft Teams** (or Slack, or
   WhatsApp Business) node with the message
   `🎉 {{$json.data.client_name}} accepted {{$json.data.quotation_no}}, {{$json.data.currency}} {{$json.data.value}}`.
4. Press **Send test event** in the tracker, then mark a quotation won.

## Recipe 2: escalate a 45-day overdue invoice

1. Webhook node, as above; the tracker endpoint listens to `invoice.overdue`.
   The event is sent on an invoice's first overdue day and again at 15, 30,
   45, 60 and 90 days, with `days_overdue` in the data.
2. After the Code node, an **IF** node: `{{$json.data.days_overdue}} >= 45`.
3. An **Outlook** (or Gmail) node emails the director:
   `{{$json.data.client_name}}: invoice {{$json.data.invoice_no}} is {{$json.data.days_overdue}} days overdue ({{$json.data.currency}} {{$json.data.amount}}).`

## Enquiries in

`POST /api/hooks/enquiries` takes

```json
{ "client_name": "NewCo", "contact_person": "Meera Iyer", "contact_email": "meera@newco.example", "service": "EcoVadis assessment", "source": "Website", "message": "…" }
```

signed the same way with `INCOMING_WEBHOOK_SECRET`. It is refused unless
that variable is set and `incoming_enquiries_enabled` is `true` in Settings.
