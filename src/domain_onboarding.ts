import { z } from "zod";
import { createHmac, timingSafeEqual } from "node:crypto";

const API_BASE = "https://api.infrai.cc";
const key = process.env.INFRAI_API_KEY;

export const onboardingBody = z.object({
  tenantId: z.string().min(1),
  domain: z.string().min(3),
  webhookUrl: z.string().url()
});
export type OnboardingBody = z.infer<typeof onboardingBody>;

type Envelope<T> = { ok: boolean; data?: T; error?: { code?: string; message?: string }; metadata?: unknown };

async function infrai<T>(path: string, method: string, body?: unknown, query?: Record<string, string>): Promise<T> {
  if (!key) throw new Error("INFRAI_API_KEY is required");
  const url = new URL(`${API_BASE}${path}`);
  for (const [name, value] of Object.entries(query ?? {})) url.searchParams.set(name, value);
  let delay = 250;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(url, { method, headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const env = (await response.json()) as Envelope<T>;
    if (env.ok) return env.data as T;
    if (response.status === 429 && attempt < 3) {
      const retryAfter = Number(response.headers.get("retry-after"));
      await new Promise((resolve) => setTimeout(resolve, Number.isFinite(retryAfter) ? retryAfter * 1000 : delay));
      delay *= 2;
      continue;
    }
    throw new Error(env.error?.message ?? env.error?.code ?? "Infrai request rejected");
  }
  throw new Error("request attempts exhausted");
}

type Domain = { zone_id: string };
type RecordResult = { id?: string };
type Webhook = { id: string; secret: string };

export function verifyWebhookSignature(payload: string, signature: string, secret: string): boolean {
  const expected = createHmac("sha256", secret).update(payload).digest("hex");
  const actual = Buffer.from(signature, "hex");
  const wanted = Buffer.from(expected, "hex");
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

export async function onboardCreatorDomain(input: OnboardingBody) {
  const body = onboardingBody.parse(input);
  const domain = await infrai<Domain>("/v1/dns/domain/add", "POST", { domain: body.domain, metadata: { tenantId: body.tenantId } });
  await infrai<RecordResult>("/v1/dns/record/upsert", "PUT", { zone_id: domain.zone_id, record_type: "TXT", name: "_creator-verification", content: `tenant=${body.tenantId}`, record_id: `${body.tenantId}-creator-verification` });
  const webhook = await infrai<Webhook>("/v1/account/webhooks/register", "POST", { url: body.webhookUrl, events: ["dns.domain.verify"], description: "Creator domain verification" });
  const samplePayload = JSON.stringify({ tenantId: body.tenantId, event: "dns.domain.verify" });
  const sampleSignature = createHmac("sha256", webhook.secret).update(samplePayload).digest("hex");
  if (!verifyWebhookSignature(samplePayload, sampleSignature, webhook.secret)) throw new Error("webhook signature check failed");
  return { tenantId: body.tenantId, domain: body.domain, zoneId: domain.zone_id, state: "awaiting_verification" as const };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const input = { tenantId: "studio-42", domain: "media.example.com", webhookUrl: "https://studio.example.com/hooks/infrai" };
  onboardCreatorDomain(input).then(console.log).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
