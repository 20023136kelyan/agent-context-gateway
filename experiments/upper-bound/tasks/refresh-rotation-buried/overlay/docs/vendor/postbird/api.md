# Postbird API reference (copy)

Transactional email. Used by the backend for sign-up, receipts and alerts.

## Sending

`POST /v2/messages` with `{ "to": "…", "template": "receipt", "data": { … } }`.

Returns 202 with a message id. Delivery is asynchronous; subscribe to
`message.delivered` and `message.bounced` webhooks.

## Suppression list

Hard bounces and spam complaints add the address to the suppression list.
Suppressed addresses are skipped silently. Remove them in the console.

## Limits

100 messages per second per account. Attachments up to 10 MB.
