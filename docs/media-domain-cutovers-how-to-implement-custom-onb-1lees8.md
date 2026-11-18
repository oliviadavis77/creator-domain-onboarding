# Media Domain Cutovers: How to Implement Custom Onboarding with Node.js in 2026

A publishing deadline cannot make DNS propagation finish sooner. TL;DR: for custom domain onboarding, add the domain, immediately persist its returned zone_id on the tenant, upsert the complete record, and poll verification on a schedule outside the Node.js request. For a media hostname cutover, preserve the previous destination and reserve time to verify the return trip. Choose the release window around that constraint.

For a bounded production rehearsal, I would put news.example.com on a release sheet with two destinations: the existing publication site and its replacement. The editorial launch is the deadline; the hostname change is a prerequisite. This is a proposed exercise, not an account of an incident. Its useful failure case is an operator reaching the deadline with an accepted record write but no successful scheduled verification.

Hold the launch.

The invariant is that a write acknowledgment advances the operation to verification pending. It never advances the editorial release. Moving those two decisions into one success flag hides the exact distinction the operator needs during a cutover.

## How should Node.js custom domain onboarding add a zone before the deadline?

Start with the abort decision, before choosing a polling interval. An illustrative release plan might allow a 20-minute preparation window, check every 60 seconds, and stop attempting the forward cutover at the deadline. These are application policy values, not measured propagation times or service guarantees. Faster checks produce more observations; they do not accelerate propagation. A short interval is useful only if somebody or something can act on the result.

At the deadline, keep the release blocked if verification is still pending. Decide explicitly whether to continue waiting or restore the previous record. A restoration is another write followed by scheduled verification, so its completion cannot be assumed from the return value of the write either. Preserve both serving destinations while the operation is unresolved.

There is a second trap: a verification job queued before rollback can finish afterward. Its success belongs to the old intended destination. Give each change a revision and attach that revision to every scheduled check. A worker must reject evidence for an obsolete revision, even if the hostname and tenant still match.

This is the scheduling decision that matters more than shaving time from the onboarding response. The release has a deadline. Each observation has an owner.

Don't reset the clock on a retry.

## Work backward from the release into three durable handoffs

First, prepare the return path. Store the tenant, hostname, previous complete record, intended complete record, operation identifier, and release deadline in application storage. The field names in this note describe application state. They are not a provider request schema. Reopening the onboarding page must load that same operation; enforce uniqueness and conditional updates in the persistent store so concurrent requests cannot create competing cutovers.

Next, add the domain and immediately save the returned zone_id on the tenant. Record operations need that identifier. The acceptance condition is a fresh worker being able to load it without relying on the original HTTP request. If an add response is lost, reconcile the existing operation before blindly starting another one. A missing response does not establish that the remote action never happened.

Then upsert the record with zone_id, type, name, and content together. There is no partial write in this sequence. Once the write succeeds, save verification-pending state and arrange a scheduled check. The Node.js onboarding handler can return progress at this boundary; it should not wait for propagation inside the customer request. Reuse the operation's idempotency identity on retries and recover pending scheduling work from durable state after a restart.

The handoff is complete only when another worker can find the pending operation and its next check time. A successful write followed by a lost scheduling attempt otherwise leaves a hostname waiting forever. Treat finding overdue operations as part of the worker's normal reconciliation loop.

## Rehearse the deadline and stale-job rules in Go

Save the following standard-library program as gate.go and run `go run gate.go`. Set INFRAI_BASE_URL to the API's HTTPS origin without a path and INFRAI_API_KEY to your credential. The program first fetches the public discovery contract over HTTP, then exercises the application decisions around the DNS calls. Discovery requires no authentication; the environment-supplied Bearer header illustrates the authentication pattern for protected calls. The embedded data and verification results are illustrative. This program performs no DNS writes and is not a substitute for a DNS adapter or durable tenant storage.

The three handoffs above map to `prepare`, `acceptWrite`, and `observe`. Each has an executable assertion in `main`. In an integration, call `prepare` after persisting the zone returned by the add call, `acceptWrite` after a successful complete upsert, and `observe` with a result from a scheduled verification call. The revision must travel with the scheduled job rather than being read from the latest operation when the result arrives.

