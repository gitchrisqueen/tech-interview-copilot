# System design checklist

## The 4-step frame (45 min)

1. **Requirements (5 min)** - Functional: core user actions, in scope vs out. Non-functional:
   scale (DAU, QPS, data size), latency targets, consistency vs availability, durability.
   Do the napkin math out loud: QPS = DAU x actions / 86,400; storage = items x size x years.
2. **High-level design (10-15 min)** - Client -> LB -> stateless app tier -> data stores.
   Draw the write path and the read path separately. Name every arrow's protocol.
3. **Deep dives (15-20 min)** - Let the interviewer pick, or steer to the hardest part:
   data model, sharding, the hot path, the feed/fan-out, the rate limiter.
4. **Wrap (5 min)** - Bottlenecks, failure modes, monitoring, what you'd do with more time.

## Building blocks and when to say them

| Need | Reach for | One-liner tradeoff |
|---|---|---|
| Read-heavy traffic | Cache (Redis/CDN) | invalidation strategy is the real design |
| Write bursts, decoupling | Message queue (Kafka/SQS) | at-least-once means consumers must be idempotent |
| Data too big for one box | Sharding/partitioning | pick the key to avoid hot partitions |
| Read scaling on SQL | Read replicas | replication lag = stale reads |
| Global low latency | CDN + regional deployments | consistency across regions gets hard |
| Full-text search | Inverted index (Elasticsearch) | eventually consistent with the source of truth |
| Uniqueness / counters at scale | ID generator (Snowflake), CRDTs, approximate (HyperLogLog) | exactness costs coordination |

## SQL vs NoSQL in one breath

Relational: transactions, joins, ad-hoc queries, strong consistency. Document/KV: flexible
schema, horizontal scale by default, denormalized for the access pattern. Say: "I'd start
relational unless the access pattern is a single-key lookup at massive scale."

## CAP + consistency vocabulary

Under a partition you choose availability or consistency. Most web systems pick availability +
eventual consistency; money and inventory pick consistency. Mention read-your-writes or
monotonic reads if the UX needs it.

## Numbers worth knowing (order of magnitude)

- Memory read ~100 ns; SSD read ~100 us; datacenter round trip ~0.5 ms; cross-region ~50-150 ms.
- One server: ~10k-100k simple QPS. Postgres single node: ~5-10k writes/s comfortably.
- 1M users x 1KB/day = ~1GB/day = ~365GB/year. Say the math, not just the answer.
