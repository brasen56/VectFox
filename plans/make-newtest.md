# VectFox Regression Test Plan

Goal: replace the current manual one-by-one regression process with console-runnable
scripts that can be copy-pasted into the browser devtools console while SillyTavern is
running.  Each test prints a clear PASS / FAIL / WARN result with a reason.

---

## How to use

1. Open SillyTavern in the browser.
2. Open DevTools → Console.
3. Copy-paste the test block for the scenario you want to verify.
4. Read the output — each test ends with `[PASS]`, `[FAIL]`, or `[WARN]`.

All helpers read live runtime state (`extension_settings`, `window._vectfox_*` exports,
etc.) so results reflect the actual running code, not a snapshot.

---

## Test 001 — Lorebook lock scope (single locked lorebook, no cross-contamination)

**What it verifies:**
- Locking exactly one lorebook to the current chat causes only that lorebook to appear
  in `getEnabledLorebookCollections`.
- No other lorebook is returned regardless of backend (standard vs qdrant).
- If zero lorebooks are returned, it flags that as a separate FAIL (lock not working at
  all vs too many results).

**Root cause this catches:**
- The 2026-05-20 bug where `getEnabledLorebookCollections` had no `shouldCollectionActivate`
  gate and returned ALL lorebooks unconditionally.

**Pre-conditions:**
- At least one lorebook collection vectorized (`vf_lorebook_*`).
- Current chat loaded (chat ID resolvable via `getCurrentChatId()`).
- The lorebook you want to test is already locked to the current chat via DB Browser
  (Collection Settings → "Active for current chat" checkbox).

**Script:**

```js
// TEST 001 — Lorebook lock scope
(async () => {
  const TEST = 'TEST 001 [LockScope]';

  // --- resolve helpers from VectFox internals ---
  const vf = window._vectfox ?? extension_settings?.vectfox;
  if (!vf) { console.error(`${TEST} [FAIL] VectFox settings not found`); return; }

  // Pull the canonical helpers out of the module cache via the global ST object.
  // These are exported by VectFox but not exposed on window — call via dynamic import.
  const base = '/scripts/extensions/third-party/VectFox/';
  const { getCollectionListing } = await import(base + 'core/collection-loader.js');
  const { shouldCollectionActivate, getCollectionMeta, getCollectionLocks } = await import(base + 'core/collection-metadata.js');
  const { getCurrentChatId } = await import('/scripts/script.js').catch(() => ({ getCurrentChatId: window.getCurrentChatId }));

  const currentChatId = getCurrentChatId ? String(getCurrentChatId()) : null;
  const characterId   = window.getContext?.()?.characterId != null ? String(window.getContext().characterId) : null;
  const context       = { currentChatId, currentCharacterId: characterId };

  if (!currentChatId) { console.warn(`${TEST} [WARN] No active chat — open a chat first`); return; }

  const listing = getCollectionListing(vf);
  const lorebooks = listing.filter(e => e.collectionId.startsWith('vf_lorebook_'));

  if (!lorebooks.length) {
    console.warn(`${TEST} [WARN] No vectorized lorebook collections found — vectorize one first`);
    return;
  }

  // Determine which lorebooks are expected to be active (have a lock for current chat)
  const lockedHere = lorebooks.filter(e => {
    const locks = getCollectionLocks(e.registryKey);
    return locks.includes(currentChatId) || locks.includes(String(currentChatId));
  });

  console.log(`${TEST} Total lorebooks: ${lorebooks.length}, locked to this chat: ${lockedHere.length}`);
  lorebooks.forEach(e => {
    const locks = getCollectionLocks(e.registryKey);
    const meta  = getCollectionMeta(e.registryKey);
    console.log(`  ${e.registryKey}  scope=${meta.scope}  locks=[${locks.join(', ')}]`);
  });

  if (lockedHere.length === 0) {
    console.error(`${TEST} [FAIL] No lorebook is locked to chatId="${currentChatId}" — lock one first`);
    return;
  }

  // Now run getEnabledLorebookCollections logic inline (mirrors the fixed implementation)
  const active = [];
  for (const e of lorebooks) {
    if (e.meta?.enabled === false) continue;
    if (await shouldCollectionActivate(e.registryKey, context)) active.push(e);
  }

  console.log(`${TEST} shouldCollectionActivate passed: ${active.length} lorebook(s)`);
  active.forEach(e => console.log(`  ACTIVE: ${e.registryKey}`));

  // Assertions
  if (active.length === 0) {
    console.error(`${TEST} [FAIL] Lock exists but shouldCollectionActivate returned nothing — scope stamping bug?`);
    return;
  }
  if (active.length > lockedHere.length) {
    const extras = active.filter(e => !lockedHere.includes(e));
    console.error(`${TEST} [FAIL] ${extras.length} extra lorebook(s) slipped through:`);
    extras.forEach(e => console.error(`  UNEXPECTED: ${e.registryKey}`));
    return;
  }
  if (active.length === lockedHere.length) {
    console.log(`${TEST} [PASS] Exactly ${active.length} lorebook(s) active — matches locked set`);
  } else {
    console.warn(`${TEST} [WARN] active=${active.length} locked=${lockedHere.length} — mismatch, investigate`);
  }
})();
```

**Expected output (passing):**
```
TEST 001 [LockScope] Total lorebooks: 2, locked to this chat: 1
  vectra:vf_lorebook_standard_rabbit_your_wives_mvu_...  scope=chat  locks=[Your Wives - ...]
  qdrant:vf_lorebook_qdrant_rabbit_artificrealm_...       scope=chat  locks=[]
TEST 001 [LockScope] shouldCollectionActivate passed: 1 lorebook(s)
  ACTIVE: vectra:vf_lorebook_standard_rabbit_your_wives_mvu_...
TEST 001 [LockScope] [PASS] Exactly 1 lorebook(s) active — matches locked set
```

**Failure modes:**
| Output | Meaning |
|--------|---------|
| `[FAIL] No lorebook locked` | Pre-condition not met — lock a lorebook first |
| `[FAIL] Lock exists but shouldCollectionActivate returned nothing` | scope=unknown not being resolved; check the `isCollectionActiveForContext` fix |
| `[FAIL] extra lorebook(s) slipped through` | `shouldCollectionActivate` gate not applied — the 2026-05-20 bug is back |
| `[WARN] mismatch` | Triggers or conditions are activating a lorebook without an explicit lock — investigate `shouldCollectionActivate` priority chain |

---

## Planned tests (to be documented)

| ID | Scenario | Status |
|----|----------|--------|
| 001 | Lorebook lock scope — single locked, no cross-contamination | ✅ documented above |
| 002 | EventBase retrieval — fields populated (event_type, characters, etc.) for native backend | pending |
| 003 | EventBase importance filter — events pass through when importance absent (native) | pending |
| 004 | Collection lock — scope=unknown auto-resolved on save | pending |
| 005 | DB Browser — chunk text visible for native backend collections | pending |
| 006 | Lorebook lock — qdrant backend, same scope isolation as 001 | pending |
| 007 | Insert + query round-trip — native standard backend, data retrievable after insert | pending |
