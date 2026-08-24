# Big-O quick reference

## Common complexities, best to worst

| Complexity | Name | Feels like (n = 1M) | Typical source |
|---|---|---|---|
| O(1) | Constant | instant | hash lookup, array index, push/pop |
| O(log n) | Logarithmic | ~20 steps | binary search, balanced BST ops, heap push/pop |
| O(n) | Linear | 1M steps | single scan, two pointers, counting |
| O(n log n) | Linearithmic | ~20M steps | good sorts (merge, heap, Timsort), divide and conquer |
| O(n^2) | Quadratic | 10^12 steps, too slow | nested loops over the same input |
| O(2^n) | Exponential | hopeless past n=25 | brute-force subsets, naive recursion |
| O(n!) | Factorial | hopeless past n=12 | permutations |

Rule of thumb for interview inputs: n up to ~10^5-10^6 needs O(n log n) or better. n up to ~1000
tolerates O(n^2). n up to ~20 tolerates O(2^n).

## Data structure operations

| Structure | Access | Search | Insert | Delete | Notes |
|---|---|---|---|---|---|
| Array | O(1) | O(n) | O(n) | O(n) | append amortized O(1) |
| Hash map / set | - | O(1) avg | O(1) avg | O(1) avg | O(n) worst case; no ordering |
| Linked list | O(n) | O(n) | O(1) | O(1) | O(1) only with a handle to the node |
| Binary heap | O(1) top | O(n) | O(log n) | O(log n) top | priority queue |
| Balanced BST | O(log n) | O(log n) | O(log n) | O(log n) | sorted iteration |
| Trie | - | O(L) | O(L) | O(L) | L = key length; prefix queries |

## Sorting

| Algorithm | Average | Worst | Space | Stable |
|---|---|---|---|---|
| Merge sort | O(n log n) | O(n log n) | O(n) | yes |
| Quick sort | O(n log n) | O(n^2) | O(log n) | no |
| Heap sort | O(n log n) | O(n log n) | O(1) | no |
| Counting/bucket | O(n + k) | O(n + k) | O(k) | yes |

## Saying it well

- State time AND space, and say what n is ("n is the number of nodes").
- Amortized vs worst case: "append is amortized O(1)" shows precision.
- If asked to optimize, name the bottleneck first, then trade space for time (hash map, prefix
  sums, memoization) or exploit structure (sortedness, monotonicity, bounded alphabet).
