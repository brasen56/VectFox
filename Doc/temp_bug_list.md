**This is a temporary bug list. Please do not reference it in code as it will be cleared upon completion**

[P2] Restart paging when mutations shift offsets; core/character-roster.js:70-75
 - Replaying mutations does not recover untouches events skipped by offset pagination. With 501 records, deleting a record from the first 500 before fetching offset 500 shifts the last record behind that offset. The build finishes read with 499 records although 500 survive. Restart the scan on mutations or use stable backend pagination

[P2] Avoid repeated full Qdrant scans; core/character-roster.js:61-62
 - Installed Similharity 3.3.4 scrolls the entire collection inside every chunks/list request, then slices offset/limit. This loop therefore repeats that scan for each 500-item page. A transport-stubbed reproduction with 5,000 records makes 500 Qdrant scroll requests instead of 50. Use a signle listing with the current API or introduce true server pagination

[P2] Preserve raw spellings for explicit splits; core/character-roster.js:135-138
 - Manual overrides are normalized before assignment, so distinct stored spellings that differ by an honorific or case share one key. The first override collects both spellings and the second is discarded. Consequently, Split selected into spellings cannot persist these splits. Explicit choices need identities that distinguish raw spellings

[P2] Keep hashes-only fallback builds retryable; core/character-roster.js:78-80
 - StandardBackend.listChunks falls back to nonempty hashes-only items during a temporay plugin outage. slimEvent skips every item, but the build still becomes ready. Subsequent warm-ups and Review / Refresh reuse the cached promise after connectivity recovers, leaving an empty register until invalidation or reload. Detect roster payloads and leave this build retryable.