import { createHmac } from "node:crypto";
import { onboardingBody, verifyWebhookSignature } from "./domain_onboarding.ts";

const accepted = onboardingBody.safeParse({ tenantId: "studio-42", domain: "media.example.com", webhookUrl: "https://studio.example.com/hook" });
const rejected = onboardingBody.safeParse({ tenantId: "", domain: "x", webhookUrl: "not-a-url" });
if (!accepted.success || rejected.success) throw new Error("domain onboarding boundary decision changed");
const payload = "{\"event\":\"dns.domain.verify\"}";
const signature = createHmac("sha256", "test-secret").update(payload).digest("hex");
if (!verifyWebhookSignature(payload, signature, "test-secret")) throw new Error("signature decision changed");
console.log("domain input validation: accepted creator site, rejected incomplete request");
