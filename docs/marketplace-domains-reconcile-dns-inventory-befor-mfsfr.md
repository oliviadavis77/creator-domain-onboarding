# Marketplace Domains: Reconcile DNS Inventory Before Automation Schedules Tenant Changes

Platform-owned zones make automatic tenant subdomains easier to coordinate; customer-owned zones require a separate authorization boundary. Resolve that boundary before importing legacy domains into a scheduler. Short answer: bootstrap the DNS inventory as an observation-only snapshot, reconcile each name to its tenant and zone owner, then grant automation permission for specific records. A discovered domain is evidence to investigate, not permission to change it.

The operational concern is replay safety. A scheduled import can run twice; a provisioning delivery can arrive after a tenant has changed its domain. Neither event should widen the worker's authority. For a marketplace assigning every seller a subdomain, the useful migration unit is an explicitly approved record belonging to a tenant, with a revision that the worker must still match when it executes.

## The incident to prevent is an inventory import becoming a write grant

Consider this hypothetical production review, rather than an account of a measured outage: a marketplace already serves sellers at `cedar.market.example` and `birch.market.example`. Cedar also has a customer-owned name, `shop.cedar.example`. A scheduled job is being introduced after those names were configured. The failure under review is a delayed provisioning task that treats an inventory row as current authorization and writes after the row's ownership has changed.

No outage history is needed to identify the unsafe transition. Discovery and mutation have been collapsed into one operation. The worker can produce the requested DNS state while acting for the wrong tenant or under an expired approval.

Pause writes first.

The invariant for this design is narrow: every DNS change must have a current tenant assignment, an explicit zone ownership classification, an approved record scope, and a matching revision. A retry can repeat the check. It cannot supply missing approval. This makes the migration a scheduling and reconciliation problem as much as an inventory problem.

There is also a mail boundary to preserve. RFC 7489 defines DMARC policy discovery using DNS TXT records and describes policy relationships between domains and subdomains. A marketplace inventory that captures only its web-serving names should not be described as a complete account of domain configuration. Treat existing mail-policy records as outside the provisioning worker's scope unless a separate change explicitly authorizes them.

## How do you bootstrap DNS inventory that predates automation?

Start with a candidate ledger assembled from the marketplace's tenant-to-domain assignments and the zone data its operators are authorized to inspect. Keep the origin of each observation. A tenant database entry expresses an application relationship; a zone export provides configuration evidence. Neither alone establishes that the new worker may modify everything it finds.

For this migration, give each candidate a tenant identifier, name, zone identifier, ownership class, observation source, observation time, and review status. Record the intended record type and desired value separately from the observed value. Missing ownership or conflicting tenant assignments should leave the candidate pending. Resist the temptation to turn an empty field into a permissive default just to finish the import.

An example review set has 3 names. These are illustrative inputs, not production measurements:

| Candidate name | Zone ownership | Initial disposition |
| --- | --- | --- |
| `cedar.market.example` | Platform-owned | Review tenant assignment and exact record scope |
| `birch.market.example` | Platform-owned | Review tenant assignment and exact record scope |
| `shop.cedar.example` | Customer-owned | Hold until customer authorization and scope are recorded |

Keep the customer-owned name visible. Excluding it would make the ledger appear cleaner while leaving the operational question unanswered. Visibility and control are different fields.

Preserve the original snapshot while review proceeds. When an operator approves a candidate, create an approved revision that identifies exactly which observation and desired state they reviewed. If either changes, require a new revision. A job should carry the identifier of that revision rather than relying on a name to find whatever approval happens to be current at execution time.

The bootstrap is ready for automation when each candidate has a recorded disposition: approved for a defined scope, deliberately unmanaged, or pending with an owner. That is a more useful completion condition than a domain count. It also gives the on-call engineer somewhere to route a blocked job without guessing who owns a customer's zone.

## Zone ownership determines the scheduler's authority

For platform-owned zones, define the worker's scope around the tenant records it is responsible for creating. Keeping discovery broad and write permissions narrow lets the inventory retain useful context without turning a seller-subdomain worker into a general zone editor. The trade-off is additional review when the record scope expands. That friction is intentional: a new category of DNS change deserves a new authorization decision.

Customer-owned zones need their own approval path. Track who can authorize changes, what that authorization covers, and how its withdrawal invalidates queued work. The marketplace's desire to provision a name is insufficient. If the customer controls the change process, represent the task as waiting for that process; do not silently convert it into the platform-owned workflow.

There are two reasonable rollout choices here. An observation-only reconciliation job minimizes the authority introduced during inventory repair, but requires an additional approval step before provisioning starts. A worker with preapproved, exact record scope can provision sooner, but its approval and revision checks become part of every execution. Choose the second only when those checks and their persistence are ready.