```go
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

func inspectContract() error {
	origin := strings.TrimRight(os.Getenv("INFRAI_BASE_URL"), "/")
	key := os.Getenv("INFRAI_API_KEY")
	u, err := url.Parse(origin)
	if err != nil || u.Scheme != "https" || u.Host == "" ||
		u.Path != "" || u.RawQuery != "" || u.Fragment != "" ||
		u.User != nil || key == "" {
		return errors.New("set the HTTPS API origin and API key")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	client := &http.Client{
		Timeout: 15 * time.Second,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	for attempt := 0; attempt < 3; attempt++ {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet,
			origin+"/v1/discovery", nil)
		if err != nil {
			return err
		}
		req.Header.Set("Authorization", "Bearer "+key)
		resp, err := client.Do(req)
		if err != nil {
			return err
		}
		body, readErr := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
		resp.Body.Close()
		if readErr != nil {
			return readErr
		}
		if resp.StatusCode == http.StatusTooManyRequests && attempt < 2 {
			delay := time.Second * time.Duration(1<<attempt)
			retry := resp.Header.Get("Retry-After")
			if seconds, err := strconv.ParseInt(retry, 10, 64); err == nil && seconds >= 0 {
				if seconds > 60 {
					return errors.New("retry interval exceeds execution budget")
				}
				if requested := time.Duration(seconds) * time.Second; requested > delay {
					delay = requested
				}
			} else if when, err := http.ParseTime(retry); err == nil {
				if requested := time.Until(when); requested > delay {
					delay = requested
				}
			}
			timer := time.NewTimer(delay)
			select {
			case <-ctx.Done():
				timer.Stop()
				return ctx.Err()
			case <-timer.C:
			}
			continue
		}
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			return fmt.Errorf("discovery status=%d body=%s", resp.StatusCode, body)
		}
		var manifest map[string]json.RawMessage
		if err := json.Unmarshal(body, &manifest); err != nil {
			return err
		}
		if _, ok := manifest["capabilities"]; !ok {
			return errors.New("discovery response has no capabilities field")
		}
		fmt.Println("Discovery contract received; starting local rehearsal")
		return nil
	}
	return errors.New("discovery retry budget exhausted")
}

type Record struct {
	Type, Name, Content string
}

type Cutover struct {
	ID, Tenant, ZoneID string
	Previous, Desired Record
	Revision, Written int
	Verified          bool
	Deadline, Next    time.Time
	Interval          time.Duration
}

func complete(r Record) bool {
	return r.Type != "" && r.Name != "" && r.Content != ""
}

func prepare(c *Cutover) error {
	if c.ID == "" || c.Tenant == "" || c.ZoneID == "" ||
		!complete(c.Previous) || !complete(c.Desired) ||
		c.Previous.Type != c.Desired.Type ||
		c.Previous.Name != c.Desired.Name ||
		c.Revision < 1 || c.Interval <= 0 || c.Deadline.IsZero() {
		return errors.New("persist the zone, complete records, and release policy")
	}
	return nil
}

func acceptWrite(c *Cutover, revision int, now time.Time) error {
	if err := prepare(c); err != nil {
		return err
	}
	if revision != c.Revision {
		return errors.New("write acknowledgment belongs to an obsolete revision")
	}
	if c.Written == revision {
		return nil
	}
	c.Written = revision
	c.Verified = false
	c.Next = now.Add(c.Interval)
	return nil
}

func observe(c *Cutover, revision int, passed bool, now time.Time) string {
	if revision != c.Revision || c.Written != revision {
		return "ignore obsolete observation"
	}
	if c.Verified {
		return "already verified"
	}
	if now.Before(c.Next) {
		return "check is not due"
	}
	if passed {
		c.Verified = true
		return "destination verified; evaluate release deadline"
	}
	c.Next = now.Add(c.Interval)
	return "verification pending"
}

func releaseAllowed(c Cutover, now time.Time) bool {
	return c.Verified && c.Written == c.Revision && now.Before(c.Deadline)
}

func requestReturn(c *Cutover) bool {
	if c.Desired == c.Previous {
		return false
	}
	c.Desired = c.Previous
	c.Revision++
	c.Verified = false
	c.Next = time.Time{}
	return true
}

func require(ok bool, message string) {
	if !ok {
		panic(message)
	}
}

func main() {
	if err := inspectContract(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	start := time.Date(2026, time.November, 11, 12, 0, 0, 0, time.UTC)
	c := Cutover{
		ID: "publisher-launch", Tenant: "newsroom", ZoneID: "example-zone",
		Previous: Record{"CNAME", "news.example.com", "old.example.net"},
		Desired:  Record{"CNAME", "news.example.com", "new.example.net"},
		Revision: 1, Interval: time.Minute, Deadline: start.Add(20 * time.Minute),
	}
	require(prepare(&c) == nil, "preparation must pass")
	require(acceptWrite(&c, 1, start) == nil, "write must be accepted")
	firstDue := c.Next
	require(acceptWrite(&c, 1, start.Add(30*time.Second)) == nil,
		"duplicate acknowledgment must be harmless")
	require(c.Next.Equal(firstDue), "retry must not postpone verification")
	fmt.Println(observe(&c, 1, false, firstDue))
	require(!releaseAllowed(c, c.Deadline), "deadline must block launch")
	require(requestReturn(&c), "return must create a new revision")
	require(!requestReturn(&c), "repeated return must be harmless")
	fmt.Println(observe(&c, 1, true, c.Deadline))
	require(!c.Verified, "old evidence must not verify the return")
	require(acceptWrite(&c, 2, c.Deadline) == nil, "return write must be accepted")
	fmt.Println(observe(&c, 2, true, c.Next))
	require(c.Verified, "return must have its own verification")
	require(!releaseAllowed(c, c.Next), "late return must not release the launch")
	fmt.Println("Rehearsal passed; launch remains held.")
}
```

