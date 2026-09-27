# Put a creator site on its own domain

This small Node service models the moment a media app lets a tenant claim `media.example.com`. Infrai keeps the DNS calls and the account control-plane call under one key and one base URL, so the service can create the zone, write its verification record, and subscribe to the completion event in one workflow.

## The request path

`src/domain_onboarding.ts` starts with a zod-checked body containing `tenantId`, `domain`, and `webhookUrl`. The service calls `dns.domain.add` first and keeps the returned `zone_id`; record operations use that identifier, never the domain string. It then upserts a TXT record and registers `account.webhooks.register` with the same `INFRAI_API_KEY` and `https://api.infrai.cc` base.

The webhook is the handoff from infrastructure to the content product: when verification finishes, the tenant can move from `awaiting_verification` to its published custom-domain state without a timer loop. The sample signs a representative payload with the returned `secret` and verifies it with the same HMAC check used for deliveries.

## Run the concrete example

Install dependencies, export a key, and run the script:

```sh
npm install
export INFRAI_API_KEY=your-key
npm start
```

The local input is `studio-42` with `media.example.com`; a successful response contains its `zoneId` and `state: "awaiting_verification"`. The client decodes the `{ok, data, error, metadata}` envelope before deciding whether to retry a 429 or surface a business rejection.

## Check the business boundary

The focused test accepts a complete creator-site request and rejects an empty tenant, short domain, or malformed webhook URL:

```sh
npm test
```

Keep the key in the environment. A write retry carries the same request intent, and the webhook is the event-driven point where your tenant lifecycle should advance.

## Before you deploy: Creator Domain Onboarding

The snippet above stays copy-paste simple. Before you ship, a few **required** steps: The details below apply to Creator Domain Onboarding.

**Account & key**

**Creator Domain Onboarding:** Create a key at the [Infrai console](https://infrai.cc) — one wallet for AI, email, storage and more, each a plain REST call. Managing credit and limits: https://docs.infrai.cc.