Neither choice justifies a whole-zone replacement. This job is to give sellers their subdomains. Preserve unrelated configuration, including DMARC policy. RFC 7489's policy discovery rules are a concrete reason to review mail-related scope separately instead of assuming that a web-domain inventory describes every relevant record.

## Put the stale-job check before the write

The following Go example is an application-level contract for the proposed worker. It deliberately delegates persistence and DNS access to interfaces. `Apply` must serialize conflicting work, validate the expected revision, and persist the replay receipt together with the state transition it controls. A DNS change is an external side effect, so the implementation also needs reconciliation when the result of a request is unknown.

The example performs no network requests and defines no provider-specific API.

```go
package provisioning

import (
	"context"
	"errors"
)

var ErrReview = errors.New("inventory review required")

type Record struct {
	TenantID string
	ZoneID   string
	Name     string
	Type     string
	Value    string
}

type Grant struct {
	Record
	Revision          uint64
	Ownership         string
	Approved          bool
	CustomerAuthorized bool
}

type Job struct {
	Record
	Revision uint64
}

type Gate interface {
	// Apply must reject stale revisions and deduplicate this operation.
	// It must protect the grant against conflicting ownership changes.
	Apply(context.Context, Job, func(Grant) error) error
}

type DNS interface {
	// Ensure reconciles exactly this record and preserves unrelated records.
	// Repeating the same desired state must not create another record.
	Ensure(context.Context, Record) error
}

func Run(ctx context.Context, gate Gate, dns DNS, job Job) error {
	if job.TenantID == "" || job.ZoneID == "" || job.Name == "" ||
		job.Type == "" || job.Value == "" || job.Revision == 0 {
		return ErrReview
	}
	return gate.Apply(ctx, job, func(grant Grant) error {
		if !grant.Approved || grant.Revision != job.Revision ||
			grant.Record != job.Record {
			return ErrReview
		}
		switch grant.Ownership {
		case "platform-owned":
		case "customer-owned":
			if !grant.CustomerAuthorized {
				return ErrReview
			}
		default:
			return ErrReview
		}
		return dns.Ensure(ctx, job.Record)
	})
}
```

The comparisons are the important part: tenant, zone, name, type, value, and revision must match the approval. The code does not infer any of them from the fact that the job reached the queue. Unknown ownership stops execution.

The interfaces carry substantial obligations. A lock around a callback doesn't make a DNS request and a database transaction atomic. Design the persisted operation identity from the approved record and revision; save enough execution state to resume reconciliation after a process stops. If the DNS request succeeds but the receipt isn't saved, the next delivery should observe the requested state and complete the same operation. It should not create a second logical provisioning action.

An approval change during an in-flight request needs an explicit serialization policy too. Define when revocation takes effect, fence new writes, and reconcile a request whose outcome arrives after revocation. Do not promise that a callback can cancel a remote change already accepted. That boundary belongs in the runbook and in the implementation review.

## Roll out by replaying the awkward cases

Before enabling writes, run the reconciler in observation-only mode and review its proposed record changes against the retained snapshot. Use a small approved set for the first write-enabled deployment. Keep pending customer-owned names in the same report so that deployment success cannot hide unfinished authorization work.

Test the transitions that make a scheduling failure expensive: deliver the same job twice, deliver an older revision after a newer approval, withdraw customer authorization before execution, and stop the worker after the DNS operation but before its receipt is recorded. Also introduce a conflicting tenant assignment. For each case, assert both the resulting record state and the decision recorded by the worker. A green return value alone does not show that unrelated records survived.

For operations, record the candidate identifier, approved revision, attempt identifier, decision, and observed result. Separate review-required work from transient execution failures. Retry the latter under a bounded policy; route the former to the inventory owner. Monitor the age of pending candidates and unfinished operations, alongside the number of rejected stale jobs. A queue with little traffic can still contain one seller waiting indefinitely for a subdomain.

Keep rollback scoped to this deployment's approved changes. Preserve evidence of the earlier state and require current authorization before applying a reversal. Restoring an entire historical zone snapshot would cross the same ownership boundary the migration was designed to protect.

This method has limits. If an authorized, authoritative inventory already exists, reconcile against it instead of creating a competing source of ownership. If customers must perform their own DNS changes, automate tracking and verification within that agreement. Automatic writes may never be the appropriate final step.

The migration is complete when legacy names have explicit dispositions and every scheduled change can explain its authority. For marketplace subdomains, that makes the next duplicate delivery routine: the worker checks the approved revision, reconciles the exact record, and leaves unrelated configuration alone.

## Sources

References:

- RFC 7489, Domain-based Message Authentication, Reporting, and Conformance (DMARC), especially policy discovery and subdomain policy: https://datatracker.ietf.org/doc/html/rfc7489
