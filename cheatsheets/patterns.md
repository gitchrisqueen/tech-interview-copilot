# Algorithm patterns: recognize and apply

## Pattern triggers

| When you hear... | Reach for | Complexity |
|---|---|---|
| "contiguous subarray/substring", "longest/shortest window" | Sliding window | O(n) |
| "sorted array", "pair summing to", "remove duplicates in place" | Two pointers | O(n) |
| "top k", "kth largest", "merge k lists" | Heap | O(n log k) |
| "how many ways", "min cost to reach", "can you partition" | Dynamic programming | varies |
| "all combinations/permutations/subsets" | Backtracking | exponential, prune hard |
| "connected", "islands", "shortest path unweighted" | BFS/DFS | O(V + E) |
| "shortest path weighted" | Dijkstra (heap) | O(E log V) |
| "prerequisites", "build order", "cycle in a DAG" | Topological sort | O(V + E) |
| "next greater/smaller element", "histogram", "valid parentheses" | Stack (often monotonic) | O(n) |
| "search in sorted/rotated", "minimize the maximum" | Binary search (on answer too) | O(log n) passes |
| "prefix", "autocomplete", "word dictionary" | Trie | O(L) per op |
| "count/range sums" | Prefix sums | O(1) query after O(n) |
| "linked list cycle", "middle of list" | Fast and slow pointers | O(n), O(1) space |
| "intervals: merge/overlap/rooms" | Sort by start, then sweep | O(n log n) |
| "connectivity under unions", "accounts merge" | Union-Find | ~O(1) amortized per op |

## The interview loop (say it out loud)

1. **Clarify**: input size, value ranges, duplicates, sorted or not, expected output, edge cases.
2. **Brute force first**: state it and its complexity in one breath. It anchors correctness.
3. **Optimize**: name the wasted work, pick the pattern above that removes it.
4. **Walk the code** on a small example before declaring done.
5. **Complexity + edge cases**: empty input, single element, all equal, overflow, negative numbers.

## DP in 4 questions

1. State: what does dp[i] (or dp[i][j]) mean in plain words?
2. Transition: how does it build from smaller states?
3. Base case: what is trivially known?
4. Order/answer: iterate in dependency order; which cell is the answer?

Top-down memo is fine to start; convert to bottom-up if asked about stack depth or space.