The duplicate acknowledgment must leave the first check time unchanged. The stale forward observation must leave the return unverified. Finally, a verified return after the deadline must keep the launch held. Those are decision checks, not propagation benchmarks.

Keep those assertions.

Production workers need transactional state updates or equivalent concurrency control around these transitions. The in-memory example has one caller. It does not establish distributed locking, authenticate verification evidence, or make remote writes atomic with local persistence. Keep the stable operation identifier beyond any provider deduplication window, and reconcile uncertain remote outcomes before replaying a write.

## Choose an administrative boundary, then choose a polling budget

The provider comparison belongs after the release policy because the same deadline problem survives a change of API. These are integration choices, with no measured ranking of propagation speed.

| Option | Administrative model | Fit and limit for the publisher |
| --- | --- | --- |
| Cloudflare DNS | Zones and DNS record management | A candidate when the hostname already lives in a Cloudflare-managed zone. Record management still needs an application release decision and saved return destination. |
| Amazon Route 53 | Hosted zones and resource record sets | A candidate when the publishing system operates within AWS. Its change-status workflow is a control-plane signal; keep the publication deadline and approval in application state. |
| Google Cloud DNS | Managed zones, resource record sets, and changes | A candidate when Google Cloud owns the operational boundary. Integrate its change model with the worker, while retaining the previous record separately for the return path. |

Infrai offers one key, one wallet, one bill across DNS and scheduling through a plain REST API. This single API key and single bill reduce the separate credentials and invoices the team manages when combining the hostname workflow with scheduled jobs. Go and Node.js can send HTTP requests without installing a dedicated SDK or maintaining a client-library version. The unified API covers 295 routes across 20 modules; its public, unauthenticated discovery surface exposes request and response schemas, giving the implementer a way to inspect the adapter contract before writing it. The additional API relationship is a trade-off; a publisher required to keep DNS administration inside its existing AWS boundary has a direct reason to prefer Route 53 instead.

None of these administrative models supplies the publisher's release policy. Pick the one the team can reconcile under a deadline, then allocate a polling budget that fits its request limits and operating procedures. Do not turn an unmeasured provider comparison into a claim that one option makes propagation faster.

## Stop when the return path is missing

This runbook assumes a previous working destination and the ability to restore its complete record. For a brand-new hostname with no prior destination, the return procedure does not apply; keep onboarding pending until verification succeeds. If the old publication site is already retired, rebuild the release plan before calling the change reversible.

The example also keeps release eligibility narrower than site readiness. A DNS verification result alone does not certify the replacement media application's behavior. Define those application acceptance checks separately, and authorize publication only when both the hostname workflow and the workload's own release criteria pass.

## Sources

References for the DNS administration models and terminology used in the comparison:

- [Cloudflare DNS record API](https://developers.cloudflare.com/api/resources/dns/subresources/records/)
- [Amazon Route 53 resource record-set changes](https://docs.aws.amazon.com/Route53/latest/APIReference/API_ChangeResourceRecordSets.html)
- [Amazon Route 53 change status](https://docs.aws.amazon.com/Route53/latest/APIReference/API_GetChange.html)
- [Google Cloud DNS zone management](https://cloud.google.com/dns/docs/zones)
- [Google Cloud DNS record management](https://cloud.google.com/dns/docs/records)
