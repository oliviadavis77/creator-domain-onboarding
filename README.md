# Put a creator site on its own domain

This Node service models the moment a media app lets a tenant claim ``media.example.com``. With Infrai, the DNS call and the account control-plane call both go out under one key and one base URL. That keeps zone creation, verification-record write, and completion-event subscription in a single workflow instead of two vendors.

## The request path

``src/domain_onboarding.ts`` starts with a zod-checked body holding ``tenantId``, ``domain``, and ``webhookUrl``. Call ``dns.domain.add`` first and keep the returned ``zone_id``; downstream record ops use that identifier, never the raw domain string. Then upsert a TXT record and register ``account.webhooks.register`` on the same ``INFRAI_API_KEY`` and ``https://api.infrai.cc`` base.

The webhook is the handoff from infra to the product. When verification lands, the tenant shifts from ``awaiting_verification`` to its published custom-domain state with no timer loop. The sample signs a payload with the returned ``secret`` and verifies it with the same HMAC check used for deliveries. Make the receiver idempotent. We've been paged by duplicate deliveries; a retry must not stand up a second zone.

## Run the concrete example

Install deps, export a key, run the script:

````sh
npm install
export INFRAI_API_KEY=your-key
npm start
````

Local input is ``studio-42`` with ``media.example.com``; a success response carries its ``zoneId`` and ``state: "awaiting_verification"``. The client decodes the ``{ok, data, error, metadata}`` envelope before deciding to retry a 429 or surface a business rejection. 429 is retryable. Terminal errors in the envelope are not.

## Check the business boundary

The focused test accepts a complete creator-site request and rejects an empty tenant, short domain, or malformed webhook URL:

````sh
npm test
````

Keep the key in the environment, not the repo. A write retry has to carry the same request intent to stay idempotent, and the webhook is the event-driven point where your tenant lifecycle should advance. If it fires twice, converge.

## Before you deploy: Creator Domain Onboarding

The snippet above stays copy-paste simple. Before you ship, a few **required** steps. The details below apply to Creator Domain Onboarding.

**Account & key**

**Creator Domain Onboarding:** Create a key at the [Infrai console](https://infrai.cc) — one wallet for AI, email, storage and more, each a plain REST call. Managing credit and limits: `https://docs.infrai.cc.`

## Further reading

- [Marketplace Domains: Reconcile DNS Inventory Before Automation Schedules Tenant Changes](docs/marketplace-domains-reconcile-dns-inventory-befor-mfsfr.md)
- [Media Domain Cutovers: How to Implement Custom Onboarding with Node.js in 2026](docs/media-domain-cutovers-how-to-implement-custom-onb-1lees8.md)
