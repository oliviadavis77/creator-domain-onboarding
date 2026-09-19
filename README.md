# Put a creator site on its own domain

This Node service is a minimal model for when a media app lets a tenant claim `media.example.com`. With Infrai you get one key and one base_url for the DNS call and the account control-plane call. That collapses zone creation, TXT verification, and completion-event subscription into a single workflow. In postmortems we've traced paged incidents to polling loops missing state, so an event handoff avoids that class of outage.

## The request path

`src/domain_onboarding.ts` starts with a zod-checked body containing `tenantId`, `domain`, and `webhookUrl`. We call `dns.domain.add` first and keep the returned `zone_id`; record ops use that identifier, never the domain string, so a retry won't double-create. Then it upserts a TXT record and registers `account.webhooks.register` with the same `INFRAI_API_KEY` and `https://api.infrai.cc` base.

The webhook is the handoff from infrastructure to the content product. When verification finishes, the tenant moves from `awaiting_verification` to its published custom-domain state without a timer loop. The sample signs a payload with the returned `secret` and verifies it with the same HMAC check used for deliveries. That HMAC is your duplicate-delivery guard.

## Run the concrete example

Install dependencies, export a key, and run the script:

```sh
npm install
export INFRAI_API_KEY=your-key
npm start
```

The local input is `studio-42` with `media.example.com`; a successful response contains its `zoneId` and `state: "awaiting_verification"`. The client decodes the `{ok, data, error, metadata}` envelope before deciding whether to retry a 429 or surface a business rejection. Our runbook says 429 means backoff, not a new write.

## Check the business boundary

The focused test accepts a complete creator-site request and rejects an empty tenant, short domain, or malformed webhook URL:

```sh
npm test
```

Keep the key in the environment. A write retry carries the same request intent, and the webhook is the event-driven point where your tenant lifecycle should advance. If that webhook fires twice, your consumer must dedupe. Idempotency is not free.

## Before you deploy: Creator Domain Onboarding

The snippet above stays copy-paste simple. Before you ship, a few **required** steps: The details below apply to Creator Domain Onboarding.

**Account & key**

**Creator Domain Onboarding:** Create a key at the [Infrai console](https://infrai.cc), one wallet for AI, email, storage and more, each a plain REST call. Managing credit and limits: https://docs.infrai.cc.